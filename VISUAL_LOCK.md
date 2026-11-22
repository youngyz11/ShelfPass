# 视觉一致性：为什么同一个商品会被画成五个样子

## 一、问题

同一份商品信息，勾选 5 个图片类型，出来的 5 张图里产品互不相同：

| 类型 | 实际画出来的东西 |
|---|---|
| 商品主图 | 白色杯身 + 透明底杯，带提手环 |
| 场景图 | 矮胖杯，**带手柄**，比例完全不同 |
| Banner | 接近主图但更瘦长，没有提手环 |
| 社媒图 | **一个白色马克杯**，没有底杯也没有刀头 |
| 促销海报 | **台式破壁机**，根本不是便携杯 |

买家看到这组图会认为是两个不同的产品。

## 二、根因

不是模型不听话，是提示词里**从来没说过这个产品长什么样**。

改造前 5 个图片模板的指令是这样写的：

```
- 描述产品主图的构图、光线、风格和氛围
- 视觉风格参考：minimal
- 只输出 Prompt 本身
```

「构图 / 光线 / 风格」都是**拍摄维度**，产品外观一个字没提。而 5 个类型是 5 次独立请求，彼此不知道对方画了什么。于是每次调用，模型都要从「FreshGo Pro 1.5L Portable Blender Cup」这几个字重新发明一遍外观——五次发明，五个产品。

颜色只是最表面的症状。真正的病是**没有共享的视觉事实**。

## 三、解法：视觉事实锚（Visual Spec）

在第一次生成图片之前，先把产品外观确定成一份结构化事实，存进项目；之后每个图片 prompt 都把它作为硬约束带上。

```
商品信息 ──→ 提取一次 ──→ VisualSpec（存库）──┬──→ 主图 prompt
                                              ├──→ 场景图 prompt
                                              ├──→ Banner prompt
                                              ├──→ 社媒图 prompt
                                              └──→ 海报 prompt
```

### 数据结构

```ts
type VisualSpec = {
  productType: string      // portable blender cup
  color: string            // matte cream white   ← 不一致的头号元凶
  material: string         // Tritan body, 316 stainless steel blades
  formFactor: string       // tall cylindrical, base is 1/3 of height
  components: string[]     // ["clear base with 6-blade assembly", "carry handle loop", ...]
  finish: string           // matte frosted, no visible logo
}
```

只描述**物理外观**，不碰光线、背景、构图、氛围——那些才是每个类型该自由发挥的地方。

### 注入方式

```ts
PRODUCT APPEARANCE — this is fixed, do not redesign it:
- product type: portable blender cup
- color: matte cream white (every surface this color; do not change hue)
- material: Tritan body with 316 stainless steel blades
- shape and proportions: tall cylindrical cup, clear blade base is 1/3 of total height
- visible parts, all must appear: clear blade base, carry handle loop, cream lid, silicone ring
- surface finish: matte frosted

The product above must be recognizable as the SAME physical object.
You may change camera angle, lighting, background and surrounding props,
but NOT the product's color, shape, proportions or parts.
Do not invent additional accessories, logos or variants.
```

用祈使句 + 显式禁止项，因为模型对 `must / do not` 的服从度明显高于陈述句。

### 关键：颜色不许由模型每次决定

`color` 字段只用三种来源，按优先级：

1. 项目里已存的 spec（一次确定，永久复用）
2. LLM 从商品信息里提取，温度 0.1，只允许给出一个具体颜色，禁止 `various / multiple`
3. LLM 不可用时，用正则从文本里匹配颜色词兜底

绝不会出现「让模型每次自己挑一个」。

## 四、效果

同一份输入、同样 5 个类型：

| | 改前 | 改后 |
|---|---|---|
| 产品形态 | 5 种（含马克杯、台式破壁机） | 1 种，5 个角度 |
| 颜色 | 白色 / 米色 / 深色背景破壁机 | 统一奶油白 |
| 部件 | 手柄有/无/提手有/无 | 提手带、透明刀头底座、硅胶圈一致 |

对照图：`.shots/before-after-lock.png`

## 五、还剩什么没解决

**1. 比例仍有轻微漂移。** 主图的透明底座占比偏小，海报的杯身偏高。文字约束能让模型「不改变品类和颜色」，但管不住精确到毫米的尺寸关系。

要彻底解决，得换成**图生图**：先生成主图，再把主图作为参考图传给后面 4 个类型（`Qwen/Qwen-Image-Edit` 支持参考图输入）。这是下一步该做的事，比继续调 prompt 有效。

**2. 用户看不到 spec。** 现在 spec 存在数据库里，前端没有展示入口。产品上应该让用户能改——他比模型更清楚自己的产品是圆角还是直角。这是一个明确的待办。

**3. 首次生成变慢。** 提取 spec 要多一次 LLM 调用，主图从 15s 变成 25s。后面 4 张不受影响。
