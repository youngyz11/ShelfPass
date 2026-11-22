# Nono 全功能测试填写内容

> 地址 http://localhost:3005 ／ 账号 demo@local.test ／ 密码 demo123456
> 用法：按页面顺序填，每个用例后面标了「在测什么」——测出来的异常直接就是面试素材。

---

## 零、测试用的三个商品

后面所有页面都从这三个里选，不要每次现编，否则结果无法对比。

### 商品 A：真空保温水壶（标准品，主线跑通用）

```
商品名称：32oz 不锈钢真空保温水壶
产品品类：运动户外
目标平台：Amazon
生成语言：English
价格区间：经济型 ($10-30)
品牌名称：AquaPeak
目标人群：健身房用户、徒步爱好者、办公室白领
产品特点：18/8 食品级不锈钢；双层真空；保冷 24 小时 / 保温 12 小时；防漏盖；宽口设计
核心卖点：适配标准车载杯架；附赠两个盖子（吸管盖 + 翻盖）；粉末喷涂不打滑
关键词：insulated water bottle, 32oz, stainless steel, leakproof, vacuum flask
使用场景：健身房训练、户外徒步、办公室日常饮水、长途驾驶
核心材质：18/8 食品级不锈钢 + 粉末喷涂
规格参数：容量 950ml，高 27cm，直径 9cm，净重 420g
用户痛点：普通水壶放不进车载杯架；盖子漏水弄湿包；冰块半天就化
竞争优势：同价位唯一配双盖且能进杯架；保温时长比同类多 4 小时
节日活动：夏季户外季、父亲节
品牌调性：专业权威
文案风格：技术参数
视觉风格：极简白底
生成强度：均衡模式
```

### 商品 B：定制宠物画像马克杯（POD，测边界与合规）

```
商品名称：定制宠物手绘画像马克杯
产品品类：家居园艺
目标平台：Shopify
生成语言：English
价格区间：经济型 ($10-30)
品牌名称：PawPortrait
目标人群：养狗养猫的年轻人、送礼人群
产品特点：11oz 陶瓷；可上传照片；画师手绘非滤镜；可用洗碗机微波炉
核心卖点：含 3 次免费修改；3-5 个工作日发货；每只宠物单独绘制
关键词：custom pet mug, personalized dog gift, pet portrait, hand drawn
使用场景：母亲节送礼、圣诞节送礼、宠物纪念、生日礼物
核心材质：11oz 陶瓷
规格参数：容量 330ml，高 9.5cm
用户痛点：定制类目最怕画得不像；等太久赶不上节日
竞争优势：手绘而非滤镜；含 3 次修改，同行通常 0-1 次
节日活动：母亲节、圣诞节
品牌调性：亲切友好
文案风格：情感共鸣
视觉风格：生活方式
生成强度：质量优先
```

### 商品 C：故意挖坑（测幻觉与违规拦截）

```
商品名称：便携榨汁杯
产品品类：电子产品
目标平台：Amazon
生成语言：English
价格区间：经济型 ($10-30)
品牌名称：（留空）
目标人群：（留空）
产品特点：USB 充电；6 刀片；400ml
核心卖点：（留空）
关键词：（留空）
使用场景：（留空）
核心材质：（留空）
规格参数：（留空）
```

**在测什么**：字段大面积留空时，它是追问、还是硬编。重点看生成结果里有没有出现 `best seller`、`#1`、`FDA approved`、`100% safe`、`thousands of customers` 这类无依据宣称——这是 Amazon 会直接下架的内容。

---

## 一、新建项目（/dashboard/new）

填「商品 A」全字段。然后**再建两个对照项目**：

| 项目 | 只改一处 | 在测什么 |
|---|---|---|
| A-2 | 目标平台改 **Walmart** | Walmart 不在 `PLATFORM_RULES` 里，会走 `_default`（30-200 字符）。看它给的建议和 Amazon 是否一样 |
| A-3 | 生成语言改 **Português** + 目标国家选 **其他** | **Nono 的国家列表里没有巴西**。看葡语能不能出，以及「其他」会导致什么降级 |

**记录**：项目详情页生成后，看标题字符数、要点条数、有没有 `seo_score` 之类的自评。

---

## 二、文案生成（/dashboard/copy）

商品名称、产品特点、核心卖点填「商品 B」，平台 **Shopify**，语言 **English**。

**七种内容类型逐个勾选测试**（一次全勾也行，但建议分开，方便对比质量）：

| 类型 | 关注点 |
|---|---|
| 商品标题 | 字符数、有没有堆关键词 |
| 要点描述 | **条数**——会不会生成 8 条以上（Amazon 上限 5） |
| 短描述 | 是否重复标题 |
| 长描述 | 有没有编造社会证明 |
| 广告文案 | 有没有 `限时`、`仅剩 X 件` 这类无法证实的 |
| SEO 关键词 | 是否与标题重复 |
| 品牌故事 | 会不会编造成立年份、产地 |

**追加一轮对照**：同一份输入，语言切 **日本語**，平台切 **Amazon**。看它是不是只是把英文翻过去（那样就没有本地化价值）。

---

## 三、图片生成（/dashboard/images）

商品名称填 `定制宠物手绘画像马克杯`，产品特点填商品 B 的特点，核心卖点填商品 B 的卖点。

- 平台：**Amazon**
- 语言：**中文**
- 类型：先只勾「商品主图」，再单独勾「促销海报」

**在测什么**：
1. `Amazon + 中文` 这个组合本身矛盾——主图禁文字，看它怎么处理
2. 主图是否按白底规格出（Amazon 要求纯白 RGB 255,255,255）
3. 「促销海报」选 Amazon 时，它有没有提示这个平台其实不需要海报

---

## 四、质量检查（/dashboard/quality）

这个页面最能暴露问题，**灌三组故意的样本**。

### 4.1 正常样本（先跑通）
粘贴商品 A 生成的标题 + 5 条要点 + 描述，平台选 Amazon。

### 4.2 违禁词样本
标题填：

```
100% Leakproof Best Stainless Steel Water Bottle Perfect for Gym
```

**在测什么**：`100%`、`Best`、`Perfect` 三个词都会被拦。看它报的是哪几条、severity 是不是 fail。

### 4.3 要点超量样本
要点粘 **9 条**（把商品 A 的 5 条拆细，或者复制粘贴凑到 9 条）。

**在测什么**：上一轮实测发现——**要点数量只判少不判多，9 条会被判「通过」**。这是确认过的 bug，你亲口指出来就是硬证据。

### 4.4 关键词不命中样本
要点里一次都不出现标题里的核心词。

**在测什么**：它是精确短语匹配（`custom pet mug` 对不上 `Custom Pet Portrait Mug`），看报不报「关键词覆盖 0/3」。

---

## 五、竞品分析（/dashboard/competitor）

三个框分别填：

**竞品标题**
```
ThermoFlask 40oz Stainless Steel Insulated Water Bottle with Two Lids, Leak Proof, Cold for 24 Hours
```

**竞品要点（每行一条，正好 5 行）**
```
DOUBLE WALL VACUUM INSULATION: keeps drinks cold up to 24 hours and hot up to 12 hours
TWO LIDS INCLUDED: one straw lid and one spout lid for different activities
LEAK PROOF DESIGN: locking mechanism prevents spills in your bag
FITS CUP HOLDERS: tapered base fits most car cup holders
BPA FREE: made from 18/8 food grade stainless steel
```

**竞品描述**
```
Stay hydrated all day with the ThermoFlask 40oz insulated water bottle. Double wall vacuum insulation keeps your drinks cold for up to 24 hours or hot for up to 12 hours. Includes two lids so you can switch between a straw lid for the gym and a spout lid for hiking. The tapered base fits most car cup holders, and the leak proof locking lid means no spills in your bag.
```

**在测什么**：它会输出「关键词差距」和「卖点差异」两块。看它能不能发现**竞品是 40oz、你是 32oz**——这是最直接的可对比参数，如果它只讲"两者都有双盖"，说明只做了词频统计，没做参数比对。

---

## 六、批量生成（/dashboard/batch）

CSV 格式是 `商品名称,目标平台,语言,产品特点,核心卖点`，**逗号分隔，字段内不能有逗号**。

### 6.1 正常批次（4 条）

```
商品名称,目标平台,语言,产品特点,核心卖点
不锈钢真空保温水壶,amazon,en,双层真空保温24小时,适配车载杯架
定制宠物手绘马克杯,shopify,en,11oz陶瓷手绘非滤镜,含3次免费修改
便携榨汁杯,amazon,en,USB充电6刀片400ml,一键清洗
硅胶折叠水杯,shopify,en,食品级硅胶可折叠,适合旅行携带
```

### 6.2 异常批次（测容错）

```
商品名称,目标平台,语言,产品特点,核心卖点
测试商品一,aliexpress,pt,特点描述,卖点描述
测试商品二,walmart,zh,特点描述,卖点描述
,amazon,en,名称为空,,,,,
测试商品四,不存在的平台,en,特点描述,卖点描述
```

**在测什么**：
- `aliexpress` / `walmart` 走 `_default` 规则（30-200 字符），标题限制和 Amazon 不一样
- 名称为空会不会整批失败
- 平台填错是静默跳过、还是整批报错、还是返回 200 但结果是空的

---

## 七、关税计算（/dashboard/tax）

| 字段 | 填 |
|---|---|
| 产品名称 * | 不锈钢真空保温水壶 |
| HS 编码（可选） | 961700 |
| 目的国 * | 美国 |
| 单价（元）* | 120 |
| 单件重量（kg）* | 0.45 |
| 数量 * | 100 |
| 运输方式 | 空运 |

**在测什么**：
1. HS 9617.00 是「真空保温容器」的正确归类，看它认不认
2. 算出关税后，**手工核一遍**：美国对 9617 的税率 + 是否叠加 301 关税。它大概率只算基础税率不算加征
3. 目的国换「其他」再算一次，看是不是直接返回空或报错——**没有巴西选项，这一栏对你是废的**

---

## 八、导出中心（/dashboard/exports）

先跑完商品 A 和 B 的生成，再进来。

- 看卡片是不是重复（上一轮实测：「文案导出」和「数据表格」各出现两次）
- 试「文案导出」下载，打开确认编码（应该是 UTF-8 BOM，否则 Excel 中文乱码）
- 试「数据表格」，确认字段是否包含平台专属字段（Amazon 的 `search_terms`、Shopify 的 `SEO title`）

**在测什么**：`/api/generate/export` 服务端只支持 `type=copy`，返回 JSON 不是文件。如果前端能下载，说明是浏览器端生成的——那就是"假导出"。

---

## 九、模板（/dashboard/templates/amazon|shopify|tiktok）

三个模板各点一遍，看预填内容。

**在测什么**：模板预填的是 `electronics` 的示例（蓝牙耳机）。看它是不是**把示例数据当成了真实数据**——如果生成的文案里出现"蓝牙 5.3"这类你没填的参数，说明模板污染了输入。

---

## 十、测完要记录的东西

按这个表记，测完直接能写进作品集的「失败处理」章节：

| # | 页面 | 操作 | 预期 | 实际 | 判定 |
|---|---|---|---|---|---|
| 1 | 质量检查 | 粘 9 条要点 | 应判 fail（上限 5） | | |
| 2 | 质量检查 | 标题含 `100%` `Best` `Perfect` | 三项都 fail | | |
| 3 | 文案生成 | 平台 Walmart | 规则应与 Amazon 不同 | | |
| 4 | 图片生成 | Amazon + 中文 | 应提示矛盾 | | |
| 5 | 批量 | 平台填「不存在的平台」 | 应报错或跳过并提示 | | |
| 6 | 关税 | 目的国选「其他」 | | | |
| 7 | 导出 | 点「数据表格」 | 应是真文件 | | |
| 8 | 全局 | 看左下角 Issues 数 | 应该是 0 | | |

**最值钱的三条**：第 1 条（已确认的 bug）、第 3 条（平台规则是假的）、第 7 条（导出是假的）。这三条能证明你不是点着玩，是读着代码在测。
