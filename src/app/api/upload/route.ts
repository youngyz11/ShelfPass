import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { rateLimit } from "@/lib/rate-limit"
import { saveUploadedImage, isAllowedImageExt } from "@/lib/image-store"

/**
 * 产品参考图上传
 *
 * 用户自己有实拍图时，比任何文字描述都准——整组图以它为锚点派生。
 * 这里只做"收下并存好"，不做任何图像处理（不裁切、不去背景）。
 *
 * 请求：multipart/form-data，字段名 file（单个）或 files（多个）
 * 响应：{ files: [{ url, name }] }
 */

const MAX_BYTES = 10 * 1024 * 1024 // 单张 10MB
const MAX_FILES = 3 // Qwen-Image-Edit-2509 最多 3 张参考图

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 })
  }

  const { success, retryAfterMs } = rateLimit(`upload:${session.user.id}`, 20, 60_000)
  if (!success) {
    return NextResponse.json(
      { error: `上传过于频繁，请 ${Math.ceil(retryAfterMs / 1000)} 秒后再试` },
      { status: 429 }
    )
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: "请求格式错误，需要 multipart/form-data" }, { status: 400 })
  }

  const collected: File[] = []
  for (const key of ["file", "files"]) {
    for (const v of form.getAll(key)) {
      if (v instanceof File) collected.push(v)
    }
  }

  if (collected.length === 0) {
    return NextResponse.json({ error: "没有收到文件" }, { status: 400 })
  }
  if (collected.length > MAX_FILES) {
    return NextResponse.json({ error: `最多上传 ${MAX_FILES} 张参考图` }, { status: 400 })
  }

  const saved: { url: string; name: string }[] = []
  for (const file of collected) {
    const ext = (file.name.split(".").pop() || "").toLowerCase()
    if (!isAllowedImageExt(ext)) {
      return NextResponse.json(
        { error: `不支持的文件类型：${file.name}（只收 png / jpg / webp）` },
        { status: 400 }
      )
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `${file.name} 超过 10MB` },
        { status: 400 }
      )
    }
    const buf = Buffer.from(await file.arrayBuffer())
    if (buf.byteLength === 0) {
      return NextResponse.json({ error: `${file.name} 是空文件` }, { status: 400 })
    }
    // 简单魔数校验，防止把非图片改成 .png 混进来
    if (!looksLikeImage(buf)) {
      return NextResponse.json({ error: `${file.name} 不是有效的图片` }, { status: 400 })
    }
    const url = await saveUploadedImage(buf, ext)
    saved.push({ url, name: file.name })
  }

  return NextResponse.json({ files: saved })
}

/** PNG / JPEG / WEBP 的文件头 */
function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 12) return false
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
  // WEBP: RIFF....WEBP
  if (
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return true
  return false
}
