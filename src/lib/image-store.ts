/**
 * 图片的本地存储
 *
 * 为什么需要它：把 base64 直接写进数据库（原来的做法）会让每条记录膨胀到 1~2MB，
 * 列表页、导出、备份全部被拖死。这里改成落盘，库里只存 URL。
 *
 * 两个目录：
 *   public/generated  模型产出的图（/generated/xxx.png）
 *   public/uploads    用户上传的产品参考图（/uploads/xxx.png）
 */

import { mkdir, writeFile, readFile } from "fs/promises"
import path from "path"
import crypto from "crypto"

const PUBLIC_DIR = path.join(process.cwd(), "public", "generated")
const URL_PREFIX = "/generated"

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads")
const UPLOAD_PREFIX = "/uploads"

/** 允许的图片扩展名 —— 同时作为上传白名单 */
export const ALLOWED_IMAGE_EXTS = ["png", "jpg", "jpeg", "webp"] as const

export function isAllowedImageExt(ext: string): boolean {
  return (ALLOWED_IMAGE_EXTS as readonly string[]).includes(ext.toLowerCase())
}

function filenameFor(ext: string): string {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)
  const rand = crypto.randomBytes(4).toString("hex")
  return `${stamp}-${rand}.${ext}`
}

function extFromContentType(ct: string | null): string {
  if (!ct) return "png"
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg"
  if (ct.includes("webp")) return "webp"
  if (ct.includes("gif")) return "gif"
  return "png"
}

/** base64 → 本地文件，返回可访问路径 */
export async function saveBase64Image(base64: string, ext = "png"): Promise<string> {
  await mkdir(PUBLIC_DIR, { recursive: true })
  const name = filenameFor(ext)
  await writeFile(path.join(PUBLIC_DIR, name), Buffer.from(base64, "base64"))
  return `${URL_PREFIX}/${name}`
}

/** 远程 URL → 下载后存本地，返回可访问路径（避免第三方链接过期） */
export async function saveRemoteImage(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`下载生成图片失败 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength === 0) throw new Error("下载到的图片为空")

  await mkdir(PUBLIC_DIR, { recursive: true })
  const name = filenameFor(extFromContentType(res.headers.get("content-type")))
  await writeFile(path.join(PUBLIC_DIR, name), buf)
  return `${URL_PREFIX}/${name}`
}

/**
 * 用户上传的产品参考图 → 落盘 public/uploads/。
 * 文件名全部重写，不保留用户原始文件名（避免路径穿越和中文编码问题）。
 */
export async function saveUploadedImage(buf: Buffer, ext: string): Promise<string> {
  const safeExt = isAllowedImageExt(ext) ? ext.toLowerCase() : "png"
  await mkdir(UPLOAD_DIR, { recursive: true })
  const name = filenameFor(safeExt)
  await writeFile(path.join(UPLOAD_DIR, name), buf)
  return `${UPLOAD_PREFIX}/${name}`
}

/**
 * 把本地图片路径解析成磁盘绝对路径。
 * 只认 /generated/ 和 /uploads/ 两个前缀，且只取 basename——杜绝 ../ 穿越。
 */
function absPathFor(publicPath: string): string {
  const name = path.basename(publicPath)
  if (publicPath.startsWith(UPLOAD_PREFIX)) return path.join(UPLOAD_DIR, name)
  if (publicPath.startsWith(URL_PREFIX)) return path.join(PUBLIC_DIR, name)
  throw new Error(`不支持的图片路径: ${publicPath}`)
}

/** 校验一个前端传来的路径是否是我们自己的图片 */
export function isLocalImagePath(p: unknown): p is string {
  if (typeof p !== "string") return false
  if (!p.startsWith(`${URL_PREFIX}/`) && !p.startsWith(`${UPLOAD_PREFIX}/`)) return false
  if (p.includes("..")) return false
  return isAllowedImageExt(path.extname(p).slice(1))
}

/**
 * 把已落盘的图片读成 Data URI（data:image/png;base64,...）。
 *
 * 用途：图生图时把本地锚点图 / 用户参考图喂给参考图模型。
 * 两个必须踩准的点：
 * 1. 不能传本机相对路径 —— 服务商访问不到；
 * 2. 也不能传裸 base64 —— 硅基流动会把它当成文件路径，报
 *    "The input string is too long to be a valid file path ... Data URI scheme (RFC 2397)"。
 */
export async function readImageDataUri(publicPath: string): Promise<string> {
  const abs = absPathFor(publicPath)
  const buf = await readFile(abs)
  const ext = path.extname(abs).slice(1).toLowerCase()
  const mime =
    ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png"
  return `data:${mime};base64,${buf.toString("base64")}`
}
