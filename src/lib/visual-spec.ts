/**
 * 视觉事实锚（Visual Spec）
 *
 * 问题来源：5 个图片类型各自独立调用模型，prompt 里只说"描述构图、光线、风格"，
 * 从不描述"这个产品长什么样"。于是模型每次都要自己发明产品外观——
 * 实测同一款便携榨汁杯被画成：带提手的高杯、带手柄的矮杯、白马克杯、台式破壁机。
 *
 * 解法：在第一次生成图片前，把产品外观确定成一份结构化事实，存进项目；
 * 之后每一个图片 prompt 都把这套事实作为硬约束显式带上。
 * 颜色/形态一旦定下就不再变化，模型只能换构图和光线。
 */

export type VisualSpec = {
  /** 产品品类，如 portable blender cup */
  productType: string
  /** 主色，如 matte cream white。不一致的头号元凶 */
  color: string
  /** 材质，如 Tritan body with 316 stainless steel blades */
  material: string
  /** 整体形态与比例，如 tall cylindrical cup, base is 1/3 of total height */
  formFactor: string
  /** 必须出现的部件，如 ["clear blending base", "carry handle loop"] */
  components: string[]
  /** 表面处理，如 matte powder-coated, no visible logo */
  finish: string
}

const EMPTY_SPEC: VisualSpec = {
  productType: "",
  color: "",
  material: "",
  formFactor: "",
  components: [],
  finish: "",
}

/** 从自由文本里找颜色词，作为 LLM 不可用时的确定性兜底 */
const COLOR_WORDS = [
  "奶油白", "米白", "象牙白", "纯白", "白色", "黑色", "哑光黑", "灰色", "银色",
  "不锈钢原色", "鼠尾草绿", "墨绿", "橄榄绿", "天蓝", "海军蓝", "粉色", "珊瑚粉",
  "米色", "卡其", "棕色", "咖啡色", "橙色", "黄色", "红色", "紫色",
  "cream white", "matte white", "ivory", "black", "matte black", "grey", "gray",
  "silver", "sage green", "navy", "pink", "beige", "brown", "orange", "red", "purple",
]

function guessColor(text: string): string {
  const lower = text.toLowerCase()
  for (const w of COLOR_WORDS) {
    if (lower.includes(w.toLowerCase())) return w
  }
  return ""
}

/**
 * 把 LLM 吐出来的 JSON 收敛成合法 spec。
 * 任何缺失字段都补一个保守值，宁可简陋也不能留空让模型自由发挥。
 */
function normalize(raw: unknown, fallbackColor: string, productName: string): VisualSpec {
  const o = (raw ?? {}) as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "")
  const arr = (k: string) =>
    Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x): x is string => typeof x === "string") : []

  const spec: VisualSpec = {
    productType: str("productType") || productName,
    color: str("color") || fallbackColor || "natural product color",
    material: str("material") || "as described in the product details",
    formFactor: str("formFactor") || "",
    components: arr("components"),
    finish: str("finish") || "",
  }
  return spec
}

const EXTRACT_SYSTEM = `You are a product visual spec extractor for e-commerce photography.
Read the product information and output ONE JSON object describing how this exact product LOOKS.
Rules:
- Only describe physical appearance: shape, proportions, color, material, finish, visible parts.
- Do NOT describe lighting, background, composition, mood or photography style.
- If a detail is not given, make ONE sensible decision and fix it — never leave it vague.
- "color" MUST be a single concrete color. Never write "various" or "multiple colors".
- "components" MUST list every part that should be visible. Write each as "part — where it is and what shape it is".
- If a part could be built in two different ways (a handle could be a rigid side handle OR a fabric loop strap; a lid could be flat OR domed), PICK ONE and say which. Ambiguity here is the #1 cause of the product looking different between shots.
- Write values in English, lowercase, max 20 words each.
Output JSON only, no markdown fence:
{"productType":"","color":"","material":"","formFactor":"","components":["part — position and shape"],"finish":""}`

function buildExtractInput(p: {
  productName: string
  category?: string | null
  features?: string | null
  sellingPoints?: string | null
  material?: string | null
  specifications?: string | null
}): string {
  return [
    `Product name: ${p.productName}`,
    `Category: ${p.category || "-"}`,
    `Features: ${p.features || "-"}`,
    `Selling points: ${p.sellingPoints || "-"}`,
    `Material: ${p.material || "-"}`,
    `Specs: ${p.specifications || "-"}`,
  ].join("\n")
}

/**
 * 取该项目的视觉事实；没有就生成一次并存库。
 * 返回 null 表示连兜底都拼不出来（正常不会发生）。
 */
export async function ensureVisualSpec(
  project: {
    id: string
    productName: string
    category?: string | null
    features?: string | null
    sellingPoints?: string | null
    material?: string | null
    specifications?: string | null
    visualSpec?: string | null
  },
  llm: { client: any; cfg: { model: string } } | null,
  persist: (id: string, json: string) => Promise<unknown>
): Promise<VisualSpec | null> {
  // 1. 已有则直接复用——这是"锁"的关键
  if (project.visualSpec) {
    try {
      const parsed = JSON.parse(project.visualSpec)
      const spec = normalize(parsed, "", project.productName)
      if (spec.color && spec.color !== "natural product color") return spec
    } catch {
      // 坏数据，重新生成
    }
  }

  const sourceText = [project.productName, project.features, project.sellingPoints, project.material, project.specifications]
    .filter(Boolean)
    .join(" ")
  const fallbackColor = guessColor(sourceText)

  let spec: VisualSpec
  if (llm) {
    try {
      const res = await (llm.client.chat.completions.create as any)({
        model: llm.cfg.model,
        messages: [
          { role: "system", content: EXTRACT_SYSTEM },
          { role: "user", content: buildExtractInput(project) },
        ],
        temperature: 0.1,
        max_tokens: 500,
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
      })
      const text = res.choices?.[0]?.message?.content || ""
      const jsonText = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()
      spec = normalize(JSON.parse(jsonText), fallbackColor, project.productName)
    } catch {
      spec = normalize(EMPTY_SPEC, fallbackColor, project.productName)
    }
  } else {
    spec = normalize(EMPTY_SPEC, fallbackColor, project.productName)
  }

  // 兜底仍未定色，说明输入里真没提，就用白色这颗最安全的钉子
  if (!spec.color || spec.color === "natural product color") {
    if (fallbackColor) spec.color = fallbackColor
  }

  await persist(project.id, JSON.stringify(spec))
  return spec
}

/**
 * 拼成注入到每个图片 prompt 的硬约束段。
 * 写法故意用祈使句 + 禁止项，因为模型对"must / do not"的服从度高于陈述句。
 */
export function visualLockText(spec: VisualSpec): string {
  const parts = [
    `PRODUCT APPEARANCE — this is fixed, do not redesign it:`,
    `- product type: ${spec.productType}`,
    `- color: ${spec.color} (every surface this color; do not change hue)`,
  ]
  if (spec.material) parts.push(`- material: ${spec.material}`)
  if (spec.formFactor) parts.push(`- shape and proportions: ${spec.formFactor}`)
  if (spec.components.length)
    parts.push(
      `- visible parts, all must appear exactly as described (do not swap a part for a different style of the same part): ${spec.components.join("; ")}`
    )
  if (spec.finish) parts.push(`- surface finish: ${spec.finish}`)
  parts.push(
    `The product above must be recognizable as the SAME physical object.`,
    `You may change camera angle, lighting, background and surrounding props, but NOT the product's color, shape, proportions or parts.`,
    `Do not invent additional accessories, logos or variants.`
  )
  return parts.join("\n")
}
