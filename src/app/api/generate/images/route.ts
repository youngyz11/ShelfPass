import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/db/prisma"
import { rateLimit } from "@/lib/rate-limit"
import { checkMonthlyQuota } from "@/lib/quota"
import { createLlmClient, createImageClient, imageRequestHeaders } from "@/lib/ai-config"
import { ensureVisualSpec, visualLockText } from "@/lib/visual-spec"
import { saveBase64Image, saveRemoteImage, readImageDataUri, isLocalImagePath } from "@/lib/image-store"
import {
  buildShotPlanSystem,
  buildShotPlanUser,
  parseShotPlan,
  composeImagePrompt,
  buildAnchorPrompt,
  buildCleanAnchorPrompt,
  buildEditPrompt,
  isVisualType,
} from "@/lib/visual-batch"

/**
 * 批量图片生成 —— 锚点图 + 参考图派生（链式）
 *
 * 为什么不是"一次 LLM 出全部 prompt"：
 *   Qwen-Image 是纯文生图，两次调用之间零信息传递，文字只约束"词"不约束"词的空间关系"。
 *   实测同一份 1358 字符的外观段，能画出杯子、马克杯、破壁机三种结构。
 *
 * 现在的做法（与 ComfyUI 电商链路 / 摄图 referenceAssets 同一思路）：
 *   ① 拿锚点图：用户上传了参考图就用它（先净化成白底正面），否则文生图从零画一张
 *   ② 其余每张用 Qwen-Image-Edit-2509，以锚点图为 image 参考，只改场景和机位
 *   ③ 若请求里包含 mainImage，锚点图直接当主图交付，不重复出图（成本不增加）
 *
 * 请求：{ projectId, contentTypes: string[], referenceImages?: string[] }
 *   referenceImages 为 /uploads/xxx.png 或 /generated/xxx.png 的本地路径，最多 3 张。
 *   不传则回落到项目里已存的参考图。
 * 响应：{ records: (GenerationRecord & { imageError })[], visualSpec, anchorUrl, mode }
 */

const LABELS: Record<string, string> = {
  mainImage: "商品主图",
  sceneImage: "场景图",
  banner: "Banner图",
  socialMediaImage: "社媒图",
  promoPoster: "促销海报",
}

/** 同时最多几张图在跑，硅基流动对并发敏感，2 是稳的 */
const IMAGE_CONCURRENCY = parseInt(process.env.IMAGE_CONCURRENCY || "2", 10)
/** 单次最多出几张，防止误点全选出 5 张烧额度 */
const BATCH_MAX = parseInt(process.env.IMAGE_BATCH_MAX || "5", 10)

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

type GenOutcome = {
  /** 本地可访问路径，落库用 */
  url: string | null
  /** 服务商返回的原始 URL，可作为下一次请求的 image 参考（可能过期，仅即时使用） */
  rawUrl: string | null
  error: string | null
}

/** 文生图（锚点图 / 降级路径用） */
async function generateT2I(img: { client: any; cfg: any }, prompt: string): Promise<GenOutcome> {
  try {
    const res = await (img.client.images.generate as any)(
      {
        model: img.cfg.model,
        prompt,
        n: 1,
        size: img.cfg.size,
        ...(img.cfg.sendResponseFormat ? { response_format: "b64_json" } : {}),
      },
      { headers: imageRequestHeaders(img.cfg) }
    )
    const first = res?.data?.[0]
    if (first?.b64_json)
      return { url: await saveBase64Image(first.b64_json), rawUrl: null, error: null }
    if (first?.url) return { url: await saveRemoteImage(first.url), rawUrl: first.url, error: null }
    return { url: null, rawUrl: null, error: "图片服务未返回图片数据" }
  } catch (e) {
    console.error("[Images] 文生图失败:", e)
    return {
      url: null,
      rawUrl: null,
      error: e instanceof Error ? e.message.slice(0, 200) : "图片生成失败",
    }
  }
}

/**
 * 参考图编辑：以 imageRef 为参考，只改场景与机位。
 * 不传 size —— 编辑接口的尺寸由参考图决定，多传会报错。
 * extra 用于补充参考图（image2 / image3），Qwen-Image-Edit-2509 最多 3 张。
 */
async function generateEdit(
  img: { client: any; cfg: any },
  prompt: string,
  imageRef: string,
  extra: string[] = []
): Promise<GenOutcome> {
  try {
    const payload: Record<string, unknown> = {
      model: img.cfg.editModel,
      prompt,
      image: imageRef,
    }
    if (extra[0]) payload.image2 = extra[0]
    if (extra[1]) payload.image3 = extra[1]

    const res = await (img.client.images.generate as any)(payload, {
      headers: imageRequestHeaders(img.cfg),
    })
    const first = res?.data?.[0]
    if (first?.b64_json)
      return { url: await saveBase64Image(first.b64_json), rawUrl: null, error: null }
    if (first?.url) return { url: await saveRemoteImage(first.url), rawUrl: first.url, error: null }
    return { url: null, rawUrl: null, error: "编辑接口未返回图片数据" }
  } catch (e) {
    console.error("[Images] 参考图编辑失败:", e)
    return {
      url: null,
      rawUrl: null,
      error: e instanceof Error ? e.message.slice(0, 200) : "参考图编辑失败",
    }
  }
}

/** 读取库里存的参考图列表（JSON 数组字符串） */
function parseStoredRefs(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter(isLocalImagePath).slice(0, 3) : []
  } catch {
    return []
  }
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 })
  }

  const { success, retryAfterMs } = rateLimit(`generate-images:${session.user.id}`, 10, 60_000)
  if (!success) {
    return NextResponse.json(
      { error: `请求过于频繁，请 ${Math.ceil(retryAfterMs / 1000)} 秒后再试` },
      { status: 429 }
    )
  }

  const quota = await checkMonthlyQuota(session.user.id)
  if (!quota.allowed) {
    return NextResponse.json(
      {
        error: `本月免费额度已用完（${quota.used}/${quota.limit}次），请下月再试或升级套餐`,
        kind: "QUOTA_EXCEEDED",
      },
      { status: 403 }
    )
  }

  try {
    const body = await req.json()
    const projectId: string = body?.projectId
    let types: string[] = Array.isArray(body?.contentTypes) ? body.contentTypes : []

    if (!projectId || types.length === 0) {
      return NextResponse.json({ error: "参数不完整" }, { status: 400 })
    }

    types = Array.from(new Set(types.filter((t: string) => isVisualType(t)))).slice(0, BATCH_MAX)
    if (types.length === 0) {
      return NextResponse.json({ error: "没有可生成的图片类型" }, { status: 400 })
    }

    const project = await prisma.productProject.findUnique({ where: { id: projectId } })
    if (!project || project.userId !== session.user.id) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 })
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { apiKey: true, imageApiKey: true },
    })

    const img = await createImageClient(user?.imageApiKey)
    if (!img) {
      return NextResponse.json({ error: "未配置图片服务密钥" }, { status: 400 })
    }

    const llm = await createLlmClient(user?.apiKey)

    // ① 参考图：请求里带的 > 项目里存过的 > 没有
    const reqRefs = (Array.isArray(body?.referenceImages) ? body.referenceImages : [])
      .filter(isLocalImagePath)
      .slice(0, 3)
    const storedRefs = parseStoredRefs(project.referenceImages)
    const refs = reqRefs.length > 0 ? reqRefs : storedRefs

    // 首次上传的参考图落库 —— 下次进这个项目还能复用同一张锚点
    if (reqRefs.length > 0 && JSON.stringify(reqRefs) !== project.referenceImages) {
      await prisma.productProject.update({
        where: { id: projectId },
        data: { referenceImages: JSON.stringify(reqRefs) },
      })
    }

    // ② 外观事实：有参考图时外观以像素为准，文字只用来给拍法规划定调
    const spec = await ensureVisualSpec(project, llm, (id, json) =>
      prisma.productProject.update({ where: { id }, data: { visualSpec: json } })
    )
    const visualLock = refs.length
      ? "The product's appearance is defined by the reference photograph. Never describe or alter it."
      : spec
        ? visualLockText(spec)
        : "product appearance: as described in the title"

    // ③ 锚点图：有用户图就从用户图来，没有才从零画
    let anchor: GenOutcome
    let anchorMode: string
    if (refs.length > 0) {
      try {
        // 第一张为主参考，其余作 image2 / image3 补充视角
        const primary = await readImageDataUri(refs[0])
        const extra: string[] = []
        for (const p of refs.slice(1)) extra.push(await readImageDataUri(p))
        anchor = await generateEdit(img, buildCleanAnchorPrompt(), primary, extra)
      } catch (e) {
        console.error("[Images] 读取用户参考图失败:", e)
        anchor = { url: null, rawUrl: null, error: "参考图读取失败" }
      }
      if (anchor.url) {
        anchorMode = "reference-clean"
      } else {
        // 净化失败 → 直接用原图当锚点，不额外花钱，保证链路不断
        anchor = { url: refs[0], rawUrl: null, error: null }
        anchorMode = "reference-raw"
      }
    } else {
      anchor = await generateT2I(img, buildAnchorPrompt(visualLock))
      anchorMode = "anchor-chain"
    }
    const anchorPromptText = refs.length ? buildCleanAnchorPrompt() : buildAnchorPrompt(visualLock)

    // 锚点挂了就退回旧路（全部文生图），至少保证有图可交付
    if (!anchor.url) {
      const outcomes = await mapLimit(types, IMAGE_CONCURRENCY, (t) =>
        generateT2I(
          img,
          composeImagePrompt(
            visualLock,
            `${LABELS[t] || t} product photograph, clean composition, soft diffused studio light, realistic materials`
          )
        )
      )
      const records = []
      for (let i = 0; i < types.length; i++) {
        const t = types[i]
        const record = await prisma.generationRecord.create({
          data: {
            projectId,
            contentType: t,
            content: composeImagePrompt(visualLock, LABELS[t] || t),
            imageUrl: outcomes[i].url,
            prompt: `为"${project.productName}"生成${LABELS[t] || t}`,
          },
        })
        records.push({ ...record, imageError: outcomes[i].error })
      }
      return NextResponse.json({
        records,
        visualSpec: spec,
        anchorUrl: null,
        anchorReusedAsMain: false,
        mode: "fallback-t2i",
        failed: outcomes.filter((r) => !r.url).length,
      })
    }

    // ③ 参考图：优先用服务商返回的原始 URL（请求体小），取不到再读本地转 base64
    let imageRef: string
    if (anchor.rawUrl) {
      imageRef = anchor.rawUrl
    } else {
      try {
        imageRef = await readImageDataUri(anchor.url)
      } catch (e) {
        console.error("[Images] 读取锚点图失败:", e)
        return NextResponse.json({ error: "锚点图读取失败" }, { status: 500 })
      }
    }

    // ④ 主图直接复用锚点图 —— 这是"成本不增加"的关键
    const usesAnchorAsMain = types.includes("mainImage")
    const editTypes = types.filter((t) => t !== "mainImage")

    // ⑤ 拍法规划：一次调用产出所有待编辑图的场景/机位
    const shotPrompts: Record<string, string> = {}
    if (editTypes.length > 0 && llm) {
      try {
        const res = await (llm.client.chat.completions.create as any)({
          model: llm.cfg.model,
          messages: [
            { role: "system", content: buildShotPlanSystem(visualLock) },
            { role: "user", content: buildShotPlanUser(project, editTypes) },
          ],
          temperature: 0.6,
          max_tokens: 1200,
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
        })
        Object.assign(shotPrompts, parseShotPlan(res.choices?.[0]?.message?.content || "", editTypes))
      } catch (e) {
        console.error("[Images] 拍法规划失败，降级为类型默认描述:", e)
      }
    }

    // ⑥ 全部从锚点派生，并发出图
    const editTasks = editTypes.map((t) => ({
      type: t,
      shot:
        shotPrompts[t] ||
        `a ${LABELS[t] || t} style commercial shot of this product, different background and camera angle, realistic photography`,
    }))
    const outcomes = await mapLimit(editTasks, IMAGE_CONCURRENCY, (task) =>
      generateEdit(img, buildEditPrompt(task.shot), imageRef)
    )

    // ⑦ 按请求顺序落库：主图用锚点，其余用编辑结果
    const byType = new Map<string, GenOutcome>()
    if (usesAnchorAsMain) byType.set("mainImage", anchor)
    editTasks.forEach((task, i) => byType.set(task.type, outcomes[i]))

    const records = []
    for (const t of types) {
      const r = byType.get(t) ?? { url: null, rawUrl: null, error: "未生成" }
      const content = usesAnchorAsMain && t === "mainImage"
        ? anchorPromptText
        : buildEditPrompt(editTasks.find((e) => e.type === t)?.shot || "")
      const record = await prisma.generationRecord.create({
        data: {
          projectId,
          contentType: t,
          content,
          imageUrl: r.url,
          prompt: `为"${project.productName}"生成${LABELS[t] || t}`,
        },
      })
      records.push({ ...record, imageError: r.error })
    }

    return NextResponse.json({
      records,
      visualSpec: spec,
      anchorUrl: anchor.url,
      anchorReusedAsMain: usesAnchorAsMain,
      anchorMode,
      referenceCount: refs.length,
      mode: anchorMode,
      failed: records.filter((r) => !r.imageUrl).length,
    })
  } catch (err) {
    console.error("[Images]", err)
    return NextResponse.json({ error: "生成失败" }, { status: 500 })
  }
}
