# Nono 图片生成页 — 浏览器字段实测

测试时间：2026-11-20 16:30
环境：http://localhost:3005 ，账号 demo@local.test
方式：Playwright 驱动真实 Chromium，逐字段 `fill` 触发 React onChange，再点「开始生成」，抓 POST 响应 + DOM + 截图
脚本：`.nono-check/t8_image_ui.py`（正常路径）、`t9_img_failkey.py`（错误 Key 路径）
截图：`nono/.shots/img-01-empty.png` / `img-02-filled.png` / `img-03-result.png`

---

## 1. 页面字段清单（源码核对）

路由 `/dashboard/images`，组件 `components/dashboard/quick-generate.tsx`

| 字段 | 控件 | 必填 | 实际提交 |
|---|---|---|---|
| 商品名称 | Input `#productName` | ✅ | `productName` |
| 产品特点 / 核心功能 | Textarea `#features` | | `features` |
| 核心卖点 | Textarea `#sellingPoints` | | `sellingPoints` |
| 目标平台 | Select（7 项） | 默认 amazon | `platform` |
| 输出语言 | Select（8 项） | 默认 zh | `language` |
| 生成类型 | 多选按钮（5 项） | 默认前 2 项 | 逐个调 `/api/generate` |

生成类型：商品主图 mainImage / 场景图 sceneImage / Banner 图 banner / 社媒图 socialMediaImage / 促销海报 promoPoster

---

## 2. 本轮填写内容（页面上可直接看到）

- **商品名称**：`32oz 不锈钢真空保温水壶 AquaPeak`
- **产品特点**：`18/8 食品级不锈钢内胆；双层真空隔热；保冷 24 小时 / 保温 12 小时；防漏螺旋盖带硅胶圈；宽口 5.5cm 可放冰块；粉末喷涂外层防滑`
- **核心卖点**：`唯一能放进标准车载杯架的 32oz 水壶；附赠两个盖子（吸管盖 + 翻盖）；同价位保温时长比同类多 4 小时；哑光磨砂手感不留指纹`
- **目标平台** → `Amazon`；**输出语言** → `English`
- **生成类型** → 勾选 3 项：商品主图 + 场景图 + Banner 图

字段回读校验（`input_value` 取回 DOM 实际值）与输入完全一致 —— 受控组件写入正常，无字符丢失、无换行丢失。

---

## 3. 执行结果

- 耗时 **7.0 s**，POST 序列：`/api/projects` 200 → `/api/generate` ×3 全 200
- Toast：**"成功生成 3/3 项内容"**
- 右侧产出 **3 张卡片**，每张都是一段英文提示词 + 一行小字"提示词已生成，可复制到 AI 绘图工具（如 Midjourney、DALL·E）中生成图片"
- **页面 `<img>` 元素数量 = 0** —— 一张图都没出

即：这个叫"图片生成"、写着"利用 AI 生成高质量商品图片和营销视觉素材"的页面，**当前配置下 100% 只产提示词，不产图片**。

---

## 4. 缺陷

### P0-1 页面承诺出图，实际只出提示词，且无前置告知
`/api/generate` 里 `imageApiKey = user.imageApiKey || process.env.OPENAI_API_KEY`，本地 `.env` 的 `OPENAI_API_KEY=""`，数据库两个用户的 `imageApiKey` 均为 NULL → 整个 `oa.images.generate` 分支被跳过，`imageUrl` 恒为 null。
生成页**没有任何"未配置图片 Key"的检测或提示**，用户填完表点生成，看到"成功生成 3/3 项内容"，会以为图在下载中。
→ 应在页面顶部或"生成类型"区做 Key 状态检查：未配置时禁用图片类选项并给出配置入口。

### P0-2 图片接口调用失败被完全吞掉，仍返回 HTTP 200
实测：把 `imageApiKey` 写成 `sk-this-key-is-invalid-000`（PUT `/api/user/settings`），生成主图 → **HTTP 200，`imageUrl = None`，`content` 长度 434**，页面照常显示"提示词已生成"。
源码里是 `try { ... } catch (e) { console.error(...) }`，异常只进服务端日志。用户侧零反馈。
→ 同一份代码对文案类和图片类是两种语义，图片失败必须回传字段（如 `imageError`）让前端提示。

### P0-3 同一商品的三个 prompt 互相矛盾
- 主图：`matte powder-coated finish in **soft sage green**`
- 场景图：`a **matte black** 32oz stainless steel ... water bottle`
- 用户从未指定颜色。三类图是三次独立调用，各自凭空选色，**放进同一张详情页就是三个不同产品**。
→ 这正是"事实层（Facts）先定、视觉层只引用"要解决的问题：颜色/材质等视觉事实应由用户或事实库锁定，所有类型共享。

### P1-1 提示词混入 Midjourney 参数，却被直接喂给 OpenAI Images API
主图 prompt 结尾：`... commercial product shot --ar 1:1 --style raw`
system prompt 写的是"适合用于 Midjourney/Stable Diffusion 等工具"，产出带 MJ 参数；但下游 `oa.images.generate({ model: "gpt-image-2", prompt: content })` 原样发送。`--ar 1:1` 对 OpenAI Images 无意义，`--style raw` 可能被当正文影响出图。
→ 提示词目标与出图通道是两套契约，中间没有适配层。

### P1-2 图片通道硬编码 aipaiai.cn，设置页未说明
代码固定 `baseURL: "https://aipaiai.cn/v1"`、`model: "gpt-image-2"`；设置页卡片只写"兼容 OpenAI Images API"。
用户填官方 OpenAI Key 必然 401，且因 P0-2 静默失败，根本查不出原因。

### P1-3 下拉框回显原始枚举值
截图可见：目标平台框显示 `amazon`（应为 `Amazon`），输出语言框显示 `en`（应为 `English`）。
`components/ui/select.tsx` 的 `SelectValue` 直接渲染 value；`platformLabels` / `languageLabels` 的映射没被用上。

### P2 提示词不可编辑
卡片只有 复制 / 下载 / 收藏，没有"改完再生成"。对提示词类产出，不能编辑等于不能迭代。

---

## 5. 用真实生图通道复现提示词（对照证据）

把 Nono 产出的原始 prompt 直接喂给生图通道，验证提示词本身的质量：

| 类型 | 产出 | 说明 |
|---|---|---|
| 商品主图 | `.shots/Amazon_product_photography__32_2026-11-20T08-36-04.png` | 鼠尾草绿、双盖、纯白底、柔光棚拍 |
| 场景图 | `.shots/Minimalist_lifestyle_product_p_2026-11-20T08-36-33.png` | **哑光黑、单盖**、车载杯架 |

两张图并排看：**同一个商品，一个是浅绿双盖，一个是纯黑单盖**。这就是 P0-3 的实锤——用户输入里没有一个字提到颜色和盖子数量，三次独立调用各自编了一套视觉事实。

附带结论：主图 prompt 尾部 `--ar 1:1 --style raw` 在生图通道里被忽略（没有画成文字，属幸运），参数本身无效。

---

## 6. 下一步（二选一即可让"图片生成"真的出图）

1. 去 `设置 → 图片生成 API 密钥` 填一个 **aipaiai.cn** 的 key（不是 OpenAI 官方 key），再重跑本测试；
2. 或改 `src/app/api/generate/route.ts` 第 376 行，把 `baseURL` 改成可配置（读 `IMAGE_API_BASE_URL`），并允许 `gpt-image-1` / `dall-e-3` 等模型名。
