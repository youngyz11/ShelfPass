# 模型配置化改造说明

改造时间：2026-11-20
目标：把写死在代码里的模型名 / 接口地址 / 密钥全部抽成 `.env` 配置，默认 DeepSeek，行为不变。

> **2026-11-20 16:55 更正**：初版文档里说"DeepSeek 有 deepseek-chat / deepseek-reasoner 两个文本模型"，这是过时信息。实测与官方文档核对后已更新，见下方「DeepSeek 现在到底有什么」。

---

## 一、DeepSeek 现在到底有什么（实测）

直接打官方 API 得到的三条证据：

### 1. `/models` 返回的模型自带模态字段

```json
{
  "id": "deepseek-flash",
  "name": "DeepSeek-V4.1-Flash",
  "context_window": 1048576,
  "input_modalities": ["text", "image"],
  "output_modalities": ["text"]
}
```

`output_modalities` 只有 `text`。**能看图，不能画图。**

### 2. 生图端点不存在

```
POST https://api.deepseek.com/images/generations
→ 404 {"error":{"message":"Not Found","type":"not_found_error"}}
```

### 3. 旧模型名只是别名

| 请求的 model | HTTP | 响应里的 `model` 字段 | 耗时 |
|---|---|---|---|
| `deepseek-chat` | 200 | **`deepseek-flash`** | 1.0s |
| `deepseek-reasoner` | 200 | **`deepseek-flash`** | 1.2s |
| `deepseek-flash` | 200 | `deepseek-flash` | 0.8s |

三个名字打到的是**同一个模型**。官方 2026-09-10 公告：`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 下线并路由到 V4.1-Flash；`deepseek-chat` / `deepseek-reasoner` 已不在官方模型列表，仅为兼容保留。

### 所以为什么"V4.1-Flash 能生成图片"？

V4.1-Flash 本身**不能**。它只负责理解（看图）和输出文本。你在对话里看到的图，是 Agent 平台外挂的**图像生成工具**产出的——工具收到一段自然语言提示词，转交给一个专门的文生图模型（走的是另一条 API、另一套计费），再把图片文件返回。

链路上是两段，不是一段：

```
你 → V4.1-Flash（写提示词 / 调度工具） → 文生图模型（真正画图） → 图片文件
```

这也正是 Nono 的问题：它把"写提示词"和"调图像 API"塞进同一个函数，但两者的模型契约完全不同。

---

## 二、改了哪些文件

| 文件 | 改动 |
|---|---|
| `src/lib/ai-config.ts` | **新增**。模型/接口配置 + 客户端工厂 + `llmExtraBody()` |
| `src/app/api/generate/route.ts` | 文案走 `createLlmClient()`；图片走 `createImageClient()`，失败回传 `imageError` |
| `src/app/api/generate/suggestions/route.ts` | 改用 `createLlmClient()` |
| `src/app/api/tax/route.ts` | 改用 `createLlmClient()`，两处调用统一传思考开关 |
| `src/components/dashboard/quick-generate.tsx` | 卡片下方显示图片失败原因（橙色小字） |
| `.env` | 追加配置说明块（全部注释，不影响现有行为） |
| `.env.bak.202611201644` | 改造前备份 |

---

## 三、配置项

### 文本模型（默认 DeepSeek V4.1-Flash）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LLM_API_KEY` | 回退 `DEEPSEEK_API_KEY` | 密钥 |
| `LLM_BASE_URL` | `https://api.deepseek.com` | 可指向任何 OpenAI 兼容服务 |
| `LLM_MODEL` | `deepseek-flash` | 即 V4.1-Flash；`deepseek-chat` 是被路由的旧别名 |
| `LLM_ENABLE_SEARCH` | `true` | 关税计算联网搜索；仅 baseURL 含 deepseek 时透传 |
| `LLM_THINKING` | `disabled` | 文案生成不需要思考，关掉快一倍 |

### 图片模型（默认 aipaiai.cn）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `IMAGE_API_KEY` | 回退 `OPENAI_API_KEY` | 密钥 |
| `IMAGE_BASE_URL` | `https://aipaiai.cn/v1` | 接口地址 |
| `IMAGE_MODEL` | `gpt-image-2` | 模型名 |
| `IMAGE_SIZE` | `1024x1024` | 出图尺寸 |

DeepSeek 没有图像模型，图片通道必须外接服务（aipaiai.cn，或任何兼容 OpenAI Images API 的中转）。

---

## 四、思考模式：一个被忽略的性能坑

换用 `deepseek-flash` 后，文案生成从 1.7s 涨到 4.5s。原因是：

- `deepseek-chat` 别名 = V4.1-Flash **thinking off** → 快
- `deepseek-flash` 直连 = V4.1-Flash **thinking on（effort=high）** → 慢一倍

所以加了 `LLM_THINKING` 开关，默认 `disabled`，通过 body 里的 `thinking: { type: "disabled" }` 透传。

### 实测对比（同一条 title 生成）

| 配置 | 耗时 |
|---|---|
| `LLM_THINKING=disabled`（默认） | **1.7s** |
| `LLM_THINKING=enabled` | **3.9s** |

双向都验证过，改完已还原默认。

---

## 五、验证记录

脚本：`.nono-check/t10_cfg.py`（常规）、`t11_reasoner.py`（模型切换）

| 测试 | 结果 |
|---|---|
| 默认配置下 `/api/generate` title | HTTP 200，真实英文标题，1.9s，非模板 |
| 默认配置下 `mainImage` | HTTP 200，`imageUrl=null`，`imageError="未配置图片服务密钥"` |
| `/api/generate/suggestions` | HTTP 200，11 个字段完整 JSON，2.1s |
| `LLM_MODEL="deepseek-chat-not-exist"` | 0.6s 返回模板内容 `高品质...` → **确定性证明配置被读取** |
| `LLM_THINKING=enabled` | 1.7s → 3.9s |
| 还原后复测 | 全部恢复正常 |

`npx tsc --noEmit` 干净通过。

---

## 六、还没做的

- 下拉框仍回显原始枚举值（`amazon` / `en` 而非 `Amazon` / `English`），独立 UI bug
- `imageError` 只回传不落库，刷新页面后提示消失
- 没有 provider 切换 UI，换模型仍要改 `.env`（Next dev 会自动 reload）
- V4.1-Flash 的**图片输入**能力没被用上——竞品截图分析、商品图读图这类功能目前完全没做
