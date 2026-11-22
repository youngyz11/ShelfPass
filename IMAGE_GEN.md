# 真·图片生成能力（不是提示词）

目标：点「开始生成」出来的是一张图，不是一段英文 prompt。

---

## 一、原来为什么出不了图

三个坎叠在一起，任何一个没解决都出不来：

1. **没有图像服务的 key** —— `OPENAI_API_KEY` 为空，用户表 `imageApiKey` 为 NULL，整个出图分支被跳过
2. **服务地址写死 aipaiai.cn** —— 想换服务必须改代码
3. **base64 直接塞数据库** —— `imageUrl = "data:image/png;base64,..."`，一张 1024×1024 的 PNG 大约 1~2MB，每条记录都这么大，列表页和导出全被拖死

第 3 条最容易被忽略，但它是"能不能做成产品"的分水岭。真做出来之后你会发现数据库一周涨几百 MB。

---

## 二、现在的架构

```
用户填表
  ↓
DeepSeek V4.1-Flash（写提示词）        ← 只负责文字
  ↓
图像服务 API（真正画图）                ← IMAGE_BASE_URL / IMAGE_MODEL
  ↓
落盘 public/generated/xxx.png          ← 新增，库里只存 /generated/xxx.png
  ↓
<img src="/generated/xxx.png">         ← 页面直接显示
```

**文本模型和图像模型是两条独立的 API、两套计费**。这是行业常态，不是缺陷。

---

## 三、这轮改了什么

| 文件 | 改动 |
|---|---|
| `src/lib/image-store.ts` | **新增**。`saveBase64Image()` 落盘、`saveRemoteImage()` 先下载再落盘（防第三方链接过期） |
| `src/lib/ai-config.ts` | `ImageConfig` 增加 `sendResponseFormat`（gpt-image-1 不接受该参数时可关） |
| `src/app/api/generate/route.ts` | 出图后落盘；同时兼容 `b64_json` 和 `url` 两种响应格式；失败回传 `imageError` |
| `.env` | `IMAGE_BASE_URL` / `IMAGE_MODEL` 指向**硅基流动**，`IMAGE_SIZE` 明确为 1024x1024 |
| `.gitignore` | `/public/generated/*` 不入库，保留 `.gitkeep` |

### 为什么两种响应格式都要兼容

不同服务返回不一样：

- OpenAI / aipaiai 风格：`data[0].b64_json`
- 硅基流动 / 部分中转：`data[0].url`

只认一种的话，换服务就 500。现在两条路都走，统一落到本地文件。

---

## 四、实测结果：已经能出图了

用硅基流动的 key 跑通，模型 `Qwen/Qwen-Image`。

### 单张出图

```
HTTP 200  耗时 14.8s
imageUrl = /generated/20261120090352-22e723c2.png
落盘文件存在: True | 754,843 bytes
前端访问: 200 image/png
```

### 完整 UI 流程（3 个类型）

| 类型 | 结果 | 页面 `<img>` |
|---|---|---|
| 商品主图 | ✅ | `naturalWidth=1024` |
| 场景图 | ✅ | `naturalWidth=1024` |
| Banner 图 | ✅ | `naturalWidth=1024` |

Toast 提示「成功生成 3/3 项内容」，三张图在页面上正常渲染。截图：`.shots/img-05-real-images.png`

### 各环节状态

| 环节 | 状态 |
|---|---|
| 提示词生成（DeepSeek） | ✅ 1.7~2.1s |
| 图像服务调用 | ✅ 11~15s/张 |
| 远端 URL → 本地落盘 | ✅ 754KB PNG |
| 前端渲染 | ✅ `<img src="/generated/...">` |
| 数据库体积 | ✅ 只存路径 |

`npx tsc --noEmit` 干净通过。

---

## 四点五、两个实测发现的问题

### 1. 「AI 生成」水印：可以关，但要用请求头

**这里更正一个此前的错误结论。** 最早传 `"watermark": false` 到 body 里测，水印还在，于是判断成「平台强制、关不掉」——那是把参数放错了位置。

硅基流动 2026-09-30 的接口调整公告写得很明确：

> 图片生成 API 默认添加「AI 生成」显式水印……当且仅当开发者需要对生成图片执行下游的进一步处理时，才应显式传入 `X-Enable-Watermark: 0` 声明不添加显式水印。

也就是说水印由 **HTTP 请求头**控制，不是 body 字段。实测：

| 请求方式 | 结果 |
|---|---|
| body `"watermark": false` | ❌ 仍有水印 |
| 请求头 `X-Enable-Watermark: 0` | ✅ 干净，无任何角标 |

代码里通过 `imageRequestHeaders(cfg)` 发出，由 `.env` 的 `IMAGE_DISABLE_WATERMARK` 控制（默认 `true`）。

**合规提示**：关掉显式水印后，公告原文是「开发者有法定义务自行对最终输出图片添加相关显式水印」。另外还有一层**隐式水印固定在像素/元数据里，接口层面关不掉**。所以这是一个产品决策，不是技术开关——真实电商业务里，合规的做法是关掉平台水印、再叠自己的品牌水印（既是标识又顺便做了品牌曝光）。

这个取舍恰好是「合规工作台」这个作品主题的真实素材：生图不只是调 API，还牵着内容标识合规。

### 2. 同一商品仍然三个颜色

这次三张图肉眼可见地不一致：

- 商品主图：**鼠尾草绿**
- 场景图：**不锈钢原色**
- Banner：**鼠尾草绿**

用户输入里从未提过颜色。三次独立调用，模型各自决定视觉事实。这就是 P0-3 从文字层面升级成图片层面的证据。

修法不是调 prompt，而是在调模型之前锁死视觉事实（颜色/材质/盖子数量），再作为硬约束注入每个 prompt。

---

## 五、当前配置（已完成）

`.env` 里已填好，不需要再动：

```bash
IMAGE_API_KEY="sk-ljg..."                              # 硅基流动
IMAGE_BASE_URL="https://api.siliconflow.cn/v1"
IMAGE_MODEL="Qwen/Qwen-Image"
IMAGE_SIZE="1024x1024"
IMAGE_SEND_RESPONSE_FORMAT=false                       # 该服务返回 url 而非 b64
IMAGE_DISABLE_WATERMARK=true                           # 发 X-Enable-Watermark: 0，去掉「AI 生成」角标
```

硅基流动当前可用的图像模型（`GET /v1/models?type=image` 实测）：

| 模型 | 说明 |
|---|---|
| `Qwen/Qwen-Image` | 当前在用，质量最稳，11~15s/张 |
| `Tongyi-MAI/Z-Image-Turbo` | 更快，质量略降 |
| `Kwai-Kolors/Kolors` | 快手可图，中文/电商场景见长 |
| `Qwen/Qwen-Image-Edit` | 图生图编辑 |
| `OpenMOSS-Team/MOSS-Image` | — |

换模型只改 `IMAGE_MODEL` 一行。想换别家服务，改 `IMAGE_BASE_URL` + `IMAGE_MODEL` 两行，只要对方兼容 OpenAI 的 `/v1/images/generations` 就不用动代码。

> DeepSeek 没有图像模型（`output_modalities` 只有 `text`，`/images/generations` 返回 404），这条路走不通。

---

## 六、验证清单

拿到 key 后已验证：

| 检查项 | 结果 |
|---|---|
| 真的出图 | ✅ 卡片里出现图片，`imageUrl=/generated/...png` |
| 数据库不膨胀 | ✅ 存的是短路径，不是 base64 |
| 失败可见 | ✅ 假 key 时页面显示 `401 status code` |

---

## 七、还没做的

- 生成图片没有清理机制，`public/generated/` 会一直涨，生产环境需要定时清理或接对象存储
- `imageError` 只回传不落库，刷新后提示消失
- 没有"重新生成"按钮，不满意只能新建项目
- 多图批量（`n > 1`）没做
