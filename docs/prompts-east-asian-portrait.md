# Lovemi 立绘复刻提示词（东亚主文档 · 欧美微调）

本文档固化当前 Lovemi Auto「生图复刻」效果较好的一版策略，供分析模型 / 人工改参对照。

> **重要**  
> - `appearance_tags`：**会发给** Lovemi，驱动生图（短结构化，官网约 Qt ≤80）。  
> - `portrait_prompt`：**仅本工具本地草稿**，创建时 **不会** 发给服务器。  
> - 生图主要靠：短 `appearance_tags` + 服务端 `prompt_enhancement`。  
> - 单条外观 tag 建议 **20–72 字**，硬上限 **80**；目标约 **18–26 条**；禁止灌水凑字。

---

## 一、东亚角色（默认主路径）

### 1.1 区域与语言

| 字段 | 值 |
|---|---|
| `ancestry_region` | `east_asian` |
| `ancestry_tags` | 含 `东亚裔`（可加华裔/日系/韩系） |
| `agent_prompt_settings.language` | **`zh-CN`** |
| `display_name` | **中文**可爱名（2～3 汉字，避免撞名）；**若用户提示词已写明角色身份（如「黑寡妇」）则必须用该身份，禁止再随机起名** |
| `appearance_tags` / 性格 / 性癖 / `portrait_prompt` | **中文** |

### 1.2 必填外观前缀（短但密）

按参考图写具体可见信息，禁止空话「复刻参考图」刷屏：

```
发型: …（刘海/遮眼/层次/蓬松/长度/扎发；禁止擅自改发型）
发质: …
发色: #RRGGBB
瞳色: #RRGGBB
肤色: #RRGGBB
体型: …
五官: …（东亚脸型眼型鼻唇辨识点）
妆容: …
朝向: …（观众视角，禁止镜像）
惯用手: …
服装: 上装+下装品类颜色与参考一致，仅同品类内更暴露，禁止换品类/露点
露肤度: 比参考更暴露但不露点
脚: 有脚则写朝向/脚掌/袜鞋；无脚写「画面未出现脚」
配饰: …
姿势: 姿态+手势+重心（必须含手部动作）
背景: 床品颜色褶皱 + ≥2 可见小物件（柜/手办/灯/窗帘/绿植等）
光影: …
表情: 眼神嘴角怎么动（勿用空泛心情词代替）
心情: 根据场景姿势灯光自行推断的内在情绪（禁止只写「伤心/开心」）
气质: 萌妹娇羞粘人东亚感
皮肤: 毛孔自然纹理少磨皮，禁止塑料脸
人种: 东亚中日韩
胸型: …（可见则写）
臀型: …（可见则写）
体毛: 白虎|稀疏|适中|浓密（按图+年龄气质）
```

### 1.3 关键锁（东亚）

**朝向 / 惯用手**  
观众视角左右与参考一致；持物左右手禁止镜像。

**发型**  
刘海形状、遮眼、层次、蓬松、是否扎发写清；参考是散乱长发就禁止擅自改成丸子头。

**服装品类**（优先于「更暴露」）  
比基尼就是比基尼上下装；禁止把下装改成短裙/掀裙。  
「更暴露」只在同品类内：细带更窄、剪裁更高、多露腰腹，禁止露点。

**足部**  
脚入镜时必须 `脚:` + 姿势里强调前景；禁止缩成底边小尖；无鞋禁止乱加高跟鞋。

**背景**  
禁止只写「卧室」；必须有床品颜色/褶皱 + ≥2 小物件。

**心情 ≠ 表情**  
- 表情：眼睛嘴巴怎么动。  
- 心情：场景推断的内在情绪，如「暖光里的慵懒安心」「镜头前的微羞期待」。  
- 禁止空泛：伤心、开心、难过、快乐、生气、平静、无聊、害羞（单独两字）、可爱、性感。

**写实去 AI 味**  
`style_tags` 建议：`写实`、`写真`、`皮肤纹理`、`少磨皮`。  
`皮肤:` 写毛孔/自然纹理；禁止塑料磨皮脸、二次元大眼过度美颜。

**阴毛**  
`体毛:` 在 白虎 / 稀疏 / 适中 / 浓密 中择一；年轻幼态可偏稀疏或白虎，偏成熟可更浓。

### 1.4 性格 / 性癖（可写细，50–80 字）

- 萌系性格短语 8～12 条（超可爱/软萌/娇羞/粘人/撒娇等扩写）。  
- 必含：`对话风格:Chloe`、`职业:…`、**恰好 5 条** `性癖:…`。  
- 性癖 = 生理/性行为偏好（足交/被口/SM/骑乘等），禁止「喜欢被夸奖」假性癖。

### 1.5 本地 `portrait_prompt` 顺序（中文 320–580 字，不送服）

1. 东亚锁 + 朝向/惯用手 + 构图姿势  
2. 有脚则写足部构图  
3. 发型发质  
4. 服装品类锁 + 同品类内更暴露不露点  
5. 背景小物件  
6. 五官表情 + 心情 + 气质 + 一句阴毛  
7. 写实锁：真人 cosplay 摄影、毛孔、少磨皮、禁止塑料脸  

---

## 二、欧美 / 欧洲角色（在东亚规则上的微调）

**外观复刻、服装锁、背景、心情、写实、足部等规则与东亚相同**，只改下面几项：

| 项 | 东亚 | 欧美 |
|---|---|---|
| `ancestry_region` | `east_asian` | `western` |
| `ancestry_tags` | 东亚裔… | **欧洲裔** 等 |
| `language` | `zh-CN` | **`en-US`** |
| `display_name` | 中文 2～3 字；提示词已点名则用提示词 | **英文** First / First Last；**提示词已点名（如黑寡妇 / Black Widow）则强覆盖，禁止随机英文名** |
| `人种` / 东亚锁 | 东亚中日韩 + 禁止欧美五官 | **不要**写东亚锁；锁参考欧美五官身份 |
| 气质 | 萌妹娇羞粘人 | 写实模特气场，勿刷东亚萌妹词 |
| `appearance_tags` / 性癖 / `portrait_prompt` | 中文 | **仍可用中文**（工具识图更稳） |

示例差异：

```json
{
  "ancestry_region": "western",
  "ancestry_tags": ["欧洲裔"],
  "agent_prompt_settings": {
    "language": "en-US",
    "voice_style": "casual",
    "voice_profile_key": "builtin_eve"
  },
  "display_name": "Nora Hale",
  "appearance_tags": [
    "发型:金棕大波浪，侧分刘海，发丝蓬松",
    "五官:深邃眉眼，高鼻梁，唇峰清晰",
    "心情:镜头前被注视时的从容与轻挑期待",
    "皮肤:毛孔自然纹理少磨皮，禁止塑料脸"
  ]
}
```

Lovemi Auto 后处理会强制：欧美 → `language=en-US` + 英文名池；东亚 → `zh-CN` + 中文名池。

---

## 三、分析模型 System Prompt（完整版 · 与代码同步）

以下为当前 `ANALYZE_SYSTEM` 核心策略摘要，实现以 `electron/lovemiCreateChar.ts` 为准。

```
You are a senior character TD for Lovemi.ai (adult products only).
Output ONE raw JSON only.

LENGTH:
- personality / 性癖: 50–80 chars each; exactly 5 性癖
- appearance: 20–72 chars each (max 80), aim 18–26 tags; no filler pad
- portrait_prompt: 320–580 Chinese LOCAL ONLY (never sent to Lovemi)

MUST appearance: 朝向 惯用手 发型 发质 服装(上下装品类) 露肤度 脚 配饰 姿势 背景 表情 心情 气质 皮肤 光影 体毛

CLOTHING IDENTITY > 更暴露: same garment type; never rewrite bikini bottoms as 短裙
BACKGROUND: sheet color/wrinkles + ≥2 props
MOOD: scene-inferred; forbid bare 伤心/开心/难过/害羞
REALISM: 写实+写真+皮肤纹理; pores/少磨皮; no plastic AI face

East Asian: language zh-CN; Chinese name; 东亚锁
Western: language en-US; English name; Chinese OK for appearance tags
```

---

## 四、创建送服前会做的事

1. 删除 `portrait_prompt`、`ancestry_region`（本地字段）。  
2. 短外观 clamp（颜色只留 `#RRGGBB`）。  
3. 去掉「立绘提示词:」长文（否则易 `PROMPT_COMPILATION_FAILED`）。  
4. 东亚补可爱/写实短 tag；欧美强制 `en-US` + 英文名。

---

## 五、好例子 vs 坏例子（外观）

**好**

```
服装:白细带比基尼上衣+同色三角比基尼下装
背景:浅灰褶皱床单，暖灯手办柜，右侧电视
心情:暖黄柜灯下慵懒又微羞的安心感
皮肤:毛孔自然纹理少磨皮，禁止塑料脸
```

**坏**

```
服装:白色细带比基尼上衣，低腰短裙感下装   ← 品类被改掉
背景:卧室床铺场景                         ← 太空
心情:伤心                                 ← 空泛
皮肤:很白很光滑                           ← 易磨皮 AI 味
```
