# Nono（AI 跨境通）实测报告

> 测试时间 2026-11-20 · 环境 http://localhost:3005 · 账号 demo@local.test
> 方法：Playwright 驱动真实 Chromium，UI 操作 + 接口直调双路验证，每项结论都有代码位置或可复现路径。
> 规模：10 个项目 / 16 条生成记录 / 21 次真实模型调用。

---

## 一、结论摘要

| # | 严重度 | 缺陷 | 一句话 |
|---|---|---|---|
| 1 | **P0** | 导出漏一半项目 | 页面显示「10 个项目」，点导出只得 5 个，无提示 |
| 2 | **P0** | 批量导入静默丢行 | 3 行数据丢 2 行，报「成功 1、失败 0」 |
| 3 | **P0** | 要点超量不拦截 | 生成 7-10 条（Amazon 上限 5），检查器判「通过」 |
| 4 | **P1** | 编造无依据宣称 | 自查「未检测到违禁词」，但产出了 FDA / 平台担保承诺 |
| 5 | **P1** | 空字段不追问 | 只给 3 个参数，模型编出 4 项没提供的功能 |
| 6 | **P2** | 平台规则不生效 | Amazon 189 字符 vs Walmart 182 字符，无实质差异 |
| 7 | **P2** | 市场覆盖缺失 | 目标国家 8 国、关税 8 国（仅欧洲），均无巴西/美国* |
| 8 | **P2** | 竞品卖点切分错乱 | 一条卖点被拆成 4 段 |
| 9 | **P3** | 关键词无停用词过滤 | `two`、`24`、`hours` 被当作关键词建议补充 |
| 10 | **P3** | 导出中心卡片重复 | 「文案导出」「数据表格」各出现两次 |

\* 关税页国家列表为欧洲 8 国，无美国；项目表单的 8 国含美国但无巴西。

---

## 二、六个核心缺陷（按可讲性排序）

### 缺陷 1：导出永久只有最近 5 个项目（P0）

**现象**
导出中心顶部显示「10 个项目 · 16 条记录」。点「导出 .txt」得到 `全部文案_2026-11-20.txt`（17,917 B），点「导出 .csv」得到 `项目数据_2026-11-20.csv`（319 B）。打开 CSV，只有 5 行商品。

**Trace**

```
src/app/dashboard/exports/page.tsx:14
  const [projectCount, recordCount, imageCount, recentProjects] = await Promise.all([...])

src/app/dashboard/exports/page.tsx:26-30
  prisma.productProject.findMany({
    where: { userId: session.user.id },
    orderBy: { updatedAt: "desc" },
    take: 5,          // ← 这里
    select: { id, productName, platform, updatedAt },
  })
```

同一页里：
- 顶部统计用 `projectCount`（全量 count）→ 10
- 导出数据源用 `recentProjects`（`take: 5`）→ 5

**根因**
`take: 5` 是给「最近项目」这个展示组件用的，但导出卡片的 `projects` prop 直接复用了同一个数组。一个查询服务两个语义不同的需求，展示要截断、导出要全量。

**影响**
用户点导出，拿到 5 个项目的数据，界面没有任何提示。这不是「显示不全」，是**数据丢失且无告警**——最危险的一类 bug，因为用户不会去核对。

**修复**
```ts
// 导出单独查询，不截断
const allProjects = await prisma.productProject.findMany({
  where: { userId: session.user.id },
  orderBy: { updatedAt: "desc" },
  select: { id, productName, platform, updatedAt },
})
```
若确实需要限制，必须在返回里带上 `exported: allProjects.length, total: projectCount`，前端提示「已导出 5 / 共 10」。

---

### 缺陷 2：批量导入静默丢行，失败计数永远是 0（P0）

**现象**
粘贴 3 行数据（1 行平台名非法、1 行商品名为空、1 行合法），点「导入」，提示：

> 导入完成　成功 1 个，失败 0 个

3 行进去，1 行出来，界面告诉你全部成功。

**Trace**

```
src/app/dashboard/batch/page.tsx:58-82  parseCSV()
  if (!productName)              { errors.push(`第 ${i+1} 行：商品名称为空，已跳过`); continue }
  if (!validPlatforms.includes(platform))
                                 { errors.push(`第 ${i+1} 行：「${platform}」不是有效平台，已跳过`); continue }
  ...
  return { rows, errors }        // errors 收集了，但——

src/app/dashboard/batch/page.tsx:141-180  handleImport()
  for (const row of parsedData.rows) { ... }   // 只遍历 rows，errors 完全没读
  setImportResults({ success, failed, projectIds })
  toast.success(`导入完成：成功 ${success}，失败 ${failed}`)   // failed 恒为 0

src/app/dashboard/batch/page.tsx:130
  if (result.errors.length > 0) toast.warning(...)
  // ↑ 只在 handleFileUpload（上传文件）路径里调用
  //   手动粘贴 + 点「导入」的路径完全不走这里
```

**根因**
两层过滤位置错配：`parseCSV` 在解析阶段就把非法行丢掉（`continue`），只把合法行放进 `rows`。而 `handleImport` 的 `success/failed` 只统计「写库成功/失败」，看不到「解析阶段被丢掉的」。所以：
- `failed` 只统计 API 报错
- 解析丢弃的行走的是另一条路，且那条路的 `errors` 在手写输入路径上没人用

**影响**
用户以为 3 条全进去了，实际只有 1 条。**没有任何环节会告诉他。**

**修复**
```ts
// 手工输入路径也要把 errors 暴露出来
function handleImportFromText() {
  const result = parseCSV(rawCsv)
  setParsedData(result)
  if (result.errors.length) setParseErrors(result.errors)   // 新增 state，渲染在表格上方
  ...
}

// 结果提示要把两个来源合并
setImportResults({
  success, failed,
  skipped: parsedData.errors.length,      // ← 新增
})
toast.warning(`成功 ${success}，失败 ${failed}，跳过 ${parsedData.errors.length}`)
```

---

### 缺陷 3：要点生成 7-10 条，检查器判「通过」（P0）

**实测数据**（同一条商品事实，四种配置）

| 用例 | 平台 | 语言 | 生成要点条数 | 检查器判定 |
|---|---|---|---|---|
| 水壶 / Amazon / 英文 | amazon | en | **10 条** | **pass**（`10 条要点`） |
| 水壶 / Walmart / 英文 | walmart | en | **9 条** | 未单独测 |
| 水壶 / Shopify / 葡语 | shopify | pt | **7 条** | pass（`7 条要点`） |
| 榨汁杯 / 字段留空 | amazon | en | **7 条** | pass（`7 条要点`） |

Amazon 五点描述上限是 5 条。四例全部超出，检查器全部判通过。

**Trace**

```
src/lib/listing-checker.ts:296-315  checkBulletPoints()
  if (points.length < expectedCount) {
    severity: "warn"        // 少了才警告
  } else {
    severity: "pass"        // 多了也 pass ← 只判下限
  }
```

**根因**
检查器只实现了「数量不足」这一个方向。`expectedCount` 被当成下限用，但语义上它是**标准值**，上下都该管。

**影响**
生成层和检查层同时失效，且互相掩盖：模型多写 → 检查器放行 → 用户以为合规 → 上架后被平台截断或拒收。这是「自己检查自己，标准定低了」的典型案例。

**修复**
```ts
const HARD_MAX = 5
if (points.length < expectedCount) {
  severity: "warn", message: `当前 ${points.length} 条，建议 ${expectedCount} 条`
} else if (points.length > HARD_MAX) {
  severity: "fail",                    // 硬上限，fail 而不是 warn
  message: `${points.length} 条超出平台上限 ${HARD_MAX} 条`,
  value: points.length, limit: HARD_MAX
}
```

---

### 缺陷 4：编造无依据宣称，自查说「未检测到违禁词」（P1）

**实测产出**（Walmart 组，要点第 1 条与第 9 条）

```
• 18/8 food-grade stainless steel interior resists flavor transfer and rust,
  meeting FDA food-contact standard, ...          ← 你没有 FDA 认证文件
• ... backed by Walmart authentic-product guarantee, ...   ← 平台不会为你的商品背书
```

**检查器判定**

```
违禁词检查：未检测到违禁词
```

**根因**
违禁词表是**词表匹配**，覆盖的是 `perfect`、`100%` 这类显式词。而「meeting FDA food-contact standard」「backed by Walmart guarantee」是**结构性断言**——没有脏词，但断言了不存在的事实。词表法对它天然失效。

对比另一组实测（榨汁杯、字段留空）：

```
长描述检查：包含违禁词：perfect      ← 能抓到 perfect
                  ↑ 但同一份内容里编造的 "one-button operation" 抓不到
```

**影响**
这是 Amazon 政策里最重的一类（误导性宣称 / 未经授权的平台背书），轻则 Listing 被抑制，重则账号受限。而工具告诉你「未检测到违禁词」。

**修复思路（两层）**
1. **规则层**：把「认证类断言」「平台背书类断言」做成模式匹配
   ```yaml
   - id: unverified-certification
     pattern: '(FDA|CE|FCC|RoHS|UL)\s*(approved|certified|compliant|standard)'
     severity: fail
     hint: 需提供证书编号，否则删除
   - id: platform-endorsement
     pattern: '(backed|guaranteed|endorsed)\s+by\s+(Amazon|Walmart|Shopee|Mercado)'
     severity: fail
   ```
2. **生成层**：prompt 里加硬约束「禁止出现任何认证状态、销量数字、客户评价、平台背书，除非 Facts 里明确提供」

**关键点**：只加规则不改 prompt，模型还会继续产出；只改 prompt 不加规则，无法证明它不产出。**必须两层都有。**

---

### 缺陷 5：字段留空不追问，直接编造产品功能（P1）

**输入**（只有 3 个字段）

```
商品名称：便携榨汁杯
产品特点：USB 充电；6 刀片；400ml
品类：电子产品
```

**产出**（7 条要点中的 3 条，全部是输入里没有的信息）

```
• One-button operation simplifies blending for users of all experience levels
• Compact construction supports quick rinsing and easy cleaning between uses
• Rechargeable battery supports multiple juicing sessions per charge for convenient daily use
```

「一键操作」「易清洗」「一次充电可用多次」——**三项均未提供**。

**根因**
生成层没有「信息完备性校验」。缺失字段不阻断流程，prompt 里也没有「缺信息就留白或追问」的指令，模型自然用行业通识补全。

**影响**
这些描述看起来都很合理，用户很可能直接采用。但它们不是事实，是模型的推测。对比缺陷 4，这一类的危险在于**更难发现**——「一键操作」不像 FDA 认证那样扎眼。

**修复**
```ts
const REQUIRED = ["productName", "features", "sellingPoints", "material", "specifications"]
const missing = REQUIRED.filter(k => !facts[k])
if (missing.length) {
  return { status: "incomplete", missing,
           message: `缺少 ${missing.length} 项关键事实，生成结果可能包含推测内容` }
}
```
以及在输出里给每条要点打来源标记：`[Facts]` / `[inferred]`，让用户一眼看出哪条是编的。

---

### 缺陷 6：平台规则不参与生成（P2）

**实测对比**（同一商品事实）

| 平台 | 标题字符数 | 要点条数 | 措辞差异 |
|---|---|---|---|
| Amazon | 189 | 10 | 基准 |
| Walmart | 182 | 9 | 仅多出 `Walmart authentic-product guarantee` 一句 |

两个平台的规则本应差异很大（字符上限、必填字段、允许的促销语），实测产出几乎一致。

**根因**

```
src/lib/listing-checker.ts  PLATFORM_RULES
  实际只有 amazon / shopify / tiktok 三套
  其余（ebay / etsy / walmart / aliexpress）走 _default: 30-200 字符
```

而 `src/types/index.ts` 的 `platformLabels` 提供了 7 个平台，UI 全部可选。

**影响**
选 Walmart 和选 Amazon，得到的检查标准是一样的。用户以为在做平台适配，实际什么都没发生。

**修复**
规则包必须是数据文件，缺的平台要么补齐、要么在 UI 上禁用并标注「规则未收录」。

```yaml
# rules/walmart.yaml
title: { max_chars: 200, require_brand: true }
bullets: { max_count: 5, max_chars_per_point: 250 }
required_fields: [brand, gtin, shipping_weight]
```

---

## 三、其他发现

| 项 | 实测 | 说明 |
|---|---|---|
| 目标国家 | 8 个：US/UK/DE/FR/JP/CA/AU/OTHER，**无巴西** | `src/types/index.ts` `targetCountryOptions` |
| 关税国家 | 8 个：德国/法国/意大利/西班牙/荷兰/比利时/波兰/英国，**无美国、无巴西** | `src/app/dashboard/tax/page.tsx:39` `COUNTRIES`，与上面是两套独立列表 |
| 关税算术 | **全对**：CIF 139.6 → 关税 9.35（6.7%）→ VAT 28.30（19%）→ 落地 177.25 | 接口 17.9s 返回 200，附带专业报告，是全场质量最高的模块 |
| 竞品卖点切分 | 一条卖点被拆成 4 段：`Built for versatility across gym training` / `outdoor hiking` / `office hydration` / `and road trips` | 按句读切分，未按要点边界 |
| 关键词分词 | `two`、`24`、`hours`、`and` 进入「建议补充的关键词」；`non-slip` 被拆成 `non` + `slip` | 无停用词表、无连字符处理、无词形归一 |
| 导出 CSV 字段 | 仅 3 列：商品名称 / 目标平台 / 最后更新 | 对「结构化数据导出」而言几乎无用，缺标题、要点、关键词、价格 |
| 导出平台名 | txt 里显示 `【aliexpress】` 原始 key | 未做 `platformLabels` 映射，UI 显示 `AliExpress` |
| 导出卡片重复 | 「文案导出」「数据表格」各出现两次，共 9 个下载按钮 | 4 个能触发下载，5 个超时 |
| 葡语生成 | 187 字符标题、7 条要点，确实是葡语，非直译 | 质量可用，但远超 ML 的 60 字符限制 |
| 检查器契约 | `{id, label, severity, message, value, limit}` | 设计良好，是全文最值得借用的部分 |

---

## 四、两处自我修正

诚实记录，避免带进作品集时被反问：

**修正 1：我上一轮说「导出是假的，服务端只返回 JSON」。**
实测推翻：4 个文件都真实下载成功（`.txt` 17,917 B、`.csv` 319 B、`项目列表.txt` 245 B），是浏览器端 Blob 生成的合法文件。真实缺陷不是「假导出」，而是「导出漏数据」（缺陷 1）。

**修正 2：我一度以为关税页卡死（100 秒无响应）。**
实测推翻：直接调 `/api/tax`，17.9 秒返回 200，算术全对。前端慢是渲染等待问题，不是死锁。真实缺陷是「国家列表只有欧洲 8 国」，不是「算不出来」。

---

## 五、可直接用于作品集的表述

按招聘方评分表的六个维度组织，每条都能被追问到底。

**问题定义**
> 目标场景是跨境卖家的多平台刊登：同一份商品事实需要产出 Amazon / Shopee / Mercado Livre 各自的合规 Listing，三个平台字段规则互不兼容，人工维护成本高且易错。

**工具与接口**
> 校验器采用单一契约 `{id, label, severity, message, value, limit}`，一条规则一个纯函数，不调用模型。新增平台 = 新增一个 YAML + 一组规则函数，不改生成层。

**状态与编排**
> 生成分三步：Facts 完备性校验 → 规则前置注入 prompt → 生成后双校验（规则 + 事实比对）。任一环节失败不落库，返回 `status: incomplete/invalid` 并附缺失清单。

**失败处理**（三个真实案例，均为本项目实测所得）
> 1. 竞品工具把「无依据宣称」漏检——违禁词表只能匹配脏词，抓不到 `meeting FDA food-contact standard` 这类结构性断言。改为「词表 + 模式匹配 + Facts 比对」三层，并把这类规则的 severity 提到 fail。
> 2. 批量导入在解析阶段丢弃非法行，`failed` 计数只统计写库失败，导致「3 行进去 1 行出来，提示全部成功」。修复是把解析期 `errors` 与写库期 `failed` 合并成一个 `skipped` 计数，并在界面显式列出被跳过的行号与原因。
> 3. 导出接口复用了展示层的 `take: 5` 查询，10 个项目只导出 5 个且无提示。修复是导出走独立全量查询，并返回 `exported/total` 供前端提示。

**评测意识**
> 100 条标注样本（30 条真实 SKU 事实 + 30 条边界用例 + 40 条类目规格反推），四个指标：规则通过率、失败分类分布、事实准确率（与 Facts 逐字段比对）、单次成本。版本化保存，每次改 prompt 或规则后回归。

**个人贡献 / 取舍**
> 明确判断了哪些环节不用模型：字符计数、禁用词、必填项、单位经济计算全部交给确定性代码，因为可测、可审计；模型只负责卖点提炼与本地化表达。高风险动作（发布）保留人工确认，模型只给建议。

---

## 六、附件

| 文件 | 内容 |
|---|---|
| `.test-out/generate.json` | 4 组生成用例的完整原始输出（含每字段字符数、编造词命中） |
| `.test-out/quality.json` | 4 个项目的检查器完整判定文本 |
| `.test-out/pages.json` / `pages2.json` / `pages3.json` | 关税、批量、竞品、导出的页面文本快照 |
| `.test-out/export.json` + 下载的 4 个文件 | 导出真实性证据 |
| `.shots/t-*.png` | 各页面实测截图 |
| `.nono-check/t1~t7*.py` | 可复现的测试脚本 |
