/**
 * 模型 / 接口集中配置
 *
 * 所有默认值 = 改造前硬编码的值，行为不变。
 * 想换模型或换服务商，只改 .env，不用动代码。
 *
 * .env 可配项：
 *   LLM_API_KEY       文本模型密钥（回退 DEEPSEEK_API_KEY）
 *   LLM_BASE_URL      文本模型接口（默认 https://api.deepseek.com）
 *   LLM_MODEL         文本模型名（默认 deepseek-flash = V4.1-Flash；deepseek-chat 已是别名）
 *   LLM_ENABLE_SEARCH 是否透传 enable_search（默认 true，DeepSeek 系联网搜索）
 *   LLM_THINKING      思考模式 enabled / disabled（默认 disabled，文案生成不需要，快 2 倍）
 *
 *   IMAGE_API_KEY     图片服务密钥（回退 OPENAI_API_KEY）
 *   IMAGE_BASE_URL    图片接口（默认 https://api.siliconflow.cn/v1）
 *   IMAGE_MODEL       图片模型（默认 Qwen/Qwen-Image）
 *   IMAGE_EDIT_MODEL  图生图/参考图编辑模型（默认 Qwen/Qwen-Image-Edit-2509，最多 3 张参考图）
 *                     链式出图靠它：第一张当锚点，其余图以锚点为 image 参考
 *   IMAGE_SIZE        出图尺寸（默认 1024x1024）
 *   IMAGE_SEND_RESPONSE_FORMAT 是否发送 response_format=b64_json（默认 true）
 *                     gpt-image-1 / 部分中转不接受该参数，设为 false
 *   IMAGE_DISABLE_WATERMARK  是否请求服务端不加「AI 生成」显式水印（默认 true）
 *                     硅基流动认 X-Enable-Watermark: 0 请求头，body 里的 watermark 字段无效
 *                     关闭后由使用者承担自行加注标识的法定义务
 */

export type LlmConfig = {
  apiKey: string | undefined
  baseURL: string
  model: string
  enableSearch: boolean
  thinkingEnabled: boolean
}

export type ImageConfig = {
  apiKey: string | undefined
  baseURL: string
  model: string
  /** 参考图编辑模型（链式出图用），与 model 同一接口 */
  editModel: string
  size: string
  sendResponseFormat: boolean
  disableWatermark: boolean
}

const DEFAULT_LLM_BASE_URL = "https://api.deepseek.com"
const DEFAULT_LLM_MODEL = "deepseek-flash"
const DEFAULT_IMAGE_BASE_URL = "https://api.siliconflow.cn/v1"
const DEFAULT_IMAGE_MODEL = "Qwen/Qwen-Image"
const DEFAULT_IMAGE_EDIT_MODEL = "Qwen/Qwen-Image-Edit-2509"
const DEFAULT_IMAGE_SIZE = "1024x1024"

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() !== "" ? v.trim() : undefined
}

/** 文本模型配置。overrideKey 用于「用户自带 key 优先」的调用方。 */
export function llmConfig(overrideKey?: string | null): LlmConfig {
  return {
    apiKey: overrideKey || env("LLM_API_KEY") || env("DEEPSEEK_API_KEY"),
    baseURL: env("LLM_BASE_URL") || DEFAULT_LLM_BASE_URL,
    model: env("LLM_MODEL") || DEFAULT_LLM_MODEL,
    enableSearch: (env("LLM_ENABLE_SEARCH") ?? "true").toLowerCase() !== "false",
    thinkingEnabled: (env("LLM_THINKING") ?? "disabled").toLowerCase() === "enabled",
  }
}

/** 需要并入 chat.completions body 的额外字段（Node SDK 无 extra_body，直接放顶层） */
export function llmExtraBody(cfg: LlmConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (!cfg.thinkingEnabled) body.thinking = { type: "disabled" }
  if (cfg.enableSearch && supportsSearch(cfg.baseURL)) body.enable_search = true
  return body
}

/** 是否支持 enable_search 透传（仅 DeepSeek 系接口认这个字段） */
export function supportsSearch(baseURL: string): boolean {
  return baseURL.includes("deepseek")
}

/** 图片服务配置。overrideKey 用于用户自带的图片 key。 */
export function imageConfig(overrideKey?: string | null): ImageConfig {
  return {
    apiKey: overrideKey || env("IMAGE_API_KEY") || env("OPENAI_API_KEY"),
    baseURL: env("IMAGE_BASE_URL") || DEFAULT_IMAGE_BASE_URL,
    model: env("IMAGE_MODEL") || DEFAULT_IMAGE_MODEL,
    editModel: env("IMAGE_EDIT_MODEL") || DEFAULT_IMAGE_EDIT_MODEL,
    size: env("IMAGE_SIZE") || DEFAULT_IMAGE_SIZE,
    sendResponseFormat: (env("IMAGE_SEND_RESPONSE_FORMAT") ?? "true").toLowerCase() !== "false",
    disableWatermark: (env("IMAGE_DISABLE_WATERMARK") ?? "true").toLowerCase() !== "false",
  }
}

/**
 * 图片请求需要带的 HTTP 头。
 *
 * 硅基流动从 2026-09-30 起默认给 API 出图加「AI 生成」显式水印，
 * 只有 X-Enable-Watermark: 0 这个请求头能关掉（body 里的 watermark 字段无效）。
 * 关掉之后，使用者有义务自行在最终输出上标注 AI 生成。
 */
export function imageRequestHeaders(cfg: ImageConfig): Record<string, string> {
  return cfg.disableWatermark ? { "X-Enable-Watermark": "0" } : {}
}

/**
 * 建文本模型客户端。没 key 时返回 null，调用方按原有逻辑走降级。
 */
export async function createLlmClient(overrideKey?: string | null) {
  const cfg = llmConfig(overrideKey)
  if (!cfg.apiKey) return null
  const { default: OpenAI } = await import("openai")
  return {
    client: new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL }),
    cfg,
  }
}

/**
 * 建图片模型客户端。没 key 时返回 null。
 */
export async function createImageClient(overrideKey?: string | null) {
  const cfg = imageConfig(overrideKey)
  if (!cfg.apiKey) return null
  const { default: OpenAI } = await import("openai")
  return {
    client: new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL }),
    cfg,
  }
}
