/**
 * 批量图片 prompt 规划（一致性核心）
 *
 * 问题：改造前 5 个图片类型 = 5 次独立请求 → 5 次独立 buildPrompt。
 * 每次模型都从零开始"发明"产品外观，于是同一款榨汁杯被画成高杯 / 矮杯 / 马克杯 / 破壁机。
 *
 * 摄图 AI 的做法（逆向自 agent.699pic.com）：一次调用产出全部图的 prompt，
 * 装进同一个 JSON 返回。实测 5 张产品完全一致。
 *
 * 本文件实现两件事：
 * 1. 一次调用只产出「怎么拍」——机位、构图、背景、光、氛围，禁止描述外观。
 * 2. 外观由 visualLockText() 确定性拼在每条 prompt 前面，逐字节相同。
 *    即使模型想改外观，也没有位置可改。
 */

const VISUAL_TYPES = [
  "mainImage",
  "sceneImage",
  "banner",
  "socialMediaImage",
  "promoPoster",
] as const

export type VisualType = (typeof VISUAL_TYPES)[number]

export function isVisualType(t: string): t is VisualType {
  return (VISUAL_TYPES as readonly string[]).includes(t)
}

/** 每种图在拍摄方案里的角色，给模型一个明确的区分依据 */
const SHOT_BRIEF: Record<VisualType, string> = {
  mainImage: "clean hero shot for a product listing thumbnail, product is the only subject",
  sceneImage:
    "lifestyle shot showing the product in real use, human context allowed but hands optional",
  banner: "wide horizontal banner layout with generous empty space for headline copy on one side",
  socialMediaImage: "square social feed post, casual and scroll-stopping, real-life vibe",
  promoPoster: "vertical promotional poster, strong visual impact, room for a discount callout",
}

export type ShotPlanInput = {
  productName: string
  category?: string | null
  useScenario?: string | null
  targetAudience?: string | null
  brandTone?: string | null
  visualStyle?: string | null
  festivalScenario?: string | null
  isPromotional?: boolean
  platform?: string | null
}

/**
 * 规划用的 system prompt。
 * 关键约束：不许描述产品外观（颜色/材质/形状/部件），只写拍法。
 * 这不是为了省字，是为了让外观只能来自 visualLockText——单点事实，不会分叉。
 */
export function buildShotPlanSystem(visualLock: string): string {
  return `You are an e-commerce art director planning ONE photo shoot for ONE single physical product.

The product's appearance is FIXED and already written down. You do NOT describe it.
A base photograph of this product already exists. Each shot you write will be produced by
changing the scene and the camera of that base photograph — the product itself never changes.
Your job is only to decide HOW each shot is photographed.

PRODUCT APPEARANCE (for your reference only — never repeat or alter any of it):
${visualLock}

Return ONE JSON object, nothing else:
{"shots":[{"type":"","prompt":""}]}

Rules:
- Emit exactly one shot per requested type, in the requested order, and copy the type string exactly.
- "prompt" is 45-70 words of English describing ONLY: camera angle and height, framing and crop, background, surfaces, props, lighting quality and direction, time of day, mood.
- NEVER write the product's color, material, shape, proportions, parts, brand or logo. Never write the product name.
- Never write phrases like "same product", "consistent", "identical", "as described above".
- Every shot must look like a different frame from the same shoot: consistent light direction and color temperature across shots, different framing.
- No markdown fences, no comments, no extra keys.`
}

export function buildShotPlanUser(input: ShotPlanInput, types: string[]): string {
  const lines = [
    `Product context (use for scene/mood only):`,
    `- name: ${input.productName}`,
    `- category: ${input.category || "-"}`,
    `- use scenario: ${input.useScenario || "-"}`,
    `- target audience: ${input.targetAudience || "-"}`,
    `- brand tone: ${input.brandTone || "-"}`,
    `- visual style: ${input.visualStyle || "minimal"}`,
    `- festival: ${input.festivalScenario || "-"}`,
    `- promotional: ${input.isPromotional ? "yes" : "no"}`,
    `- platform: ${input.platform || "-"}`,
    ``,
    `Requested shot types, in this exact order:`,
    ...types.map((t, i) => `${i + 1}. ${t} — ${SHOT_BRIEF[t as VisualType] || "product shot"}`),
  ]
  return lines.join("\n")
}

/** 剥掉 ```json 围栏，再截取第一个 { 到最后一个 } */
function extractJson(text: string): string {
  let t = text.trim()
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()
  const start = t.indexOf("{")
  const end = t.lastIndexOf("}")
  if (start >= 0 && end > start) return t.slice(start, end + 1)
  return t
}

/**
 * 解析模型返回，按请求的 types 顺序取 prompt。
 * 缺项返回空串，由调用方决定是重试还是降级，绝不静默塞默认 prompt。
 */
export function parseShotPlan(text: string, types: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  let shots: unknown[] = []
  try {
    const obj = JSON.parse(extractJson(text)) as Record<string, unknown>
    if (Array.isArray(obj.shots)) shots = obj.shots
  } catch {
    return out
  }

  const byType = new Map<string, string>()
  for (const s of shots) {
    if (!s || typeof s !== "object") continue
    const o = s as Record<string, unknown>
    const type = typeof o.type === "string" ? o.type.trim() : ""
    const prompt = typeof o.prompt === "string" ? o.prompt.trim() : ""
    if (type && prompt) byType.set(type, prompt)
  }

  for (const t of types) {
    const p = byType.get(t)
    if (p) out[t] = p
  }
  return out
}

/**
 * 最终送给图片模型的 prompt。
 * 外观段在前（逐字节相同），拍法在后。
 * 注意：这是"没有参考图"时的兜底写法，文字约束不了空间结构，只能算弱约束。
 */
export function composeImagePrompt(visualLock: string, shotPrompt: string): string {
  return `${visualLock}\n\nSHOT DIRECTION:\n${shotPrompt}`
}

/**
 * 锚点图 prompt —— 决定"这个产品长什么样"的那一张。
 *
 * 三个刻意的选择：
 * 1. 正面 3/4 视角：一次性交代正面、侧面和厚度，比纯正面提供更多形信息
 * 2. 完整入画不裁切：后面所有图都从它派生，少一块就等于少一块
 * 3. 纯净背景 + 无道具：参考图越干净，Edit 时越不容易把背景元素带进新场景
 */
export function buildAnchorPrompt(visualLock: string): string {
  return `${visualLock}

SHOT DIRECTION:
front three-quarter view of this single product standing upright on a plain light grey seamless backdrop,
the entire product visible from top to bottom with nothing cropped,
centred with even margin, soft diffused studio lighting from the upper left,
one soft contact shadow under the base, realistic matte materials, sharp focus across the whole product,
no props, no hands, no text, no logo, no reflection of the studio.`
}

/**
 * 用户上传参考图 → 干净锚点图的 prompt。
 *
 * 用户实拍图通常有背景、有杂物、构图随意。先用一次编辑把它"净化"成白底正面图：
 * 既得到一张像样的电商主图，也让后续派生有一个干净起点。
 * 同样不描述产品长什么样——外观必须 100% 来自参考图。
 */
export function buildCleanAnchorPrompt(): string {
  return `Cut the product out of the reference image and place it on a pure white seamless background.

Keep the product itself identical to the reference image: same color, same material, same shape and proportions, the same parts in the same positions, the same markings and details.
Do not redesign, restyle, recolor, sharpen or embellish anything. Do not add or remove any part.

The product must be whole and uncropped, standing upright, centred in frame with even margin around it.
Straight-on front view with a slight three-quarter turn so the side profile is visible.
Even soft studio lighting from the front left, no harsh shadows, one soft contact shadow under the base.
Full product in sharp focus, no props, no hands, no background objects, no text, no watermark, no border.`
}

/**
 * 参考图改拍法 prompt —— 除锚点外每一张都走这条。
 *
 * 关键：**不重复描述外观**。
 * 一旦在 Edit 的 prompt 里再写一遍"奶油白 / 圆柱形 / 六叶刀头"，
 * 模型会把这些词当成"要重画一遍"的指令，反而破坏参考图里的细节。
 * 这里只做两件事：声明什么不许动，声明只改什么。
 */
export function buildEditPrompt(shotPrompt: string): string {
  return `Keep the product in the reference image exactly as it is: same color, same material, same shape and proportions, the same parts in the same positions, same size in frame.
Do not redraw, restyle, recolor, resize, add or remove any part of the product.

Change only the scene and the camera:
${shotPrompt}

Keep the same lighting direction and color temperature as the reference image. Realistic commercial product photography.`
}
