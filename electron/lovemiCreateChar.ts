import { createHash, randomUUID, randomInt as cryptoRandomInt } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { fetch as undiciFetch } from 'undici'
import { dispatcherFor } from './mailProbe'
import { loadCreateCharSecrets, saveCreateCharSecrets } from './createCharSecrets'
import { appendConsoleLog } from './consoleDb'

const LOVEMI = 'https://api.lovemi.ai'

function teamoHeaders(apiKey: string) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
}

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>
          if (typeof p.text === 'string') return p.text
          if (typeof p.content === 'string') return p.content
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object') {
    const o = content as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
  }
  return ''
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    /* continue */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim()) as Record<string, unknown>
    } catch {
      /* continue */
    }
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const slice = trimmed.slice(start, end + 1)
    try {
      return JSON.parse(slice) as Record<string, unknown>
    } catch {
      // trailing commas / soft fix
      try {
        return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')) as Record<string, unknown>
      } catch {
        return null
      }
    }
  }
  return null
}

const ANALYZE_SYSTEM = `You are a senior character TD for Lovemi.ai (adult products only).
Look at the reference image and output ONE raw JSON object only. No markdown fences. No commentary.

LENGTH BUDGET（分字段，别一刀切）:
- personality_tags: 8–12 条萌系性格短语（每条 **50–80**）+ 「对话风格:Chloe」+ 「职业:…」+ **恰好 5 条「性癖:…」**（每条 **50–80**）。← 给人设/对话用，可写细
- tag_items / occupation_tags / ancestry_tags / style_tags / relationship_tags: **保持短**（官网风格，几字到二十来字），禁止硬扩。
- appearance_tags: **短但密**（单条建议 **20–72 字**，硬上限 80；禁止灌水凑字）。用**多条**拆细节，目标约 **18–26 条**。必含：背景、姿势(含手)、表情、**心情**、服装(上下装品类)、皮肤、脚(有则写)、配饰。尽量再补：发色/瞳色/肤色(#RRGGBB)、体型、光影。禁止「立绘提示词:」。
- portrait_prompt: **仅本工具本地草稿**（320–580 字），创建时 **不会** 发给 Lovemi；生图只吃短 appearance_tags + 服务端 prompt_enhancement。

Schema (required keys):
{
  "creation_source": "blank",
  "display_name": "name without digits",
  "age_statement": "adult (NN)" NN=20-28,
  "gender_expression": "female"|"male"|"non_binary",
  "agent_prompt_enhancement": true,
  "agent_prompt_settings": {"language":"zh-CN"|"en-US","voice_style":"casual","voice_profile_key":"builtin_eve"},
  "ancestry_tags": ["欧洲裔"|"东亚裔"|...],
  "appearance_tags": [
    "发型:具体（刘海/遮眼/层次/蓬松/长度/扎发；禁止擅自改发型）",
    "发质:卷直纹理光泽凌乱度",
    "发色:#RRGGBB",
    "瞳色:#RRGGBB",
    "肤色:#RRGGBB",
    "体型:可见体型",
    "五官:脸型眉眼鼻唇辨识点",
    "妆容:眼妆腮红唇色",
    "朝向:身体与脸相对镜头左右（观众视角，禁止镜像）",
    "惯用手:持物左/右手（观众视角）",
    "服装:上装+下装品类颜色与参考一致，仅同品类内更暴露，禁止换品类/露点",
    "露肤度:比参考更暴露但不露点",
    "脚:有脚则细写朝向/脚掌/袜鞋；无脚写「画面未出现脚」",
    "配饰:头饰耳饰袜鞋等；无鞋禁止乱加高跟鞋",
    "姿势:姿态+手势+重心（必须含手部动作，与朝向/惯用手一致）",
    "背景:床品颜色褶皱+≥2可见小物件（柜/手办/灯/窗帘/绿植等）",
    "光影:主光方向软硬与冷暖",
    "表情:眼神嘴角（可见面部动作，勿用空泛心情词代替）",
    "心情:根据场景姿势灯光与氛围自行推断的内在情绪（必填，见下方规则）",
    "气质:萌妹娇羞粘人气质锁",
    "皮肤:毛孔自然纹理少磨皮，禁止塑料脸",
    "胸型:可见则写",
    "臀型:可见则写",
    "体毛:阴毛浓密度（白虎/稀疏/适中/浓密）按参考图年龄气质写"
  ],
  "fantasy_species_tags": [],
  "occupation_tags": ["..."],
  "personality_tags": ["超可爱…短语","萌妹…","软萌…","甜美…","娇羞…","粘人…","撒娇…","对话风格:Chloe","职业:…","性癖:…×5"],
  "relationship_tags": ["从下方关系池随机选 1 个，不要永远陌生人"],
  "style_tags": ["写实","写真","皮肤纹理"],
  "supported_lab_apps": ["companion","intimacy_lab","galgame","adult_film_director"],
  "custom_parameter_access_level": "basic",
  "tag_items": ["short","labels","超可爱","萌妹","软萌","东亚","中日韩","可见服饰材质关键词"],
  "tag_selections": [{"kind":"preset","preset_id":"gender.female"},{"kind":"preset","preset_id":"style.realistic"}],
  "ancestry_region": "east_asian"|"western"|"other",
  "portrait_prompt": "精炼中文立绘提示词 320–580 字，见下方规则"
}

PERSONALITY RULES:
- 多写可爱萌系：从 超可爱/萌妹/软萌/甜美/娇羞/粘人/撒娇/依赖感/想被抱抱/可爱到犯规/娇软/娇滴滴 等里选 **8–12 个**，每个扩成 **50–80 字** 短语（禁止只写两三个字）。
- MUST include 对话风格:Chloe、职业:…、**exactly 5** 性癖:…（每条 50–80 字）。

SEXUAL KINK RULES（性癖 = 生理/性需求，不是性格）：
- personality_tags MUST include **5** tags starting with「性癖:」——具体成人偏好，每条全文 **50–80 字**。
- 性癖 means what they want sexually (acts, body focus, power dynamics) — NOT everyday personality.
- FORBIDDEN as 性癖: 喜欢被夸奖、害羞、粘人、撒娇、温柔、腹黑、傲娇、社恐、怕黑、爱干净、喜欢吃甜食 等。
- GOOD examples (each already in the 50–80 band; pick 5 varied):
  性癖:喜欢给男朋友足交，用足底与脚趾慢慢磨蹭挑逗，看他忍不住的表情会更兴奋
  性癖:享受被口到腿软发颤，会主动按着对方的头不让离开，余韵里还想再来
  性癖:轻微SM，喜欢被绑住手腕后轻咬锁骨和耳垂，越害羞身体越诚实
  性癖:乳交与被玩弄乳头会很快湿，喜欢被盯着胸部用脏话说出来
  性癖:喜欢骑乘位自己摇腰，边做边盯着对方失神的脸，控制节奏的感觉上瘾
  性癖:高潮后还想被内射，余韵里软着声音求再深一点、再来一次
  性癖:喜欢在镜子前被后入，被迫看着自己潮红的脸和交合处，羞耻感会立刻更湿
  性癖:耳边脏话和命令式语气会立刻兴奋，越被说骚越想被抱紧用力
- Keep it adult, specific, and character-flavored.

NAME RULES:
- **USER HINT OVERRIDES EVERYTHING (strongest rule):** If user notes already specify the character identity / name / role (e.g. 黑寡妇、Black Widow、Natasha、叫小雪、角色是林婉), display_name MUST be that identity (as written, or the clear canonical form). Do NOT invent a random pool name. Do NOT ignore 黑寡妇 just because ancestry is western.
- East Asian (only when hint has NO explicit character/name): UNIQUE cute **Chinese** girl name (2 **or** 3 汉字). NEVER reuse 柚子/千夏/陽葵/芽衣/宁宁/瑾萱/葵/琴音.
- Western / European (only when hint has NO explicit character/name): UNIQUE **English** name (Latin letters; First or First Last). Never Chinese characters in display_name.
- The app replaces display_name from an unused pool ONLY when the user hint does NOT name a character; never blank; NO digits.

RELATIONSHIP RULES:
- relationship_tags MUST be exactly ONE string randomly chosen from:
  ["陌生人","青梅竹马","同事","邻居","网友","合租室友","暗恋对象","学长学妹","前同事","偶遇","粉丝","笔友","社团同伴","远房表亲","上下级","客户"]
- Do NOT always use 陌生人. Vary across runs.

CRITICAL — Lovemi 官网 create 的 appearance_tags 是短结构化标签（发型/体型/三色等），生图靠 prompt_enhancement 扩写。
不要把长「立绘提示词」塞进 appearance_tags（会被截到约 80 字且易 PROMPT_COMPILATION_FAILED）。
长中文立绘写在独立字段 portrait_prompt（仅本工具草稿/对照用）。
So appearance_tags MUST lock the reference with **dense SHORT** Chinese labels (prefer **20–72 chars** each, hard max 80; NEVER pad with filler like「细节写清」). Split facts across many tags instead of one vague line:
- Never output bare face/hair only.
- ORIENTATION LOCK (critical): describe left/right from the VIEWER's perspective. If reference holds phone in RIGHT hand, tags must say 右手持手机 — NEVER mirror to left. If body leans / face turns to viewer's right, write that side explicitly. Add tags 朝向:… and 惯用手:…. Forbid 左右镜像 / mirrored pose.
- HAIR LOCK (critical): 发型 tag must be HIGH DETAIL — bangs shape, which eye covered, layers, volume/messiness, strand fall, whether hair is tied. Do NOT invent a top bun / odango / neat idol cut if the reference is loose messy voluminous hair. Add 发质:… for texture.
- FOOT / 足 LOCK (critical — models often DROP feet):
  - If ANY foot/sole/toe/ankle/socked-foot/shoe is visible in the reference (even at frame bottom), you MUST output a dedicated short tag 脚:… AND strengthen feet in 姿势 + portrait_prompt.
  - Describe: 脚是否朝镜头、脚掌/脚心是否朝向观众、脚趾并拢还是张开、脚在画面前景还是被裁切、是否穿丝袜/裤袜/裸足、有无鞋（种类）、袜的材质颜色覆盖到哪。
  - If feet are a FOCAL point in the reference (large in foreground, soles facing camera, between camera and body), write explicitly: 脚部前景占比大、足部是构图重点、低机位突出脚掌/脚心 — NEVER shrink feet to tiny tips at the bottom edge.
  - NEVER invent 高跟鞋 / sandals / boots if reference has no shoes (e.g. only lace tights covering feet). Match 袜 vs 鞋 exactly.
  - If no feet visible at all, 脚:画面未出现脚.
- CLOTHING IDENTITY LOCK（比「更暴露」更优先）:
  - 上下装**品类**必须与参考图一致：比基尼就是比基尼上下装，内裤/三角裤就是内裤，连衣裙就是连衣裙。禁止把比基尼下装改成短裙/裤裙/掀开裙摆。
  - 「更暴露」只能在**同品类内**微调：细带更窄、剪裁更高、贴身更紧、腰腹多露一点；禁止换品类、禁止扯开遮挡导致露点/外阴暴露。
  - 服装 tag 必须同时写清上装+下装品类与颜色（例：白细带比基尼上衣+同色三角比基尼下装）。
- BACKGROUND DETAIL LOCK:
  - 背景禁止只写「卧室/床铺」。必须点出 ≥2 个可见小物件：床品颜色与褶皱、柜内手办/灯带、电视、床上散落衣物等。
- REALISM / 去 AI 味 LOCK（critical）:
  - style_tags 必须含：写实、写真、皮肤纹理（可加 少磨皮）。
  - appearance 加 皮肤:毛孔自然纹理少磨皮，禁止塑料脸。
  - 禁止二次元大眼磨皮、塑料感皮肤、过度美颜。要像真人 cosplay 摄影。
- MOOD / 心情 LOCK（critical — 与「表情」分开）:
  - appearance_tags MUST include 心情:… —— 根据场景、姿势、光线、服装暴露度、是否闭眼、与镜头关系等**自行推断**当下内在情绪。
  - 写具体可感的心情短语（约 16–40 字），例如：被暖光包裹的慵懒安心、镜头前的微羞期待、独处时的放松放空、被注视时的心跳加速。
  - FORBIDDEN 空泛单字/两字心情：伤心、开心、难过、快乐、生气、平静、无聊、害羞（单独两字也不行）、可爱、性感。
  - 心情 ≠ 表情：表情写眼睛嘴巴怎么动；心情写「为什么像这样、此刻心里在酝酿什么」。
- 服装 / 配饰 / 姿势 / 背景 / 表情 / 心情 / 气质 / 脚 / 皮肤 are MANDATORY.
- 五官 / 妆容 are MANDATORY and must describe visible, reference-specific details rather than generic beauty words.
- CLOTHING EXPOSURE: keep the reference outfit **identity** (same garment types/colors/accessories) but make it mildly MORE revealing within that identity — deeper cut of same bikini, thinner straps, more waist skin. NEVER nipples / areola / 露点 / fully bare breasts / transparent over nipples / pubic exposure. Add 露肤度:….

REGION RULES:
- East Asian / 东亚 / 中日韩 (CRITICAL — models love drifting to Western faces):
  - ancestry_region MUST be "east_asian"
  - ancestry_tags MUST include "东亚裔" (and may add 华裔/日系/韩系 if look matches)
  - appearance_tags lock once: 人种:东亚中日韩 + 五官含东亚脸型 + 一条「禁止欧美五官」即可（勿重复刷屏）
  - portrait_prompt 开头写死东亚中日韩面孔/五官，文中再点一次即可，勿整段反复同义
  - 气质: 萌妹娇羞粘人东亚感. Expression cute/shy — NOT cold Western model / Caucasian deep-set eyes
  - If reference is East Asian, NEVER output western / european / mixed Caucasian identity
- Western / 欧美:
  - ancestry_region MUST be "western"
  - agent_prompt_settings.language MUST be **"en-US"**（不是 zh-CN）
  - display_name MUST be UNIQUE **English** (First or First Last, Latin letters only, NO digits). e.g. Ava Brooks / Nora Hale
  - appearance_tags / personality / 性癖 / portrait_prompt 仍可用**中文**写细节；只把 language + 显示名改成英文
  - PERFECT identity lock — photoreal fidelity；气质偏写实模特，勿刷东亚萌妹模板
  - ancestry_tags 用「欧洲裔」等；勿写「东亚中日韩」

BODY HAIR / 阴毛 RULES（按图与年龄气质推断，允许白虎）:
- appearance_tags MUST include 体毛:…，浓密度从：白虎(全剃光滑) / 稀疏 / 适中 / 浓密 中选一个最贴图的。
- 推断优先：① 参考图耻丘/腿根若能看出有无毛、疏密，按可见写；② 看不出时按年龄气质：刚成年/娃娃脸/幼态成人感 → 稀疏或白虎；年龄感偏成熟（二十中后/脸更成熟）→ 适中或浓密。
- 白虎完全可以，只要符合图或年龄气质；不要一律写浓密，也不要一律写白虎。
- portrait_prompt 末尾一句即可，例如：阴毛稀疏贴肤 / 阴毛白虎光滑 / 阴毛适中偏浓量感可见。

portrait_prompt RULES (Chinese, for Lovemi 立绘 tag):
ONE paragraph 320–580 字. Dense facts, no filler. Order:
1) 东亚锁（若东亚）+ 朝向/惯用手 + 构图姿势
2) 有脚则写足部构图；无脚跳过
3) 发型发质（关键辨识点，勿叠形容词）
4) 服装：上下装品类颜色与参考一致，仅同品类内更暴露，禁止改成短裙或乱换下装，禁止露点
5) 背景：床品颜色褶皱 + ≥2 个可见小物件（手办柜灯带/电视/床上织物等）
6) 五官表情 + 心情（场景推断的内在情绪，禁止空泛「伤心/开心」）+ 气质 + 一句阴毛浓密度（露肤时，按上规则）
7) 写实摄影锁死：真人 cosplay 照片感，皮肤毛孔与自然阴影可见，少磨皮，禁止 AI 塑料脸/二次元大眼过度磨皮
Do NOT wrap in「立绘提示词:」prefix.
Say once: 比参考图更暴露但不露点.
Adult only. Prefer 写实.`

function ensureTagged(list: string[], prefix: string, fallback: string) {
  if (!list.some((t) => t.startsWith(prefix))) list.push(`${prefix}${fallback}`)
}

function analyzeDetailIssues(payload: Record<string, unknown>, portraitPrompt: string): string[] {
  const tags = Array.isArray(payload.appearance_tags)
    ? (payload.appearance_tags as unknown[]).map(String)
    : []
  const issues: string[] = []
  // appearance 走官网短标签；只要求「有内容」，不要逼到 50+（否则易 PROMPT_COMPILATION_FAILED）
  const required: Array<[string, number]> = [
    ['发型:', 10],
    ['发质:', 6],
    ['五官:', 8],
    ['妆容:', 6],
    ['朝向:', 6],
    ['惯用手:', 4],
    ['服装:', 14],
    ['露肤度:', 6],
    ['脚:', 6],
    ['配饰:', 6],
    ['姿势:', 10],
    ['背景:', 14],
    ['表情:', 6],
    ['心情:', 12],
    ['气质:', 4],
    ['皮肤:', 8],
  ]
  for (const [prefix, minLength] of required) {
    const hit = tags.find((tag) => tag.startsWith(prefix))
    if (!hit) issues.push(`缺少 ${prefix}`)
    else if (hit.length < minLength) issues.push(`${prefix}细节不足`)
  }
  const mood = tags.find((t) => t.startsWith('心情:')) || ''
  if (mood && /^(心情:)?\s*(伤心|开心|难过|快乐|生气|平静|无聊|害羞|可爱|性感)\s*$/.test(mood.replace(/\s/g, ''))) {
    issues.push('心情过于空泛，需按场景推断具体情绪')
  }
  if (mood && /伤心|难过|痛苦|哭泣/.test(mood) && !/慵懒|安心|期待|放空|微羞|心动|沉浸|放松/.test(mood)) {
    // 允许复杂描述里带负面词，但单独「伤心」系空泛要拦；上面已拦纯两字。此处仅拦极短伤心句
    if (mood.length < 18) issues.push('心情不要只写伤心类空词，按场景写具体')
  }
  const cloth = tags.find((t) => t.startsWith('服装:')) || ''
  if (cloth && /短裙|裤裙|迷你裙/.test(cloth) && /比基尼|泳装/.test(tags.join('｜'))) {
    issues.push('服装品类冲突：参考像比基尼却写成短裙')
  }
  if (cloth && !/(上|下|比基尼|裙|裤|内衣|制服|连衣裙|连体)/.test(cloth)) {
    issues.push('服装未写清上下装品类')
  }
  const bg = tags.find((t) => t.startsWith('背景:')) || ''
  if (bg && !/(手办|柜|灯|电视|床|褶皱|墙|枕|毯|窗帘)/.test(bg)) {
    issues.push('背景缺少可见小物件')
  }
  const style = Array.isArray(payload.style_tags) ? (payload.style_tags as unknown[]).map(String).join('｜') : ''
  if (!/写实|写真|皮肤/.test(style) && !tags.some((t) => t.startsWith('皮肤:'))) {
    issues.push('缺少写实/皮肤纹理锁')
  }
  const genericCount = tags.filter((tag) => /复刻参考图|与参考图一致|保持原样/.test(tag)).length
  if (genericCount >= 3) issues.push('泛化描述过多，必须写出实际可见细节')
  if (portraitPrompt.length < 250) issues.push('portrait_prompt 少于 250 字')
  if (portraitPrompt && !/毛孔|皮肤纹理|少磨皮|写实摄影|写真/.test(portraitPrompt)) {
    issues.push('portrait_prompt 缺少写实皮肤锁')
  }
  const detailedTags = tags.filter((tag) => tag.length >= 16 && tag.length <= 80).length
  if (detailedTags < 6) issues.push('可用外观标签不足 6 条')
  return issues
}

function requiredPayloadIssues(payload: Record<string, unknown>): string[] {
  const issues: string[] = []
  if (typeof payload.display_name !== 'string' || !payload.display_name.trim()) issues.push('缺少 display_name')
  if (typeof payload.age_statement !== 'string') issues.push('缺少 age_statement')
  if (!['female', 'male', 'non_binary'].includes(String(payload.gender_expression || ''))) {
    issues.push('gender_expression 无效')
  }
  for (const key of [
    'ancestry_tags',
    'appearance_tags',
    'occupation_tags',
    'personality_tags',
    'relationship_tags',
    'style_tags',
    'supported_lab_apps',
    'tag_items',
    'tag_selections',
  ]) {
    if (!Array.isArray(payload[key])) issues.push(`缺少 ${key}`)
  }
  if (!payload.agent_prompt_settings || typeof payload.agent_prompt_settings !== 'object') {
    issues.push('缺少 agent_prompt_settings')
  }
  return issues
}

function pushUnique(list: string[], items: string[]) {
  for (const item of items) {
    if (!list.some((x) => x === item || x.includes(item))) list.push(item)
  }
}

/** Lovemi 生图更吃短 tag：补齐服装/姿势/背景/萌系气质（外观保持短，勿凑 50 字） */
function reinforceVisualAndCuteTags(payload: Record<string, unknown>, isEast: boolean) {
  const appearance = Array.isArray(payload.appearance_tags)
    ? (payload.appearance_tags as unknown[]).map(String)
    : []
  ensureTagged(appearance, '服装:', '上下装品类与参考一致，仅同品类内更暴露，禁止换品类露点')
  ensureTagged(appearance, '露肤度:', '比参考更暴露但不露点')
  ensureTagged(appearance, '配饰:', '复刻头饰配饰手套袜鞋，无鞋禁止加高跟鞋')
  ensureTagged(appearance, '姿势:', '复刻站坐姿与手势重心，禁止左右镜像')
  ensureTagged(appearance, '朝向:', '观众视角左右与参考一致，禁止镜像')
  ensureTagged(appearance, '惯用手:', '持物左右手与参考一致')
  ensureTagged(appearance, '发型:', '复刻刘海层次蓬松碎发，禁止擅自改扎发')
  ensureTagged(appearance, '发质:', '复刻发丝纹理与凌乱蓬松度')
  ensureTagged(
    appearance,
    '五官:',
    isEast ? '东亚脸型眼型鼻唇按参考锁定' : '脸型眼型鼻唇按参考锁定',
  )
  ensureTagged(appearance, '妆容:', '按参考锁定眼妆腮红唇色')
  ensureTagged(appearance, '背景:', '床品颜色褶皱+柜/手办/灯等可见小物件')
  ensureTagged(appearance, '皮肤:', '毛孔自然纹理少磨皮，禁止塑料脸')
  ensureTagged(
    appearance,
    '表情:',
    isEast ? '复刻眼神嘴角，东亚萌妹娇羞或勾人直视' : '复刻眼神嘴角与情绪',
  )
  ensureTagged(
    appearance,
    '心情:',
    '按场景姿势与光线自行推断的当下情绪，写具体可感，禁止空泛伤心开心',
  )
  ensureTagged(
    appearance,
    '气质:',
    isEast ? '超级可爱软萌娇羞粘人萌妹感' : '完美复刻参考气质',
  )
  // 极短条目补一点可见细节，但仍 ≤72，绝不灌水凑 50
  const thicken = (prefix: string, minLen: number, rich: string) => {
    const i = appearance.findIndex((t) => t.startsWith(prefix))
    if (i < 0) return
    if (appearance[i].length < minLen) {
      appearance[i] = clampAppearanceTagLen(`${prefix}${rich}`, 72)
    }
  }
  thicken('背景:', 18, '床品颜色褶皱，窗帘或柜内手办灯带等可见小物件写清')
  thicken('表情:', 12, isEast ? '复刻眼神嘴角，萌妹娇羞或勾人直视' : '复刻眼神嘴角与情绪')
  thicken('心情:', 16, '由场景推断的内在情绪，具体可感，禁止空泛两字心情词')
  thicken('姿势:', 16, '复刻站坐姿与双手手势重心落点，禁止左右镜像')
  thicken('服装:', 18, '上下装品类颜色材质与参考一致，仅同品类内更暴露')
  thicken('皮肤:', 14, '毛孔自然纹理少磨皮，禁止塑料磨皮脸')
  // 空泛心情纠偏
  const moodIdx = appearance.findIndex((t) => t.startsWith('心情:'))
  if (moodIdx >= 0) {
    const body = appearance[moodIdx].replace(/^心情:/, '').trim()
    if (
      !body ||
      body.length < 10 ||
      /^(伤心|开心|难过|快乐|生气|平静|无聊|害羞|可爱|性感)$/.test(body)
    ) {
      appearance[moodIdx] = clampAppearanceTagLen(
        '心情:由场景姿势光线推断的当下内在情绪，写具体可感层次，禁止空泛两字心情',
        72,
      )
    }
  }
  ensureTagged(appearance, '光影:', '复刻主光方向与冷暖软硬')
  // 若服装写成短裙但文案里已有比基尼暗示，纠回品类锁（避免「穿着内裤却生成短裙」）
  const clothIdx = appearance.findIndex((t) => t.startsWith('服装:'))
  if (clothIdx >= 0 && /短裙|裤裙|迷你裙/.test(appearance[clothIdx])) {
    appearance[clothIdx] = clampAppearanceTagLen(
      '服装:上下装品类锁死与参考一致，禁止改成短裙，仅同品类内更暴露不露点',
      72,
    )
  }
  ensureTagged(appearance, '脚:', '有脚则写朝向/脚掌/袜鞋；无脚写画面未出现脚')
  pushUnique(appearance, [
    '禁止左右镜像',
    '发型细节锁死禁止简化',
    '禁止露点',
    '禁止透明到乳头',
    '服装品类与参考一致禁止乱换',
    '足部细节锁死禁止省略',
    '禁止擅自添加高跟鞋',
    '禁止AI塑料磨皮脸',
  ])

  // 若姿势/配饰已暗示有脚，强化脚部前景，并去掉乱加的鞋类（保留袜）
  const blob = appearance.join('｜')
  const feetLikely =
    /脚|足|脚掌|脚心|脚趾|丝袜|裤袜|蕾丝袜|裸足|鞋|坐|双腿|大腿/.test(blob) &&
    !/脚:画面未出现脚/.test(blob)
  if (feetLikely) {
    const footIdx = appearance.findIndex((t) => t.startsWith('脚:'))
    const strongFoot =
      '脚:足部前景保留，朝向/脚掌脚心/袜或鞋与参考一致，禁止缩脚或乱加高跟鞋'
    if (footIdx >= 0) {
      const cur = appearance[footIdx]
      if (cur.length < 12 || /未出现/.test(cur) || !/前景|脚掌|脚心|足|袜|鞋/.test(cur)) {
        appearance[footIdx] = strongFoot
      }
    } else {
      appearance.push(strongFoot)
    }
    // 配饰里若同时有蕾丝袜/裤袜覆盖脚 + 高跟鞋，倾向删掉擅自加鞋（参考常见是袜足无鞋）
    for (let i = 0; i < appearance.length; i++) {
      if (!appearance[i].startsWith('配饰:')) continue
      if (/蕾丝袜|裤袜|丝袜|连裤袜/.test(appearance[i]) && /高跟|凉鞋|靴子/.test(appearance[i])) {
        appearance[i] = appearance[i]
          .replace(/[，,]?\s*透明感高跟鞋/g, '')
          .replace(/[，,]?\s*高跟鞋/g, '')
          .replace(/[，,]?\s*凉鞋/g, '')
          .replace(/无鞋[^，,]*/g, '无鞋')
        if (!/无鞋|裸足袜|袜足/.test(appearance[i])) {
          appearance[i] = `${appearance[i]}，足部为袜足无鞋`
        }
      }
    }
    pushUnique(appearance, ['构图:足部前景重点', '禁止弱化脚部'])
  }
  if (isEast) {
    pushUnique(appearance, [
      '人种:东亚中日韩',
      '五官:东亚脸型小巧精致',
      '禁止欧美五官',
    ])
    ensureTagged(appearance, '人种:', '东亚中日韩')
    ensureTagged(appearance, '五官:', '东亚脸型，不是欧美深邃五官')
  }
  ensureBodyHairTag(appearance, payload)
  payload.appearance_tags = appearance

  // 去重 + 统一长度上限：避免 prompt compiler 因重复/超长 tag 直接失败
  const clamped = appearance.map((t) => clampAppearanceTagLen(t))
  payload.appearance_tags = dedupeExactStrings(clamped)

  const personality = Array.isArray(payload.personality_tags)
    ? (payload.personality_tags as unknown[]).map(String)
    : []
  // 不再自动堆叠“萌妹模板词”，保留用户原始人格描述，减少 AI 味。
  payload.personality_tags = personality

  const items = Array.isArray(payload.tag_items) ? (payload.tag_items as unknown[]).map(String) : []
  if (isEast) pushUnique(items, ['东亚', '中日韩'])
  payload.tag_items = items
  prunePersonalityAndTagItems(payload)

  const style = Array.isArray(payload.style_tags) ? (payload.style_tags as unknown[]).map(String) : []
  pushUnique(style, ['写实', '写真', '皮肤纹理', '少磨皮'])
  if (isEast) pushUnique(style, ['东亚'])
  payload.style_tags = style

  if (isEast) {
    payload.ancestry_region = 'east_asian'
    const ancestry = Array.isArray(payload.ancestry_tags)
      ? (payload.ancestry_tags as unknown[]).map(String)
      : []
    pushUnique(ancestry, ['东亚裔'])
    // 去掉明显欧美跑偏标签
    const filteredAncestry = ancestry.filter(
      (t) => !/欧洲|欧美|高加索|western|caucasian|european/i.test(t),
    )
    payload.ancestry_tags = filteredAncestry.length ? filteredAncestry : ['东亚裔']
  }

  const relPool = [
    '陌生人',
    '青梅竹马',
    '同事',
    '邻居',
    '网友',
    '合租室友',
    '暗恋对象',
    '学长学妹',
    '前同事',
    '偶遇',
    '粉丝',
    '笔友',
    '社团同伴',
    '远房表亲',
    '上下级',
    '客户',
  ]
  // 关系每次随机，避免模型总锁「陌生人」
  payload.relationship_tags = [relPool[Math.floor(Math.random() * relPool.length)]]
}

/** 按语言/地区的可爱女孩名（大词库，避免连抽撞名） */
const NAME_POOL_ZH_SEED = [
  '之桃', '雨婷', '依依', '梦洁', '诗涵', '可馨', '婉儿', '若溪', '思甜',
  '语嫣', '清欢', '念安', '晚棠', '软软', '桃桃', '星河', '小满', '知夏', '初晴',
  '青柠', '糖糖', '糯米', '阿梨', '苏苏', '安安', '柠柠', '豆豆', '月月', '星子',
  '晚晚', '小鹿', '念念', '清清', '雪梨', '佳怡', '欣妍', '雨桐', '思涵', '雅淇',
  '可儿', '梦瑶', '梓涵', '一诺', '语桐', '诗琪', '晓彤', '佳宁', '心怡', '若曦',
  '沐橙', '听澜', '惜夏', '霜降', '青禾', '梨落', '枕星', '软糖',
  '蜜梨', '杏子', '棠梨', '苏茉', '澄澄', '欢喜', '拾光', '半夏',
  '微甜', '浅唱', '云舒', '晚风', '花序', '南枝', '北岛', '东篱',
  '夏禾', '秋拾', '春岚', '冬芽', '柔枝', '细雪', '轻舟', '浅夏', '暖冬',
  '青柠糖', '小团子', '蜜桃酱', '草莓味', '牛奶糖', '棉花糖', '布丁酱',
  '抹茶圆', '芝士球', '糯叽叽', '甜甜圈', '焦糖卷', '香芋泥', '芋泥球',
  '果果', '芽芽', '朵朵', '梨梨', '杏杏', '橙橙', '柠芽', '桃芝',
  '芝芝', '茉茉', '萱萱', '涵涵', '桐桐', '琪琪', '妍妍', '怡怡', '诺诺',
  '彤彤', '淇淇', '瑶瑶', '曦曦', '婉婉', '甜甜', '安可', '可甜', '可萌', '可心',
  '心心', '如意', '如初', '如愿', '如梦', '如雪', '如烟', '如画', '如歌', '如诗',
  '诗诗', '小棠', '小禾', '小岚', '小芽', '小澄', '小拾',
  '南南', '北北', '岚岚', '禾禾', '枝枝', '雪雪', '舟舟',
  '舒舒', '喜喜', '夏夏', '秋秋', '春春', '冬冬', '柔柔',
  '浅浅', '暖暖', '青青', '白柠', '青杏', '蜜杏', '蜜棠',
  '苏梨', '梨棠', '棠棠', '茉梨', '星枕', '枕枕', '糖梨',
  '软桃', '桃蜜', '晚星', '星晚', '清念', '语清', '嫣语',
  '思若', '若婉', '可诗', '诗梦', '梦依', '依雨', '知初',
  '林晚', '苏清', '沈念', '顾夏', '叶软', '温知', '江浅', '白禾',
  '楚棠', '唐梨', '陆杏', '乔澄', '纪岚', '阮芽', '裴柔', '安予',
  '言溪', '予安', '林拾', '苏半', '沈微', '顾浅', '叶初', '温星',
  '江月', '白秋', '楚春', '唐冬', '陆欢', '乔喜', '纪光', '阮舒',
  '裴诗', '安画', '言歌', '予烟', '林雪', '苏梦', '沈愿', '顾心',
  '叶甜', '温可', '江萌', '白心', '楚意', '唐宁', '陆依', '乔婉',
  '纪若', '阮思', '裴语', '安嫣', '言涵', '予萱', '林淇', '苏妍',
  '沈怡', '顾诺', '叶彤', '温瑶', '江曦', '白桐', '楚琪', '唐晴',
  '陆溪', '乔桃', '纪糖', '阮茉', '裴芝', '安橙', '言柠', '予杏',
  '晚清', '清软', '软念', '念知', '知半', '半拾', '拾浅', '浅微',
  '微初', '初星', '星月', '月禾', '禾棠', '棠梨', '梨杏', '杏澄',
  '澄岚', '岚芽', '芽柔', '柔细', '细轻', '轻暖', '暖青', '青南',
  '南枝', '枝秋', '秋春', '春冬', '冬欢', '欢喜', '喜光', '光舒',
  '舒诗', '诗画', '画歌', '歌烟', '烟雪', '雪梦', '梦愿', '愿心',
  '心甜', '甜可', '可萌', '萌安', '安宁', '宁依', '依婉', '婉若',
  '若思', '思语', '语嫣', '嫣涵', '涵萱', '萱淇', '淇妍', '妍怡',
  '怡诺', '诺彤', '彤瑶', '瑶曦', '曦桐', '桐琪', '琪晴', '晴溪',
]

/** 组合生成：二字 + 大量三字，避免总是两字甜名 */
const ZH_PREFIX = [
  '林', '苏', '沈', '顾', '叶', '夏', '温', '江', '白', '楚', '唐', '陆', '乔', '纪', '阮',
  '裴', '卫', '安', '言', '予', '晚', '清', '软', '念', '知', '半', '拾', '浅', '微', '初',
  '星', '月', '禾', '棠', '梨', '杏', '澄', '岚', '芽', '柔', '青', '南', '北', '秋', '春',
  '冬', '欢', '喜', '光', '舒', '诗', '画', '烟', '雪', '梦', '愿', '心', '甜', '可', '萌',
]
const ZH_MID = [
  '晚', '清', '软', '念', '知', '半', '拾', '浅', '微', '初', '星', '月', '禾', '棠', '梨',
  '杏', '澄', '岚', '芽', '柔', '青', '南', '秋', '春', '冬', '欢', '喜', '光', '舒', '诗',
  '雪', '梦', '愿', '心', '甜', '可', '萌', '安', '宁', '依', '婉', '若', '思', '语', '嫣',
  '涵', '萱', '淇', '妍', '怡', '诺', '彤', '瑶', '曦', '桐', '琪', '晴', '溪', '桃', '糖',
]
const ZH_SUFFIX = [
  '晚', '清', '软', '念', '知', '半', '拾', '浅', '微', '初', '星', '月', '禾', '棠', '梨',
  '杏', '澄', '岚', '芽', '柔', '细', '轻', '暖', '青', '南', '枝', '秋', '春', '冬', '欢',
  '喜', '光', '舒', '诗', '画', '歌', '烟', '雪', '梦', '愿', '心', '甜', '可', '萌', '安',
  '宁', '依', '婉', '若', '思', '语', '嫣', '涵', '萱', '淇', '妍', '怡', '诺', '彤', '瑶',
  '曦', '桐', '琪', '晴', '溪', '桃', '糖', '茉', '芝', '橙', '柠', '满', '儿', '子', '酱',
]

const NAME_POOL_ZH_TRI_SEED = [
  '青柠糖', '小团子', '蜜桃酱', '草莓味', '牛奶糖', '棉花糖', '布丁酱',
  '抹茶圆', '芝士球', '糯叽叽', '甜甜圈', '焦糖卷', '香芋泥', '芋泥球',
  '林晚清', '苏念安', '沈知夏', '顾浅夏', '叶软糖', '温半夏', '江拾光', '白微甜',
  '楚初晴', '唐星河', '陆云舒', '乔晚棠', '纪梨落', '阮枕星', '裴春岚', '安冬芽',
  '言清欢', '予若溪', '林诗涵', '苏心怡', '沈若曦', '顾沐橙', '叶听澜', '温惜夏',
  '江青禾', '白棠梨', '楚苏茉', '唐欢喜', '陆浅唱', '乔细雪', '纪轻舟', '阮暖冬',
  '裴南枝', '安北岛', '言东篱', '予夏禾', '林秋拾', '苏柔枝', '沈花序', '顾星子',
  '叶小满', '温知夏', '江初晴', '白雪梨', '楚佳怡', '唐欣妍', '陆雨桐', '乔思涵',
  '纪雅淇', '阮可儿', '裴梦瑶', '安梓涵', '言一诺', '予诗琪', '林晓彤', '苏佳宁',
  '沈小棠', '顾小禾', '叶小岚', '温小芽', '江小澄', '白小拾', '楚糯米', '唐软糖',
  '陆蜜梨', '乔杏子', '纪澄澄', '阮晚晚', '裴念念', '安清清', '言甜甜', '予安安',
  '林可甜', '苏可萌', '沈可心', '顾如意', '叶如初', '温如愿', '江如梦', '白如雪',
  '楚如烟', '唐如画', '陆如歌', '乔如诗', '纪诗诗', '阮萱萱', '裴涵涵', '安瑶瑶',
  '言曦曦', '予婉婉', '林彤彤', '苏淇淇', '沈妍妍', '顾怡怡', '叶诺诺', '温桐桐',
  '江琪琪', '白茉茉', '楚芝芝', '唐橙橙', '陆柠芽', '乔桃芝', '纪芽芽', '阮朵朵',
  '裴果果', '安梨梨', '言杏杏', '予禾禾', '林岚岚', '苏枝枝', '沈雪雪', '顾舟舟',
  '叶舒舒', '温喜喜', '江夏夏', '白秋秋', '楚春春', '唐冬冬', '陆柔柔', '乔浅浅',
  '纪暖暖', '阮青青', '裴糖梨', '安星枕', '言枕枕', '予晚星', '林星晚', '苏清念',
  '沈语清', '顾嫣语', '叶思若', '温若婉', '江可诗', '白诗梦', '楚梦依', '唐依雨',
  '陆知初', '乔半夏', '纪拾光', '阮微甜', '裴浅夏', '安深秋', '言暖冬', '予青柠',
  '小清欢', '小若溪', '小诗涵', '小心怡', '小若曦', '小沐橙', '小听澜', '小惜夏',
  '阿清欢', '阿若溪', '阿诗涵', '阿心怡', '阿若曦', '阿沐橙', '阿半夏', '阿枕星',
]

function buildZhNamePool(): string[] {
  const set = new Set<string>([...NAME_POOL_ZH_SEED, ...NAME_POOL_ZH_TRI_SEED])
  // 二字：前缀×后缀
  for (const a of ZH_PREFIX) {
    for (const b of ZH_SUFFIX) {
      if (a === b) continue
      set.add(`${a}${b}`)
    }
  }
  // 三字：前缀×中字×后缀（去重、禁止三字全同）
  for (const a of ZH_PREFIX) {
    for (const m of ZH_MID) {
      for (const b of ZH_SUFFIX) {
        if (a === m && m === b) continue
        const n = `${a}${m}${b}`
        if (n.length === 3) set.add(n)
      }
    }
  }
  // 三字：小/阿 + 二字组合
  for (const t of ['小', '阿']) {
    for (const a of ZH_PREFIX.slice(0, 40)) {
      for (const b of ZH_SUFFIX.slice(0, 50)) {
        if (a === b) continue
        set.add(`${t}${a}${b}`)
      }
    }
  }
  // 三字叠音昵称：小晴晴 / 阿念念
  for (const t of ['小', '阿']) {
    for (const b of ZH_SUFFIX) {
      set.add(`${t}${b}${b}`)
    }
  }
  return [...set]
}

const NAME_POOL_ZH = buildZhNamePool()
const NAME_POOL_ZH_TWO = NAME_POOL_ZH.filter((n) => n.length === 2)
const NAME_POOL_ZH_THREE = NAME_POOL_ZH.filter((n) => n.length === 3)

const NAME_POOL_JP = [
  '美咲', '結衣', '凛', '咲良', '柚葉', '奈々',
  '美穂', '彩花', '優奈', '心春', '莉子', '桜', '紗季', '日向', '和泉',
  '花音', '美月', '玲奈', '愛梨', '真央', '香織', '七海', '彩乃', '陽菜',
  '結菜', '美羽', '里奈', '柚希', '愛菜', '美桜', '琴葉', '紗奈', '優花', '心結',
  '芽依', '桜花', '美優', '莉奈', '陽向', '和花', '彩月', '美鈴', '愛美', '真結',
  '香奈', '七緒', '彩葉', '陽香', '結月', '美音', '里桜', '柚奈', '愛羽',
]

const NAME_POOL_KR = [
  '智雅', '素妍', '敏知', '荷娜', '有真', '秀雅', '恩地', '多喜', '艺琳', '佳恩',
  '世娜', '知恩', '秀彬', '雨珍', '多恩', '夏琳', '惠娜', '智恩', '素英', '敏雅',
  '荷真', '有娜', '秀恩', '恩雅', '多琳', '艺娜', '佳真', '世恩', '知雅', '秀娜',
  '雨恩', '多雅', '夏娜', '惠恩', '智琳', '素娜', '敏恩', '荷雅', '有恩', '秀真',
]

const NAME_POOL_EN = [
  'Lily', 'Mia', 'Emma', 'Ava', 'Chloe', 'Nora', 'Iris', 'Ruby', 'Luna', 'Ella',
  'Zoe', 'Ivy', 'Nina', 'Cora', 'Sadie', 'Hazel', 'Aria', 'Mila', 'Layla',
  'Ellie', 'Stella', 'Violet', 'Aurora', 'Willow', 'Piper', 'Quinn', 'Remi', 'Skye', 'Tessa',
  'Willa', 'Zara', 'Bella', 'Daisy', 'Freya', 'Grace', 'Holly', 'June', 'Kate', 'Lacey',
  'Maya', 'Noelle', 'Olive', 'Pearl', 'Rosie', 'Sage', 'Tara', 'Uma', 'Vera', 'Wren',
  'Ava Brooks', 'Nora Hale', 'Mia Quinn', 'Ellie Hart', 'Ivy Cole', 'Luna Hayes',
  'Ruby Lane', 'Chloe Reed', 'Emma Blake', 'Zoe Parker', 'Aria Wells', 'Sadie Ford',
  'Hazel Grey', 'Mila Cross', 'Layla West', 'Freya Stone', 'Grace Vale', 'Holly Pierce',
  'Kate Monroe', 'Vera Shaw', 'Wren Adler', 'Pearl Ashton', 'Daisy Rowan', 'Cora Blake',
]

/** 进程内最近用过 + 落盘历史，严禁连抽撞名 */
const recentDisplayNames: string[] = []
let usedNamesCache: string[] | null = null

function usedNamesPath(): string {
  try {
    return path.join(app.getPath('userData'), 'create-char-used-names.json')
  } catch {
    return path.join(process.cwd(), 'create-char-used-names.json')
  }
}

function loadUsedNames(): string[] {
  try {
    const raw = fs.readFileSync(usedNamesPath(), 'utf8')
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

function getUsedNames(): string[] {
  if (!usedNamesCache) usedNamesCache = loadUsedNames()
  return usedNamesCache
}

function saveUsedNames(names: string[]) {
  try {
    fs.writeFileSync(usedNamesPath(), JSON.stringify(names.slice(-1200)), 'utf8')
  } catch {
    /* ignore */
  }
}

function randomInt(max: number) {
  if (max <= 0) return 0
  return cryptoRandomInt(max)
}

function pickFromPool(pool: string[], avoid: string[] = []) {
  const blocked = new Set(
    [...getUsedNames(), ...recentDisplayNames, ...avoid].map((n) => String(n).trim()).filter(Boolean),
  )
  // 中文：约一半抽三字，避免总是两字
  let candidates = pool
  if (pool === NAME_POOL_ZH || pool.length > 2000) {
    const wantThree = randomInt(100) < 48
    const sliced = wantThree
      ? NAME_POOL_ZH_THREE.filter((n) => !blocked.has(n))
      : NAME_POOL_ZH_TWO.filter((n) => !blocked.has(n))
    if (sliced.length) candidates = sliced
    else {
      const anyFresh = pool.filter((n) => !blocked.has(n))
      if (anyFresh.length) candidates = anyFresh
    }
  } else {
    candidates = pool.filter((n) => !blocked.has(n))
  }
  if (candidates.length) return candidates[randomInt(candidates.length)]

  // 兜底再组合：优先三字
  if (pool === NAME_POOL_ZH || pool.length > 500) {
    for (let i = 0; i < 100; i++) {
      const wantThree = i % 2 === 0
      let n: string
      if (wantThree) {
        const a = ZH_PREFIX[randomInt(ZH_PREFIX.length)]
        const m = ZH_MID[randomInt(ZH_MID.length)]
        const b = ZH_SUFFIX[randomInt(ZH_SUFFIX.length)]
        n = `${a}${m}${b}`
      } else {
        const a = ZH_PREFIX[randomInt(ZH_PREFIX.length)]
        const b = ZH_SUFFIX[randomInt(ZH_SUFFIX.length)]
        if (a === b) continue
        n = `${a}${b}`
      }
      if (!blocked.has(n)) return n
    }
  }
  const notRecent = pool.filter((n) => !recentDisplayNames.includes(n) && !blocked.has(n))
  const list = notRecent.length ? notRecent : pool.filter((n) => !avoid.includes(n))
  const use = list.length ? list : pool
  return use[randomInt(use.length)]
}

function nameRegionFromPayload(payload: Record<string, unknown>): 'zh' | 'jp' | 'kr' | 'en' {
  const region = String(payload.ancestry_region || '')
  const ancestry = JSON.stringify(payload.ancestry_tags || [])
  const appearance = JSON.stringify(payload.appearance_tags || [])
  const blob = `${region} ${ancestry} ${appearance}`.toLowerCase()

  // 东亚优先：appearance 里常有「禁止欧美五官」，不能因此抽英文名
  const isEast =
    region === 'east_asian' ||
    /东亚|中日韩|east.?asian|chinese|korean|japanese|华裔|华语|萌妹|东亚锁|东亚脸型/.test(blob)

  if (isEast) {
    if (
      /(^|[^日])韩系|韩国|korean|korea|首尔|韩风/.test(blob) &&
      !/中国|华语|中式|chinese|汉服/.test(blob)
    ) {
      return 'kr'
    }
    if (
      (/日本|和风|和服|京都|japanese|japan/.test(blob) || /日系萌|纯日系/.test(blob)) &&
      !/中国|华语|中式|chinese|汉服/.test(blob)
    ) {
      return 'jp'
    }
    return 'zh'
  }

  if (
    region === 'western' ||
    (/欧美裔|欧洲裔|western|caucasian|european|英伦|法式|德系|白人模特/.test(blob) &&
      !/禁止|勿|不是|禁|anti|no\s/i.test(blob))
  ) {
    return 'en'
  }
  return 'zh'
}

const HINT_NAME_NOISE = new Set([
  '欧美',
  '东亚',
  '西方',
  '欧洲',
  '写实',
  '写真',
  '角色',
  '女孩',
  '女人',
  '生成',
  '创建',
  '参考',
  '提示',
  '性感',
  '可爱',
  '成年',
  '成人',
  '模特',
  '女主',
  '人物',
  '立绘',
  '视频',
  '欧美角色',
  '东亚角色',
  '西方角色',
  '欧洲角色',
  'western',
  'european',
  'asian',
  'realistic',
])

function cleanHintName(raw: string | undefined): string | undefined {
  const name = (raw || '')
    .trim()
    .replace(/^[\s「『"'《【（(]+|[」』"'》】）)\s]+$/g, '')
    .replace(/\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!name || name.length < 2 || name.length > 40) return undefined
  if (/^\d+$/.test(name)) return undefined
  if (HINT_NAME_NOISE.has(name.toLowerCase())) return undefined
  // 指令短语 / 「欧美角色」类，不是角色专名
  if (/^(生成|创建|参考|提示|做成|改成)/.test(name)) return undefined
  if (/角色$/.test(name)) return undefined
  if (/^(角色|名字|昵称|提示|生成|创建)/.test(name) && name.length <= 4) return undefined
  return name
}

/**
 * 用户提示词里的角色身份 = 强约束，优先于一切随机起名。
 * 支持：名字是X / 扮演黑寡妇 / Black Widow / 「小雪」 / 逗号分隔的专名。
 */
function extractNameFromUserHint(hint?: string): string | undefined {
  const h = (hint || '').trim()
  if (!h) return undefined

  const labeled = [
    /(?:名字|昵称|角色名|角色名字|名叫|名为|display[_ ]?name|name)\s*[:：=是为]?\s*[「『"']?([^\n「」『』"'，,。；;]{2,40})/i,
    /(?:扮演|cos(?:play)?\s*|角色是|角色为)\s*[「『"']?([^\n「」『』"'，,。；;]{2,40})/i,
    /(?:就是|必须是|要做)\s*[「『"']?([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z .·'\-]{1,38})/,
  ]
  for (const re of labeled) {
    const name = cleanHintName(h.match(re)?.[1])
    if (name) return name
  }

  const quoted = cleanHintName(h.match(/[「『《【]([\u4e00-\u9fffA-Za-z .·'\-]{2,40})[」』》】]/)?.[1])
  if (quoted) return quoted

  // English title-case identity: Black Widow / Scarlett Johansson
  const enTitle = cleanHintName(
    h.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/)?.[1],
  )
  if (enTitle && !HINT_NAME_NOISE.has(enTitle.toLowerCase())) return enTitle

  // 整段就是名字
  const whole = cleanHintName(
    h.match(/^[「『"']?([\u4e00-\u9fff]{2,8}|[A-Za-z][A-Za-z .·'\-]{1,38})[」』"']?\s*$/)?.[1],
  )
  if (whole) return whole

  // 「生成欧美角色，黑寡妇，写实」→ 取非噪声的中文/英文专名片段（优先靠后的专名）
  const segments = h.split(/[,，。；;\n|/]+/).map((p) => p.trim()).filter(Boolean)
  for (let i = segments.length - 1; i >= 0; i--) {
    const token = cleanHintName(segments[i])
    if (!token) continue
    if (/^[\u4e00-\u9fff]{2,8}$/.test(token)) return token
    if (/^[A-Za-z][A-Za-z .·'\-]{1,38}$/.test(token)) return token
  }

  // 「欧美角色 黑寡妇」空格分隔：从后往前找中文专名
  const words = h.split(/\s+/).filter(Boolean)
  for (let i = words.length - 1; i >= 0; i--) {
    const token = cleanHintName(words[i])
    if (token && /^[\u4e00-\u9fff]{2,8}$/.test(token)) return token
  }

  return undefined
}

/** 过热/示例名：模型爱抄，直接重抽 */
const OVERUSED_NAMES = new Set([
  '柚子',
  '小柚',
  '娜娜',
  '未命名',
  '角色',
  '小美',
  '小雪',
  '小雨',
  '美少女',
  '千夏',
  '陽葵',
  '芽衣',
  '宁宁',
  '瑾萱',
  '葵',
  '琴音',
  '和泉',
  '美穂',
  '柚葉',
  '结衣',
  '結衣',
  '美咲',
  '西柚',
  '柚柚',
  '蜜桃',
])

/**
 * 可爱女孩名：用户 hint 里的角色身份 = 强提示，优先于一切（含欧美英文名池 / 模型返回名）。
 * 未指定时才从词库抽未用名（不信任模型返回名，极易撞车）。
 */
function ensureDisplayName(payload: Record<string, unknown>, userHint?: string) {
  const hinted = extractNameFromUserHint(userHint)
  if (hinted) {
    payload.display_name = hinted
    rememberName(hinted)
    return
  }

  const raw = typeof payload.display_name === 'string' ? payload.display_name.trim() : ''
  const cleaned = raw.replace(/\d+/g, '').trim()
  const lang = nameRegionFromPayload(payload)
  const pool =
    lang === 'jp' ? NAME_POOL_JP : lang === 'kr' ? NAME_POOL_KR : lang === 'en' ? NAME_POOL_EN : NAME_POOL_ZH
  // 一律重抽未用名；模型名仅作 avoid，绝不直接采用（防连撞）
  const name = pickFromPool(pool, [cleaned, ...OVERUSED_NAMES])
  payload.display_name = name
  rememberName(name)
}

/** 东亚 → zh-CN；欧美 → en-US（外观/人设中文提示词可保留） */
function ensureAgentLanguageForRegion(payload: Record<string, unknown>) {
  const lang = nameRegionFromPayload(payload)
  const region = String(payload.ancestry_region || '')
  const settings =
    payload.agent_prompt_settings && typeof payload.agent_prompt_settings === 'object'
      ? ({ ...(payload.agent_prompt_settings as Record<string, unknown>) } as Record<string, unknown>)
      : {
          language: 'zh-CN',
          voice_style: 'casual',
          voice_profile_key: 'builtin_eve',
        }
  if (lang === 'en' || region === 'western') {
    settings.language = 'en-US'
    payload.ancestry_region = 'western'
  } else if (lang === 'zh' || lang === 'jp' || lang === 'kr' || region === 'east_asian') {
    settings.language = 'zh-CN'
    if (!region || region === 'other') payload.ancestry_region = 'east_asian'
  }
  payload.agent_prompt_settings = settings
}

function rememberName(name: string) {
  const n = (name || '').trim()
  if (!n) return
  recentDisplayNames.push(n)
  while (recentDisplayNames.length > 80) recentDisplayNames.shift()
  const used = getUsedNames()
  if (!used.includes(n)) {
    used.push(n)
    usedNamesCache = used
    saveUsedNames(used)
  }
}

const SEXUAL_KINK_POOL = [
  '喜欢给男朋友足交，用足底与脚趾慢慢磨蹭挑逗，看他忍不住的表情会更兴奋发颤',
  '享受被口到腿软发颤，会主动按着对方的头不让离开，余韵里还想再来一次',
  '轻微SM，喜欢被绑住手腕后轻咬锁骨和耳垂，越害羞身体越诚实越想要',
  '乳交与被玩弄乳头会很快湿，喜欢被盯着胸部用脏话说出来并继续揉',
  '喜欢骑乘位自己摇腰，边做边盯着对方失神的脸，控制节奏的感觉很上瘾',
  '高潮后还想被内射，余韵里软着声音求再深一点再来一次，腿还在抖',
  '喜欢在镜子前被后入，被迫看着自己潮红的脸和交合处，羞耻感会立刻更湿',
  '耳边脏话和命令式语气会立刻兴奋，越被说骚越想被抱紧用力顶进来',
  '喜欢被边摸边夸骚，越羞越想要，会被摸到求饶还夹紧不让停',
  '迷恋被手指玩到求饶再换成真枪，扩张到软熟后被填满会立刻更敏感',
  '喜欢用腿夹住对方腰不让拔出去，贴得很紧磨到自己先喘着高潮',
  '对颈部亲吻和低喘特别敏感，被舔耳后颈会立刻软腰夹紧求继续',
]

function isFakeSexualKink(text: string) {
  const s = text.replace(/^性癖[:：]/, '').trim()
  if (!s) return true
  return (
    /夸奖|表扬|赞美|害羞|粘人|撒娇|温柔|腹黑|傲娇|社恐|怕黑|爱干净|甜食|拥抱|抱抱|聊天|陪伴|关心|体贴|依赖(?!性)|可爱|萌/.test(
      s,
    ) &&
    !/足交|口交|被口|乳交|内射|后入|骑乘|捆绑|SM|调教|自慰|潮吹|吞精|颜射|道具|跳蛋|项圈|跪|命令|脏话|乳头|脚趾|足底/.test(
      s,
    )
  )
}

/** 性癖必须是生理/性需求；补足到 5 条，假性癖换掉 */
function ensureSexualKinks(payload: Record<string, unknown>) {
  const personality = Array.isArray(payload.personality_tags)
    ? (payload.personality_tags as unknown[]).map(String)
    : []
  const pick = () => SEXUAL_KINK_POOL[Math.floor(Math.random() * SEXUAL_KINK_POOL.length)]
  const used = new Set<string>()
  const next: string[] = []
  for (const t of personality) {
    if (!/^性癖[:：]/.test(t)) {
      next.push(t)
      continue
    }
    let body = t.replace(/^性癖[:：]/, '').trim()
    if (isFakeSexualKink(t) || !body) body = pick()
    const key = body.slice(0, 24)
    if (used.has(key)) continue
    used.add(key)
    next.push(ensureTagLengthBand(`性癖:${body}`))
  }
  let guard = 0
  while (used.size < 5 && guard++ < 40) {
    const body = pick()
    const key = body.slice(0, 24)
    if (used.has(key)) continue
    used.add(key)
    next.push(ensureTagLengthBand(`性癖:${body}`))
  }
  let kinkCount = 0
  payload.personality_tags = next.filter((t) => {
    if (!/^性癖[:：]/.test(t)) return true
    kinkCount += 1
    return kinkCount <= 5
  })
}

/** 露肤场景强制写清阴毛浓密度；按年龄气质推断，允许白虎/稀疏/浓密 */
function ensureBodyHairTag(appearance: string[], payload?: Record<string, unknown>) {
  const idx = appearance.findIndex((t) => t.startsWith('体毛:') || /阴毛/.test(t))
  const ageMatch = String(payload?.age_statement || '').match(/(\d{2})/)
  const age = ageMatch ? Number(ageMatch[1]) : NaN
  // 看不出参考图时：偏年轻 → 稀疏/白虎倾向；偏成熟 → 适中/浓密
  let fallback: string
  if (!Number.isNaN(age) && age <= 22) {
    fallback = '体毛:阴毛稀疏或白虎，刚成年幼态'
  } else if (!Number.isNaN(age) && age >= 26) {
    fallback = '体毛:阴毛适中至浓密，偏成熟量感'
  } else {
    fallback = '体毛:阴毛浓密度按参考与年龄（白虎/稀疏/适中/浓密）'
  }
  if (idx < 0) {
    if (appearance.some((t) => t.startsWith('露肤度:') || t.startsWith('服装:'))) {
      appearance.push(fallback)
    }
    return
  }
  const cur = appearance[idx]
  if (!/白虎|全剃|稀疏|适中|浓密|浓|密|量感|光滑/.test(cur)) {
    appearance[idx] = cur.startsWith('体毛:')
      ? clampAppearanceTagLen(`${cur}，写明白虎/稀疏/适中/浓密`, 72)
      : fallback
  }
}

const MOE_PHRASE_EXPAND: Record<string, string> = {
  超可爱: '超可爱到犯规，第一眼就想伸手捏脸抱抱，靠近会下意识软声撒娇的萌系气质',
  萌妹: '典型软萌妹人设，撒娇讨抱、眼神水润依赖感强，被夸一句就会红着脸贴过来',
  软萌: '软萌到骨头里，说话轻声细气，靠近就想被哄，不开心时也会软软地求抱抱',
  甜美: '甜美得像刚做好的点心，笑起来软乎乎勾人，语气黏糊得让人想一直哄着',
  娇羞: '超级娇羞，被盯着看会红耳尖却舍不得躲开，越害羞越想被轻轻抱紧安慰',
  粘人: '粘人精本精，喜欢贴着对方不撒手求关注，离开一小会儿也要软声喊回来',
  撒娇: '爱撒娇，尾音黏糊，一不开心就想被抱紧哄，被摸头时会小声哼着更软',
  依赖感: '依赖感很重，喜欢被牵着手腕带着走，遇到事会先贴过来把脸埋进胸口',
  想被抱抱: '总想被从身后抱住，脸埋进对方胸口撒娇，被圈住腰时会安心地软下来',
  可爱到犯规: '可爱到犯规，连生气都像在撒娇卖萌，嘟嘴片刻又会黏过来求和好抱抱',
  娇软: '娇软无力感，被轻轻一抱就会软在怀里，说话也软软的，越哄越依赖',
  娇滴滴: '娇滴滴的声线与神态，问一句答一句都软软的，被盯久了会羞着躲开又偷看',
  水润大眼: '水润大眼直勾勾看人，眨一下就显得更萌，被夸漂亮时会害羞却舍不得移开',
  粉嫩皮肤: '粉嫩细腻的皮肤质感，靠近能感到软乎温度，被轻轻碰触就会微微缩一下',
  想捏的小脸蛋: '小脸蛋软软的，让人想轻轻捏一下又怕弄疼，被摸脸颊时会娇羞地贴过来',
}

/**
 * personality / tag_items：性格与性癖可写细（50–80）；其余标签保持官网短词。
 */
function prunePersonalityAndTagItems(payload: Record<string, unknown>) {
  const keepMeta = (t: string) => /^性癖[:：]|^对话风格[:：]|^职业[:：]/.test(t)
  const personality = Array.isArray(payload.personality_tags)
    ? (payload.personality_tags as unknown[]).map(String)
    : []
  const stripPad = (t: string) =>
    t
      .replace(
        /，?(细节写清禁止敷衍带过|层次语气都要具体可感|保持人设一致不跑偏|禁止擅自改成无关设定|写得更生动一点更贴人|按参考图可见信息锁死|保持写真级真实质感|层次光影与质感都要具体|软萌可爱会撒娇，靠近就想被抱抱哄着)+/g,
        '',
      )
      .replace(/，{2,}/g, '，')
      .replace(/^，|，$/g, '')
      .trim()
  const meta = personality.filter(keepMeta).map((t) => {
    const clean = stripPad(t)
    // 对话风格 / 职业：官网是短标签，禁止灌水凑字
    if (/^对话风格[:：]/.test(clean)) {
      const style = clean.replace(/^对话风格[:：]/, '').trim() || 'Chloe'
      return `对话风格:${style}`.slice(0, 40)
    }
    if (/^职业[:：]/.test(clean)) {
      const job = clean.replace(/^职业[:：]/, '').trim() || '学生'
      return `职业:${job}`.slice(0, 40)
    }
    // 性癖：可以 50–80
    return ensureTagLengthBand(clean)
  })
  const flavor = personality
    .filter((t) => !keepMeta(t))
    .map((t) => {
      const key = stripPad(t).replace(/^性格[:：]/, '').trim()
      const expanded =
        MOE_PHRASE_EXPAND[key] ||
        (key.length < MIN_TAG_LEN ? `${key}，软萌可爱会撒娇，靠近就想被抱抱哄着` : key)
      return ensureTagLengthBand(stripPad(expanded))
    })
  const flavorOut = [...flavor]
  for (const m of Object.values(MOE_PHRASE_EXPAND)) {
    if (flavorOut.length >= 10) break
    if (!flavorOut.some((x) => x.slice(0, 4) === m.slice(0, 4))) {
      flavorOut.push(ensureTagLengthBand(m))
    }
  }
  payload.personality_tags = dedupeExactStrings([...flavorOut.slice(0, 12), ...meta]).slice(0, 20)

  const items = Array.isArray(payload.tag_items) ? (payload.tag_items as unknown[]).map(String) : []
  const structural = new Set(['short', 'labels'])
  const struct = items.filter((t) => structural.has(t))
  // tag_items / 职业人种风格：短检索词，禁止拉到 50
  const rest = items
    .filter((t) => !structural.has(t))
    .map((t) => t.slice(0, 24))
    .filter(Boolean)
  if (!rest.some((t) => /东亚|中日韩/.test(t))) rest.unshift('东亚', '中日韩')
  payload.tag_items = dedupeExactStrings([...struct, ...rest]).slice(0, 14)

  for (const key of ['occupation_tags', 'ancestry_tags', 'style_tags'] as const) {
    if (!Array.isArray(payload[key])) continue
    payload[key] = (payload[key] as unknown[])
      .map(String)
      .map((t) => t.slice(0, 24))
      .filter(Boolean)
  }
}

/** 读写本地 portrait_prompt（不再写入 appearance_tags「立绘提示词:」） */
function getPortraitPromptText(payload: Record<string, unknown>): string {
  if (typeof payload.portrait_prompt === 'string' && payload.portrait_prompt.trim()) {
    return payload.portrait_prompt.trim()
  }
  const appearance = Array.isArray(payload.appearance_tags)
    ? (payload.appearance_tags as unknown[]).map(String)
    : []
  const lihui = appearance.find((t) => t.startsWith('立绘提示词:') || t.startsWith('立绘提示词：'))
  return lihui ? lihui.replace(/^立绘提示词[:：]/, '').trim() : ''
}

function setPortraitPromptText(payload: Record<string, unknown>, text: string) {
  const cleaned = sanitizePortraitPromptForLovemi(text)
  if (cleaned) payload.portrait_prompt = cleaned
}

/** 写实去 AI 味：皮肤毛孔 + 摄影感，钉进 portrait_prompt */
function reinforceRealismPortraitPrompt(payload: Record<string, unknown>) {
  const lock =
    '写实锁死，必须像真人cosplay摄影，皮肤毛孔与自然阴影纹理可见，少磨皮，禁止AI塑料脸，禁止二次元大眼过度美颜。'
  let raw = getPortraitPromptText(payload)
  if (!raw) return
  if (!/写实锁死|毛孔|皮肤纹理|少磨皮|塑料脸/.test(raw)) raw = `${lock}${raw}`
  // 服装品类提醒：若文案已有比基尼却又写短裙，压回品类一致
  if (/比基尼|泳装/.test(raw) && /短裙|迷你裙/.test(raw)) {
    raw = raw.replace(/短裙|迷你裙|低腰短裙感下装/g, '同色三角比基尼下装')
  }
  setPortraitPromptText(payload, raw)
}

/** 立绘长提示词：有脚必须钉死足部，禁止省略/缩小/乱加鞋 */
function reinforceFootPortraitPrompt(payload: Record<string, unknown>) {
  const appearance = Array.isArray(payload.appearance_tags)
    ? (payload.appearance_tags as unknown[]).map(String)
    : []
  const footTag = appearance.find((t) => t.startsWith('脚:')) || ''
  if (/未出现脚/.test(footTag)) return
  const feetLikely =
    /脚|足|脚掌|脚心|脚趾|丝袜|裤袜|蕾丝袜|裸足|双腿|大腿|坐/.test(appearance.join('｜')) &&
    !/脚:画面未出现脚/.test(footTag)
  if (!feetLikely) return
  const lock =
    '足部锁死，参考图中的脚必须作为构图重点完整保留，脚部前景占比、脚掌脚心朝向镜头、脚趾与袜足细节写清楚，禁止弱化成画面底边小尖，禁止无鞋却添加高跟鞋。'
  let raw = getPortraitPromptText(payload)
  if (!raw) return
  if (!/足部锁死|脚掌|脚心|足部前景/.test(raw)) raw = `${lock}${raw}`
  if (/蕾丝袜|裤袜|丝袜|袜足|裸足/.test(raw) && /高跟/.test(raw)) {
    raw = raw.replace(/透明感高跟鞋/g, '袜足无鞋').replace(/高跟鞋/g, '无鞋')
  }
  setPortraitPromptText(payload, raw)
}

/** 东亚立绘长提示词再钉死一轮，防止生图跑欧美 */
function reinforceEastAsianPortraitPrompt(payload: Record<string, unknown>, isEast: boolean) {
  if (!isEast) return
  const lock =
    '东亚锁死，必须是东亚中日韩面孔与五官，东亚黑发或参考发色，东亚皮肤质感，禁止欧美脸，禁止高加索深邃五官，禁止西方混血跑偏。'
  let raw = getPortraitPromptText(payload)
  if (!raw) return
  if (!/东亚|中日韩|禁止欧美/.test(raw)) raw = `${lock}${raw}`
  setPortraitPromptText(payload, raw)
}

/** 立绘提示词补一句阴毛浓密度（短），与体毛 tag / 年龄气质一致 */
function reinforceBodyHairInPortraitPrompt(payload: Record<string, unknown>) {
  const appearance = Array.isArray(payload.appearance_tags)
    ? (payload.appearance_tags as unknown[]).map(String)
    : []
  const hairTag = appearance.find((t) => t.startsWith('体毛:') || /阴毛/.test(t)) || ''
  let raw = getPortraitPromptText(payload)
  if (!raw) return
  if (/阴毛|体毛|耻丘|白虎/.test(raw)) return
  let clause: string
  if (/白虎|全剃/.test(hairTag)) {
    clause = '阴毛白虎光滑、耻丘无可见毛发。'
  } else if (/稀疏/.test(hairTag)) {
    clause = '阴毛稀疏、仅浅淡绒毛贴肤。'
  } else if (/浓密/.test(hairTag)) {
    clause = '阴毛浓密、耻丘毛发量感明显可见。'
  } else if (/适中/.test(hairTag)) {
    clause = '阴毛适中、三角区毛发量感自然可见。'
  } else {
    const ageMatch = String(payload.age_statement || '').match(/(\d{2})/)
    const age = ageMatch ? Number(ageMatch[1]) : 23
    clause =
      age <= 22
        ? '阴毛稀疏或白虎，符合刚成年幼态气质。'
        : age >= 26
          ? '阴毛适中至浓密，符合偏成熟气质。'
          : '阴毛浓密度按参考图年龄气质自然呈现。'
  }
  setPortraitPromptText(payload, raw.replace(/([。.!！]?)$/, `，${clause}$1`))
}

function injectLihuiTag(payload: Record<string, unknown>, portraitPrompt: string) {
  const prompt = sanitizePortraitPromptForLovemi(portraitPrompt)
  if (!prompt) return
  const tag = prompt.startsWith('立绘提示词:') ? prompt : `立绘提示词:${prompt}`
  const appearance = Array.isArray(payload.appearance_tags)
    ? (payload.appearance_tags as unknown[]).map(String).filter((t) => !t.startsWith('立绘提示词:'))
    : []
  appearance.push(tag)
  const clamped = appearance.map((t) => clampAppearanceTagLen(t))
  payload.appearance_tags = dedupeExactStrings(clamped)
}

function sanitizeCreateBody(body: Record<string, unknown>) {
  const next = { ...body }
  delete next.ancestry_region
  delete next.portrait_prompt
  return next
}

export async function analyzeReferenceImage(input: {
  imageBase64: string
  mimeType?: string
  proxyUrl: string
  /** 用户补充：角色是谁、人设、名字偏好等 */
  userHint?: string
}): Promise<{
  ok: boolean
  error?: string
  payload?: Record<string, unknown>
  portraitPrompt?: string
  model?: string
  rawPreview?: string
}> {
  const secrets = loadCreateCharSecrets()
  if (!secrets.teamoApiKey) return { ok: false, error: '未配置中转站 API Key（设置或创建角色页）' }
  if (!input.proxyUrl) return { ok: false, error: '未配置出站代理（禁止直连）' }
  const mime = input.mimeType || 'image/png'
  const dataUrl = `data:${mime};base64,${input.imageBase64}`
  const url = `${secrets.teamoApiBase.replace(/\/$/, '')}/chat/completions`
  const hint = (input.userHint || '').trim()
    const userText = [
      'Return ONLY the JSON object for Lovemi character creation.',
      'PUNCTUATION: inside any tag value NEVER use : ： ; ； | (breaks Lovemi compiler). Use Chinese comma ， instead.',
      'LENGTH: personality moe + 性癖 each 50–80 chars. 对话风格/职业 keep SHORT.',
      'LENGTH: appearance tags DENSE but safe: each ~20–72 chars (hard max 80), aim 18–26 tags. Split details; no filler pad. Colors = #RRGGBB only.',
      'LENGTH: occupation/ancestry/style/tag_items stay short keywords.',
      'tag_items = discovery/search keywords (短发/兔耳/漆皮/东亚…), NOT the long portrait essay.',
      'LENGTH: portrait_prompt = 320–580 Chinese chars LOCAL ONLY — never sent to Lovemi create/portrait API.',
      'ORIENTATION: lock viewer-left/right — same hand as reference; NO mirror.',
      'HAIR: bangs/layers/volume/tie — concrete; do NOT invent bun.',
      'appearance_tags MUST include 朝向/惯用手/发型/发质/服装(上下装品类)/露肤度/脚/配饰/姿势/背景(小物件)/表情/心情/气质/皮肤/光影/体毛.',
      'MOOD: 心情 must be scene-inferred inner feeling (e.g. 暖光里的慵懒安心); FORBID bare 伤心/开心/难过/害羞.',
      'CLOTHING IDENTITY: same garment types as reference (bikini stays bikini); 更暴露 only within type; NEVER rewrite bottoms as 短裙.',
      'BACKGROUND: bed sheet color/wrinkles + ≥2 props (figurine shelf/LED/TV/cloth on bed).',
      'REALISM: style_tags 写实+写真+皮肤纹理; 皮肤 tag + portrait_prompt must lock pores/少磨皮, forbid plastic AI face.',
      '体毛: MUST state 阴毛 as 白虎|稀疏|适中|浓密 from image + age vibe (young → sparse/白虎; mature → denser).',
      'portrait_prompt order: 朝向惯用手 → 足部(若有) → 发型 → 服装品类锁 → 背景小物件 → 五官表情心情 → 阴毛 → 写实皮肤锁.',
      'FOOT LOCK: if feet visible, detail 脚; NEVER invent heels when socked/bare.',
      'CLOTHING: sexier within same type, NEVER 露点.',
      'If East Asian: language zh-CN; lock 东亚中日韩; Chinese display_name; FORBID 欧美脸.',
      'If Western/European: language MUST be en-US; English display_name UNLESS user notes already name the character; appearance/personality may stay Chinese; ancestry 欧洲裔; no 东亚锁.',
      '性癖 = real sexual preference (足交/被口/SM/骑乘等), NEVER「喜欢被夸奖」.',
      'display_name DEFAULT: East Asian → UNIQUE cute Chinese 2–3字; Western → UNIQUE English name; NO digits.',
      'display_name OVERRIDE (strongest): if user notes name a character (黑寡妇/Black Widow/叫小雪/角色是…), display_name MUST be that identity — never random pool name.',
      hint
        ? `\nUser notes (STRONG — character identity/name/lore/occupation OVERRIDE defaults):\n${hint}`
        : '',
    ]
      .filter(Boolean)
      .join('\n')

  try {
    const body: Record<string, unknown> = {
      model: secrets.teamoModel || 'gpt-5.4-mini',
      temperature: 0.35,
      messages: [
        { role: 'system', content: ANALYZE_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }
    // 能开就开；部分中转站不认会 400，下面有降级重试
    body.response_format = { type: 'json_object' }

    const postOnce = async (payload: Record<string, unknown>) => {
      const res = await undiciFetch(url, {
        method: 'POST',
        headers: teamoHeaders(secrets.teamoApiKey),
        dispatcher: dispatcherFor(input.proxyUrl, url),
        signal: AbortSignal.timeout(180_000),
        body: JSON.stringify(payload),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      return { res, data }
    }

    let lastNetErr = ''
    let res: Awaited<ReturnType<typeof undiciFetch>> | null = null
    let data: Record<string, unknown> = {}
    for (let netTry = 1; netTry <= 3; netTry++) {
      try {
        ;({ res, data } = await postOnce(body))
        lastNetErr = ''
        break
      } catch (err) {
        lastNetErr = err instanceof Error ? err.message : String(err)
        appendConsoleLog({
          level: 'warn',
          action: 'create_char',
          message: `分析网络失败 ${netTry}/3 · ${lastNetErr.slice(0, 120)}`,
        })
        if (netTry < 3) await sleep(1500 * netTry)
      }
    }
    if (!res) {
      appendConsoleLog({ level: 'error', action: 'create_char', message: `分析异常：${lastNetErr}` })
      return { ok: false, error: lastNetErr || '分析网络失败' }
    }

    if (!res.ok && /response_format|json_object|unknown|unsupported/i.test(JSON.stringify(data))) {
      delete body.response_format
      try {
        ;({ res, data } = await postOnce(body))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        appendConsoleLog({ level: 'error', action: 'create_char', message: `分析异常：${msg}` })
        return { ok: false, error: msg }
      }
    }

    if (!res.ok) {
      const errObj = data.error as { message?: string } | string | undefined
      const msg =
        (typeof errObj === 'object' && errObj?.message) ||
        (typeof errObj === 'string' && errObj) ||
        (typeof data.message === 'string' && data.message) ||
        `中转站 HTTP ${res.status}`
      appendConsoleLog({ level: 'error', action: 'create_char', message: `分析失败：${msg}` })
      return { ok: false, error: msg, model: secrets.teamoModel, rawPreview: JSON.stringify(data).slice(0, 800) }
    }

    const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : []
    const msg0 = (choices[0]?.message || {}) as Record<string, unknown>
    let content = messageContentToText(msg0.content)
    if (!content) content = messageContentToText(msg0.reasoning_content)
    if (!content && typeof data.output_text === 'string') content = data.output_text

    let payload = extractJsonObject(content)
    if (!payload || !Object.keys(payload).length) {
      const preview = content.slice(0, 600) || JSON.stringify(data).slice(0, 600)
      appendConsoleLog({
        level: 'error',
        action: 'create_char',
        message: `分析无 JSON · raw: ${preview.slice(0, 180)}`,
      })
      return {
        ok: false,
        error: '模型未返回可解析 JSON（请换图重试或换模型）',
        model: secrets.teamoModel,
        rawPreview: preview,
      }
    }

    let portraitPrompt =
      typeof payload.portrait_prompt === 'string' ? String(payload.portrait_prompt).trim() : ''

    const detailIssues = [
      ...requiredPayloadIssues(payload),
      ...analyzeDetailIssues(payload, portraitPrompt),
    ]
    if (detailIssues.length) {
      appendConsoleLog({
        level: 'warn',
        action: 'create_char',
        message: `视觉细节不足，自动补充重试 1 次 · ${detailIssues.slice(0, 6).join('；')}`,
      })
      const retryBody: Record<string, unknown> = {
        ...body,
        temperature: 0.2,
        messages: [
          { role: 'system', content: ANALYZE_SYSTEM },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  userText,
                  '',
                  'QUALITY RETRY: Previous result failed these checks:',
                  ...detailIssues.map((issue) => `- ${issue}`),
                  'Fix missing/thin tags with concrete visible details (colors, materials, left/right).',
                  'Keep LENGTH split: personality/性癖 50–80; appearance dense short ~18–26 tags. MUST 心情(scene-inferred, no bare 伤心/开心). CLOTHING identity. BACKGROUND props. REALISM pores. Exactly 5 性癖.',
                  'Return ONLY a complete JSON object.',
                ].join('\n'),
              },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }
      try {
        const retried = await postOnce(retryBody)
        if (retried.res.ok) {
          const retryChoices = Array.isArray(retried.data.choices)
            ? (retried.data.choices as Array<Record<string, unknown>>)
            : []
          const retryMessage = (retryChoices[0]?.message || {}) as Record<string, unknown>
          const retryContent =
            messageContentToText(retryMessage.content) ||
            messageContentToText(retryMessage.reasoning_content) ||
            (typeof retried.data.output_text === 'string' ? retried.data.output_text : '')
          const retryPayload = extractJsonObject(retryContent)
          if (retryPayload && Object.keys(retryPayload).length) {
            const retryPrompt =
              typeof retryPayload.portrait_prompt === 'string'
                ? String(retryPayload.portrait_prompt).trim()
                : ''
            const retrySchemaIssues = requiredPayloadIssues(retryPayload)
            const retryIssues = [
              ...retrySchemaIssues,
              ...analyzeDetailIssues(retryPayload, retryPrompt),
            ]
            if (!retrySchemaIssues.length && retryIssues.length < detailIssues.length) {
              payload = retryPayload
              portraitPrompt = retryPrompt
              appendConsoleLog({
                level: 'info',
                action: 'create_char',
                message: `视觉细节补充完成 · 缺项 ${detailIssues.length} → ${retryIssues.length}`,
              })
            }
          }
        }
      } catch (retryError) {
        appendConsoleLog({
          level: 'warn',
          action: 'create_char',
          message: `视觉细节补充重试失败，沿用首轮结果 · ${
            retryError instanceof Error ? retryError.message : String(retryError)
          }`,
        })
      }
    }

    delete payload.portrait_prompt
    if (!payload.creation_source) payload.creation_source = 'blank'
    if (!payload.custom_parameter_access_level) payload.custom_parameter_access_level = 'basic'

    // 东亚可爱强化 + 全员补齐服装/姿势/背景短 tag（Lovemi 生图主要吃这些）
    const region = String(payload.ancestry_region || '')
    const ancestry = JSON.stringify(payload.ancestry_tags || [])
    const isEast =
      region === 'east_asian' || /东亚|日|韩|中|华|chinese|korean|japanese|east.?asian/i.test(ancestry)
    reinforceVisualAndCuteTags(payload, isEast)
    ensureDisplayName(payload, input.userHint)
    ensureAgentLanguageForRegion(payload)
    ensureSexualKinks(payload)
    prunePersonalityAndTagItems(payload)

    // 立绘长文只留给 UI（portraitPrompt 返回值）；不要塞进 appearance_tags
    // （官网 create 的 appearance_tags 是短结构化标签 + prompt_enhancement）
    if (portraitPrompt) {
      // 本地草稿 JSON 可带 portrait_prompt 字段供编辑；创建时 sanitizeCreateBody 会删掉
      payload.portrait_prompt = sanitizePortraitPromptForLovemi(portraitPrompt)
    }
    reinforceEastAsianPortraitPrompt(payload, isEast)
    reinforceFootPortraitPrompt(payload)
    reinforceBodyHairInPortraitPrompt(payload)
    reinforceRealismPortraitPrompt(payload)
    // 保留写实/写真/皮肤纹理，去掉空泛广告词即可
    if (Array.isArray(payload.style_tags)) {
      const style = payload.style_tags.map(String)
      payload.style_tags = dedupeExactStrings(style).filter(
        (t) => !/高级感|棚拍感|电影感|质感拉满/.test(t),
      )
    }
    stripLihuiAppearanceTags(payload)
    pruneAppearanceTags(payload)

    appendConsoleLog({
      level: 'info',
      action: 'create_char',
      message: `分析成功 · ${String(payload.display_name || '?')} · ${secrets.teamoModel}${portraitPrompt ? ' · 立绘长文已留作 portrait_prompt（不进 appearance_tags）' : ''}`,
    })
    return {
      ok: true,
      payload,
      portraitPrompt: typeof payload.portrait_prompt === 'string' ? payload.portrait_prompt : portraitPrompt || undefined,
      model: secrets.teamoModel,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendConsoleLog({ level: 'error', action: 'create_char', message: `分析异常：${msg}` })
    return { ok: false, error: msg }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function lovemiHeaders(sessionToken: string, extra?: Record<string, string>) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${sessionToken}`,
    Origin: 'https://app.lovemi.ai',
    Referer: 'https://app.lovemi.ai/',
    'Accept-Language': 'zh-CN',
    ...extra,
  }
}

async function lovemiGetJson(input: {
  path: string
  sessionToken: string
  proxyUrl: string
}): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; error?: string }> {
  const url = `${LOVEMI}${input.path}`
  try {
    const res = await undiciFetch(url, {
      method: 'GET',
      headers: lovemiHeaders(input.sessionToken),
      dispatcher: dispatcherFor(input.proxyUrl, url),
      signal: AbortSignal.timeout(30_000),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const msg =
        (typeof data.message === 'string' && data.message) ||
        (typeof data.error === 'string' && data.error) ||
        `HTTP ${res.status}`
      return { ok: false, status: res.status, data, error: msg }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    return { ok: false, status: 0, data: {}, error: err instanceof Error ? err.message : String(err) }
  }
}

function pickPortraitUrl(data: Record<string, unknown>): string | undefined {
  const cand = data.latest_portrait_candidate as Record<string, unknown> | undefined
  if (cand?.cdn_url && typeof cand.cdn_url === 'string') return cand.cdn_url
  const vp = data.visual_profile as Record<string, unknown> | undefined
  if (vp?.cdn_url && typeof vp.cdn_url === 'string') return vp.cdn_url
  if (typeof data.avatar_url === 'string' && data.avatar_url) return data.avatar_url
  // 深挖任意 assets.lovemi.ai / cdn_url（站内已出图时字段常不在顶层）
  const deep = pickDeepCdnUrl(data)
  if (deep && !/\.(mp4|webm)(\?|$)/i.test(deep)) return deep
  return undefined
}

function pickDeepCdnUrl(obj: unknown, depth = 0): string | undefined {
  if (!obj || depth > 6) return undefined
  if (typeof obj === 'string') {
    if (/^https:\/\/assets\.lovemi\.ai\//i.test(obj)) return obj
    if (/^https:\/\/.+\.(cdn|lovemi)/i.test(obj) && /\.(png|jpe?g|webp)(\?|$)/i.test(obj)) return obj
    return undefined
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = pickDeepCdnUrl(item, depth + 1)
      if (hit) return hit
    }
    return undefined
  }
  if (typeof obj !== 'object') return undefined
  const rec = obj as Record<string, unknown>
  for (const key of ['cdn_url', 'url', 'image_url', 'portrait_url', 'avatar_url', 'download_url']) {
    const v = rec[key]
    if (typeof v === 'string' && v.startsWith('http') && !/\.(mp4|webm)(\?|$)/i.test(v)) return v
  }
  for (const v of Object.values(rec)) {
    const hit = pickDeepCdnUrl(v, depth + 1)
    if (hit) return hit
  }
  return undefined
}

function pickCharacterId(data: Record<string, unknown>): string | undefined {
  for (const key of ['id', 'character_id']) {
    const v = data[key]
    if (typeof v === 'string' && (v.startsWith('chr_') || v.startsWith('character_'))) return v
  }
  const nested = data.character as Record<string, unknown> | undefined
  if (nested && typeof nested.id === 'string') return nested.id
  if (typeof data.id === 'string' && data.id) return data.id
  return undefined
}

function pickJobId(obj: unknown, depth = 0): string | undefined {
  if (!obj || depth > 5) return undefined
  if (typeof obj === 'string' && /^job_/.test(obj)) return obj
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = pickJobId(item, depth + 1)
      if (hit) return hit
    }
    return undefined
  }
  if (typeof obj !== 'object') return undefined
  const rec = obj as Record<string, unknown>
  for (const key of ['source_generation_job_id', 'generation_job_id', 'job_id', 'id']) {
    const v = rec[key]
    if (typeof v === 'string' && /^job_/.test(v)) return v
  }
  for (const v of Object.values(rec)) {
    const hit = pickJobId(v, depth + 1)
    if (hit) return hit
  }
  return undefined
}

type JobRecord = { id: string; status?: string; at?: number; capability?: string }

function jobRecordTime(rec: Record<string, unknown>): number {
  for (const key of ['created_at', 'updated_at', 'started_at']) {
    const v = rec[key]
    if (typeof v === 'string') {
      const t = Date.parse(v)
      if (!Number.isNaN(t)) return t
    }
    if (typeof v === 'number' && v > 1_000_000_000_000) return v
  }
  return 0
}

/** 从 jobs 列表响应里收集 job 记录（用于挑最新、未失败的） */
function collectJobRecords(obj: unknown, depth = 0, out: JobRecord[] = []): JobRecord[] {
  if (!obj || depth > 6) return out
  if (Array.isArray(obj)) {
    for (const item of obj) collectJobRecords(item, depth + 1, out)
    return out
  }
  if (typeof obj !== 'object') return out
  const rec = obj as Record<string, unknown>
  const id =
    (typeof rec.id === 'string' && /^job_/.test(rec.id) ? rec.id : undefined) ||
    (typeof rec.job_id === 'string' && /^job_/.test(rec.job_id) ? rec.job_id : undefined)
  if (id) {
    out.push({
      id,
      status: typeof rec.status === 'string' ? rec.status : undefined,
      at: jobRecordTime(rec),
      capability: typeof rec.capability_key === 'string' ? rec.capability_key : undefined,
    })
  }
  for (const v of Object.values(rec)) collectJobRecords(v, depth + 1, out)
  return out
}

function pickBestPortraitJobId(
  data: Record<string, unknown>,
  exclude = new Set<string>(),
  minCreatedAt?: number,
): string | undefined {
  const records = collectJobRecords(data)
  const imageJobs = records.filter(
    (j) =>
      !exclude.has(j.id) &&
      (!minCreatedAt || !j.at || j.at >= minCreatedAt - 5000) &&
      (!j.capability || /image\.(generate|edit)/i.test(j.capability)),
  )
  const pool = imageJobs.length
    ? imageJobs
    : records.filter(
        (j) => !exclude.has(j.id) && (!minCreatedAt || !j.at || j.at >= minCreatedAt - 5000),
      )
  if (!pool.length) return undefined
  pool.sort((a, b) => (b.at || 0) - (a.at || 0))
  const active = pool.find((j) => j.status && !/fail|error|cancel/i.test(j.status))
  return (active || pool[0])?.id
}

function extractJobError(data: Record<string, unknown>): string {
  const parts: string[] = []
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) parts.push(v.trim())
  }
  push(data.error)
  if (data.error && typeof data.error === 'object') {
    const err = data.error as Record<string, unknown>
    push(err.message)
    push(err.detail)
    push(err.code)
  }
  push(data.message)
  push(data.failure_reason)
  push(data.reason)
  const live = data.live as Record<string, unknown> | undefined
  if (live) {
    push(live.message)
    push(live.error)
    push(live.failure_reason)
  }
  const issues = data.issues
  if (Array.isArray(issues) && issues[0] && typeof issues[0] === 'object') {
    const i0 = issues[0] as Record<string, unknown>
    push(i0.message)
    push(i0.detail)
  }
  return [...new Set(parts)].join(' · ').slice(0, 240)
}

function extractJobErrorCode(data: Record<string, unknown>): string {
  const last = data.last_error
  if (last && typeof last === 'object') {
    const code = (last as Record<string, unknown>).error_code
    if (typeof code === 'string' && code.trim()) return code.trim()
  }
  const err = data.error
  if (err && typeof err === 'object') {
    const code = (err as Record<string, unknown>).code
    if (typeof code === 'string' && code.trim()) return code.trim()
  }
  const live = data.live
  if (live && typeof live === 'object') {
    const code = (live as Record<string, unknown>).error_code
    if (typeof code === 'string' && code.trim()) return code.trim()
  }
  return ''
}

function isJobStatusTerminal(status: string) {
  return /fail|error|cancel|complete|completed|success|succeed|done|finished/i.test(status)
}

function isNonRetriablePortraitErrorCode(code: string) {
  if (!code) return false
  return /PROMPT_COMPILATION_FAILED|INVALID_PROMPT|CONTENT_POLICY|SAFETY|MODERATION/i.test(code)
}

/** Lovemi 按「前缀:内容」拆 tag；正文里的 : ： ； | 等会把编译器拆挂 */
function stripCompilerUnsafePunctuation(text: string): string {
  return text
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[`]/g, '')
    // 二次分隔符 → 中文逗号，避免被当成新 tag
    .replace(/[|:：；;]/g, '，')
    // 方括号/花括号偶发被当 DSL
    .replace(/[{}[\]【】]/g, '')
    .replace(/\r\n|\n|\r/g, ' ')
    .replace(/\s+/g, ' ')
    // 连续逗号压一下
    .replace(/，{2,}/g, '，')
    .replace(/^，|，$/g, '')
    .trim()
}

function sanitizePortraitPromptForLovemi(input: string): string {
  // Lovemi prompt compiler：单行可打印 + 去掉会破坏「前缀:内容」解析的标点
  const rewritten = input
    .replace(/^立绘提示词[:：]/, '')
    .replace(/拒绝AI塑料感/g, '少磨皮')
    .replace(/高级写真棚拍感与生活空间真实感兼具/g, '自然光影，像真实拍摄')
    .replace(/写真棚拍感/g, '自然光影')
    .replace(/比例真实/g, '比例自然')

  return stripCompilerUnsafePunctuation(rewritten).slice(0, 760)
}

function dedupeExactStrings(list: string[]) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    if (!item) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

// Lovemi 官网对单条 appearance tag 用 Qt(..., 80) 截断；超长自造「立绘提示词:」不进官方 schema。
// 性格/性癖可写细；appearance 必须短，强行凑 50+ 易 PROMPT_COMPILATION_FAILED。
const MIN_TAG_LEN = 51 // 仅 personality / 性癖
const MAX_TAG_LEN = 79
const MAX_APPEARANCE_TAG_LEN = 80
/** 送生图编译器前，外观叙事标签再压短一点更稳 */
const PREFERRED_APPEARANCE_TAG_LEN = 72
const MAX_LIHUI_TAG_LEN = 576 // 仅本地/草稿展示用，创建送 Lovemi 前会剥离

const TAG_PAD_PHRASES = [
  '细节写清禁止敷衍带过',
  '层次语气都要具体可感',
  '保持人设一致不跑偏',
  '禁止擅自改成无关设定',
  '写得更生动一点更贴人',
]

/**
 * 仅用于 personality / 性癖：强制全文落在 (50, 80)。
 * appearance / 颜色 / 职业短词禁止走这里。
 */
function ensureTagLengthBand(tag: string, minLen = MIN_TAG_LEN, maxLen = MAX_TAG_LEN): string {
  if (!tag) return tag
  const m = tag.match(/^([^:：]{1,24})[:：]([\s\S]*)$/)
  let t = m
    ? `${m[1].trim()}:${stripCompilerUnsafePunctuation(m[2])}`
    : stripCompilerUnsafePunctuation(tag)
  if (!t) return t
  let i = 0
  while (t.length < minLen && i < 24) {
    const pad = TAG_PAD_PHRASES[i % TAG_PAD_PHRASES.length]
    const candidate = `${t}，${pad}`
    if (candidate.length <= maxLen) {
      t = candidate
      i += 1
      continue
    }
    const room = maxLen - t.length
    if (room < 2) break
    t = `${t}${'，细节写清'.slice(0, room)}`.slice(0, maxLen)
    break
  }
  if (t.length > maxLen) t = t.slice(0, maxLen)
  return t
}

/** 外观 tag：只清洗 + 截断，绝不灌水凑字；颜色只保留 #RRGGBB */
function clampAppearanceTagLen(tag: string, maxLen = MAX_APPEARANCE_TAG_LEN) {
  if (!tag) return tag
  const m = tag.match(/^([^:：]{1,24})[:：]([\s\S]*)$/)
  if (!m) {
    return stripCompilerUnsafePunctuation(tag).slice(0, maxLen)
  }
  const prefix = m[1].trim()
  let body = stripCompilerUnsafePunctuation(m[2])
  if (prefix === '立绘提示词') {
    return `立绘提示词:${body}`.slice(0, Math.min(maxLen, MAX_LIHUI_TAG_LEN))
  }
  // 官网三色：后面加废话会搞挂编译器
  if (/^(肤色|瞳色|发色)$/.test(prefix)) {
    const hex = body.match(/#[0-9A-Fa-f]{6}/)?.[0]
    if (hex) return `${prefix}:${hex.toUpperCase()}`
    return `${prefix}:${body}`.slice(0, 16)
  }
  // 官网短档：胸型/臀型/体型保持短
  if (/^(胸型|臀型|体型)$/.test(prefix)) {
    return `${prefix}:${body}`.slice(0, 24)
  }
  // 清掉上次错误策略留下的灌水尾句
  body = body
    .replace(/，?(细节写清禁止敷衍带过|层次语气都要具体可感|保持人设一致不跑偏|禁止擅自改成无关设定|写得更生动一点更贴人|按参考图可见信息锁死|保持写真级真实质感|层次光影与质感都要具体)+/g, '')
    .replace(/，{2,}/g, '，')
    .replace(/^，|，$/g, '')
  const softMax =
    maxLen <= PREFERRED_APPEARANCE_TAG_LEN ? maxLen : Math.min(maxLen, PREFERRED_APPEARANCE_TAG_LEN)
  // 调用方显式传入更小 maxLen 时尊重；默认走 72 软上限（仍 ≤ 官网 80）
  const cap = maxLen < MAX_APPEARANCE_TAG_LEN ? maxLen : softMax
  return `${prefix}:${body}`.slice(0, cap)
}

/** 创建送 Lovemi 前去掉「立绘提示词:」——官网生图不靠这条，硬塞会 PROMPT_COMPILATION_FAILED */
function stripLihuiAppearanceTags(payload: Record<string, unknown>) {
  const appearance = Array.isArray(payload.appearance_tags)
    ? (payload.appearance_tags as unknown[]).map(String)
    : []
  payload.appearance_tags = appearance.filter((t) => !t.startsWith('立绘提示词:') && !t.startsWith('立绘提示词：'))
}

function pruneAppearanceTags(payload: Record<string, unknown>) {
  const appearance = Array.isArray(payload.appearance_tags)
    ? (payload.appearance_tags as unknown[]).map(String)
    : []
  if (!appearance.length) return

  // 官网 Pd() 只有发型/体型/胸臀/三色等短标签；我们保留关键锁，但绝不带立绘长文
  const requiredPrefixes = [
    '发型:',
    '发质:',
    '五官:',
    '妆容:',
    '朝向:',
    '惯用手:',
    '服装:',
    '露肤度:',
    '脚:',
    '配饰:',
    '姿势:',
    '背景:',
    '表情:',
    '心情:',
    '气质:',
    '皮肤:',
    '光影:',
    '体毛:',
    '肤色:',
    '瞳色:',
    '发色:',
    '体型:',
    '胸型:',
    '臀型:',
  ]
  const keep = (t: string) => {
    if (!t) return false
    if (t.startsWith('立绘提示词:') || t.startsWith('立绘提示词：')) return false
    if (t.startsWith('人种:')) return true
    if (requiredPrefixes.some((p) => t.startsWith(p))) return true
    return false
  }

  const pruned = appearance.filter(keep)
  // 优先保住背景/姿势(手势)/表情/心情/服装/皮肤等生图关键项，再补其它
  const priorityPrefix = [
    '姿势:',
    '背景:',
    '表情:',
    '心情:',
    '发型:',
    '服装:',
    '皮肤:',
    '脚:',
    '配饰:',
    '光影:',
    '朝向:',
    '惯用手:',
    '五官:',
    '体毛:',
    '胸型:',
    '臀型:',
    '人种:',
    '发色:',
    '瞳色:',
    '肤色:',
    '体型:',
    '妆容:',
    '发质:',
    '露肤度:',
    '气质:',
  ]
  const prioritized: string[] = []
  for (const p of priorityPrefix) {
    const hit = pruned.find((t) => t.startsWith(p))
    if (hit && !prioritized.includes(hit)) prioritized.push(hit)
  }
  for (const t of pruned) {
    if (!prioritized.includes(t)) prioritized.push(t)
  }
  // 多条拆细节；单条仍 ≤72/80
  const MAX_TAGS = 26
  payload.appearance_tags = dedupeExactStrings(
    prioritized.slice(0, MAX_TAGS).map((t) => clampAppearanceTagLen(t)),
  )
}

/** 同时只允许一个角色在等生图，避免三槽并发把 Lovemi 打挂 */
let portraitWaitGate: Promise<void> = Promise.resolve()
let portraitWaitCount = 0

async function withPortraitWaitSlot<T>(characterId: string, fn: () => Promise<T>): Promise<T> {
  const prev = portraitWaitGate
  let release!: () => void
  portraitWaitGate = new Promise((r) => {
    release = r
  })
  await prev
  portraitWaitCount += 1
  if (portraitWaitCount > 1) {
    appendConsoleLog({
      level: 'info',
      action: 'create_char',
      message: `生图排队 · 前面还有 ${portraitWaitCount - 1} 个 · ${characterId.slice(0, 18)}`,
    })
  }
  try {
    return await fn()
  } finally {
    portraitWaitCount = Math.max(0, portraitWaitCount - 1)
    release()
  }
}

async function lovemiPostJson(input: {
  path: string
  sessionToken: string
  proxyUrl: string
  body: Record<string, unknown>
}): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; error?: string }> {
  const url = `${LOVEMI}${input.path}`
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: lovemiHeaders(input.sessionToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(input.body),
      dispatcher: dispatcherFor(input.proxyUrl, url),
      signal: AbortSignal.timeout(45_000),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const msg =
        (typeof data.message === 'string' && data.message) ||
        (typeof data.error === 'string' && data.error) ||
        `HTTP ${res.status}`
      return { ok: false, status: res.status, data, error: msg }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    return { ok: false, status: 0, data: {}, error: err instanceof Error ? err.message : String(err) }
  }
}

async function fetchCdnAsDataUrl(cdnUrl: string, proxyUrl: string): Promise<string | undefined> {
  try {
    const res = await undiciFetch(cdnUrl, {
      dispatcher: dispatcherFor(proxyUrl, cdnUrl),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) return undefined
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 80) return undefined
    const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0]
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return undefined
  }
}

async function discoverPortraitJobId(input: {
  characterId: string
  sessionToken: string
  proxyUrl: string
  excludeJobIds?: string[]
  minCreatedAt?: number
}): Promise<string | undefined> {
  const exclude = new Set((input.excludeJobIds || []).filter(Boolean))
  const paths = [
    `/v1/jobs?character_id=${encodeURIComponent(input.characterId)}`,
    `/v1/characters/${encodeURIComponent(input.characterId)}/jobs`,
  ]
  let best: string | undefined
  for (const path of paths) {
    const res = await lovemiGetJson({
      path,
      sessionToken: input.sessionToken,
      proxyUrl: input.proxyUrl,
    })
    if (!res.ok) continue
    const hit = pickBestPortraitJobId(res.data, exclude, input.minCreatedAt)
    if (hit) best = hit
  }
  return best
}

async function tryStartPortraitJob(input: {
  characterId: string
  sessionToken: string
  proxyUrl: string
}): Promise<string | undefined> {
  const threadId = `gen_${createHash('sha256')
    .update(`${input.characterId}|${Date.now()}|${randomUUID()}`)
    .digest('hex')
    .slice(0, 32)}`
  const bodies: Record<string, unknown>[] = [
    {
      public_model_key: 'image1_pro',
      capability_key: 'image.generate.v1',
      metadata: {
        character_id: input.characterId,
        source: 'character_creation',
        public_model_key: 'image1_pro',
        product_model: 'Image1-pro',
        aspect_ratio: '9:16',
        generation_thread_id: threadId,
        prompt_enhancement: true,
      },
      requested_options: {
        public_model_key: 'image1_pro',
        model_label: 'Image1-pro',
        aspect_ratio: '9:16',
        aspect: 'portrait',
        width: 1088,
        height: 1920,
        prompt_enhancement: true,
      },
    },
    {
      public_model_key: 'image1_pro',
      capability_key: 'image.generate.v1',
      character_id: input.characterId,
      metadata: {
        character_id: input.characterId,
        source: 'character_creation',
      },
      requested_options: {
        aspect_ratio: '9:16',
        width: 1088,
        height: 1920,
        prompt_enhancement: true,
      },
    },
  ]
  const paths = ['/v1/jobs', `/v1/characters/${encodeURIComponent(input.characterId)}/jobs`]
  let lastErr = ''
  for (const path of paths) {
    for (const body of bodies) {
      const res = await lovemiPostJson({
        path,
        sessionToken: input.sessionToken,
        proxyUrl: input.proxyUrl,
        body,
      })
      if (res.ok) {
        const jobId = pickJobId(res.data)
        appendConsoleLog({
          level: 'info',
          action: 'create_char',
          message: jobId ? `已补触发 Lovemi 生图 job ${jobId}` : '已补触发 Lovemi 生图',
        })
        return jobId
      }
      lastErr =
        res.error ||
        extractJobError(res.data) ||
        (typeof res.data.message === 'string' ? res.data.message : '') ||
        `HTTP ${res.status}`
    }
  }
  if (lastErr) {
    appendConsoleLog({
      level: 'warn',
      action: 'create_char',
      message: `补触发生图失败 · ${input.characterId.slice(0, 18)} · ${lastErr.slice(0, 160)}`,
    })
  }
  return undefined
}

async function portraitFromCdn(
  cdnUrl: string,
  proxyUrl: string,
  jobId?: string,
  /** 默认 false：立刻回填 CDN，避免整图下载卡住 UI（官网已出图软件还空白） */
  fetchDataUrl = false,
): Promise<{ ok: true; cdnUrl: string; jobId?: string; imageDataUrl?: string }> {
  if (!fetchDataUrl) return { ok: true, cdnUrl, jobId }
  const imageDataUrl = await fetchCdnAsDataUrl(cdnUrl, proxyUrl)
  return { ok: true, cdnUrl, jobId, imageDataUrl }
}

/** 创建后轮询 Lovemi 立绘（中转站只识图，不生图） */
export async function waitLovemiPortrait(input: {
  characterId: string
  sessionToken: string
  proxyUrl: string
  jobId?: string
  timeoutMs?: number
  /** 失败或刷新时强制再触发一次生图 job */
  forceRestart?: boolean
  shouldCancel?: () => boolean
}): Promise<{
  ok: boolean
  error?: string
  cdnUrl?: string
  jobId?: string
  imageDataUrl?: string
  jobStatus?: string
  assetId?: string
}> {
  return withPortraitWaitSlot(input.characterId, () => waitLovemiPortraitLoop(input))
}

async function waitLovemiPortraitLoop(input: {
  characterId: string
  sessionToken: string
  proxyUrl: string
  jobId?: string
  timeoutMs?: number
  forceRestart?: boolean
  shouldCancel?: () => boolean
}): Promise<{
  ok: boolean
  error?: string
  cdnUrl?: string
  jobId?: string
  imageDataUrl?: string
  jobStatus?: string
  assetId?: string
}> {
  const timeoutMs = input.timeoutMs ?? 600_000 // 生图常要 5–10 分钟
  const started = Date.now()
  let lastErr = ''
  let jobId = input.forceRestart ? undefined : input.jobId
  let triedStart = Boolean(input.forceRestart)
  let failRestartCount = 0
  const maxFailRestarts = 6
  let jobStatus = ''
  let lastLoggedJobLine = ''
  const cancelled = () => input.shouldCancel?.() === true

  if (input.forceRestart) {
    if (cancelled()) return { ok: false, error: '任务已取消' }
    appendConsoleLog({
      level: 'info',
      action: 'create_char',
      message: `重新触发 Lovemi 生图 · ${input.characterId.slice(0, 18)}`,
    })
    jobId = await tryStartPortraitJob({
      characterId: input.characterId,
      sessionToken: input.sessionToken,
      proxyUrl: input.proxyUrl,
    })
  }

  while (Date.now() - started < timeoutMs) {
    if (cancelled()) return { ok: false, error: '任务已取消', jobId, jobStatus }
    if (!jobId) {
      jobId = await discoverPortraitJobId({
        characterId: input.characterId,
        sessionToken: input.sessionToken,
        proxyUrl: input.proxyUrl,
        minCreatedAt: input.forceRestart ? started : undefined,
      })
    }

    if (!jobId && !triedStart && Date.now() - started > 8_000) {
      triedStart = true
      jobId = await tryStartPortraitJob({
        characterId: input.characterId,
        sessionToken: input.sessionToken,
        proxyUrl: input.proxyUrl,
      })
    }

    if (jobId) {
      const job = await lovemiGetJson({
        path: `/v1/jobs/${encodeURIComponent(jobId)}`,
        sessionToken: input.sessionToken,
        proxyUrl: input.proxyUrl,
      })
      if (job.ok) {
        const jobAt = jobRecordTime(job.data)
        if (input.forceRestart && jobAt && jobAt < started - 5000) {
          lastErr = `忽略重新生图前的旧 job ${jobId}`
          jobId = undefined
          await sleep(1200)
          continue
        }
        const st = String(job.data.status || '')
        jobStatus = st
        const outputs =
          job.data.outputs && typeof job.data.outputs === 'object'
            ? (job.data.outputs as Record<string, unknown>)
            : {}
        const outputAssetId = pickAssetId(outputs)
        const outputCdn = pickPortraitUrl(outputs)
        const detail = extractJobError(job.data)
        const errorCode = extractJobErrorCode(job.data)
        const live = (job.data.live || {}) as Record<string, unknown>
        const progress = live.progress != null ? ` · ${live.progress}%` : ''
        const line = `Lovemi 生图 ${st}${progress}`
        // 同状态刷屏（尤其 created）只记一次
        if (line !== lastLoggedJobLine) {
          lastLoggedJobLine = line
          appendConsoleLog({
            level: 'info',
            action: 'create_char',
            message: line,
          })
        }
        if (isJobStatusTerminal(st) && !outputAssetId && !outputCdn && (detail || errorCode)) {
          const hardFail = `Lovemi 生图终态无输出 · ${st}${errorCode ? ` · ${errorCode}` : ''}${detail ? ` · ${detail}` : ''}`
        const hardFail2 = `Lovemi 生图终态无输出 · job=${jobId} · ${st}${
          errorCode ? ` · ${errorCode}` : ''
        }${detail ? ` · ${detail}` : ''}`
          appendConsoleLog({
            level: 'warn',
            action: 'create_char',
          message: hardFail2.slice(0, 900),
          })
          const mode = isNonRetriablePortraitErrorCode(errorCode) ? '不可重试' : '需重试'
          return {
            ok: false,
            error: `生图失败（${mode}）· ${errorCode || st}${detail ? ` · ${detail}` : ''}`,
            jobId,
            jobStatus: st,
          }
        }
        if (/fail|error|cancel/i.test(st)) {
          const failLine = `Lovemi 生图 ${st}${detail ? ` · ${detail}` : ''}`
          if (failLine !== lastLoggedJobLine) {
            lastLoggedJobLine = failLine
            appendConsoleLog({
              level: 'warn',
              action: 'create_char',
              message: failLine,
            })
          }
          const failedJobId = jobId
          if (cancelled()) return { ok: false, error: '任务已取消', jobId, jobStatus }
          const next = await tryStartPortraitJob({
            characterId: input.characterId,
            sessionToken: input.sessionToken,
            proxyUrl: input.proxyUrl,
          })
          if (next && next !== failedJobId) {
            jobId = next
            failRestartCount += 1
            lastLoggedJobLine = ''
            await sleep(3000 + failRestartCount * 2000)
            continue
          }
          const alt = await discoverPortraitJobId({
            characterId: input.characterId,
            sessionToken: input.sessionToken,
            proxyUrl: input.proxyUrl,
            excludeJobIds: failedJobId ? [failedJobId] : undefined,
            minCreatedAt: input.forceRestart ? started : undefined,
          })
          if (alt && alt !== failedJobId) {
            jobId = alt
            lastLoggedJobLine = ''
            await sleep(2000)
            continue
          }
          if (failRestartCount < maxFailRestarts) {
            failRestartCount += 1
            triedStart = true
            jobId = undefined
            lastLoggedJobLine = ''
            appendConsoleLog({
              level: 'warn',
              action: 'create_char',
              message: `生图失败暂未开出新 job，${failRestartCount}/${maxFailRestarts} 后再试 · ${input.characterId.slice(0, 18)}`,
            })
            await sleep(10_000 + failRestartCount * 5000)
            continue
          }
          return {
            ok: false,
            error: `生图 job 失败：${st}${detail ? ` · ${detail}` : ''}（已重试 ${failRestartCount} 次，可点「重新生图」）`,
            jobId,
            jobStatus: st,
          }
        }
        if (outputCdn) {
          return {
            ...(await portraitFromCdn(outputCdn, input.proxyUrl, jobId)),
            jobStatus: st,
            assetId: outputAssetId,
          }
        }
        // job 已完成但 cdn 尚未写入：先拿 asset_id
        if (/complete|succeed|success|done/i.test(st) || st === 'completed') {
          if (outputAssetId) {
            // 再等一轮 CDN；同时把 asset 带回
            if (outputCdn) {
              return {
                ...(await portraitFromCdn(outputCdn, input.proxyUrl, jobId)),
                jobStatus: st,
                assetId: outputAssetId,
              }
            }
            lastErr = detail || errorCode || `job ${st} 但 outputs 尚无可用 cdn`
          }
        }
      } else {
        lastErr = job.error || '读 job 失败'
      }
    }

    const ch = await lovemiGetJson({
      path: `/v1/characters/${encodeURIComponent(input.characterId)}`,
      sessionToken: input.sessionToken,
      proxyUrl: input.proxyUrl,
    })
    if (ch.ok) {
      if (!jobId) jobId = pickJobId(ch.data)
      const candidate = ch.data.latest_portrait_candidate as Record<string, unknown> | undefined
      const visualProfile = ch.data.visual_profile as Record<string, unknown> | undefined
      const strictCandidate = [candidate, visualProfile].find(
        (item) => item && (!jobId || pickJobId(item) === jobId),
      )
      const url = strictCandidate ? pickPortraitUrl(strictCandidate) : undefined
      const assetId = strictCandidate
        ? pickAssetId(strictCandidate)
        : undefined
      if (url) {
        return {
          ...(await portraitFromCdn(url, input.proxyUrl, jobId)),
          jobStatus: jobStatus || 'ready',
          assetId,
        }
      }
    } else {
      lastErr = ch.error || '读角色失败'
    }

    const refs = await lovemiGetJson({
      path: `/v1/characters/${encodeURIComponent(input.characterId)}/visual-references`,
      sessionToken: input.sessionToken,
      proxyUrl: input.proxyUrl,
    })
    if (refs.ok) {
      const items = Array.isArray(refs.data.items) ? (refs.data.items as Record<string, unknown>[]) : []
      const first = items.find(
        (x) =>
          (!jobId || pickJobId(x) === jobId) &&
          ((typeof x.cdn_url === 'string' && x.cdn_url) ||
            (typeof x.asset_id === 'string' && String(x.asset_id).startsWith('asset_'))),
      )
      if (first) {
        const assetId =
          typeof first.asset_id === 'string' && first.asset_id.startsWith('asset_')
            ? first.asset_id
            : pickAssetId(first)
        if (typeof first.cdn_url === 'string' && first.cdn_url) {
          return {
            ...(await portraitFromCdn(
              String(first.cdn_url),
              input.proxyUrl,
              typeof first.source_generation_job_id === 'string' ? first.source_generation_job_id : jobId,
            )),
            jobStatus: jobStatus || 'ready',
            assetId,
          }
        }
        if (assetId) {
          // 有 asset 暂无 CDN：继续轮询，但先记下
          lastErr = `已见立绘 asset ${assetId}，等待 CDN`
        }
      }
    }

    // 角色 assets（active + all；站内已出图时常先落在这里）
    for (const scope of ['active', 'all'] as const) {
      const assets = await lovemiGetJson({
        path: `/v1/characters/${encodeURIComponent(input.characterId)}/assets?scope=${scope}`,
        sessionToken: input.sessionToken,
        proxyUrl: input.proxyUrl,
      })
      if (!assets.ok) continue
      const items = Array.isArray(assets.data.items) ? (assets.data.items as Record<string, unknown>[]) : []
      const img = items.find((it) => {
        const id = typeof it.asset_id === 'string' ? it.asset_id : ''
        const kind = String(it.asset_kind || it.kind || '')
        return (
          id.startsWith('asset_') &&
          !/video/i.test(kind) &&
          (!jobId || pickJobId(it) === jobId)
        )
      })
      if (img?.asset_id) {
        const cdn =
          (typeof img.cdn_url === 'string' && img.cdn_url) ||
          pickDeepCdnUrl(img) ||
          undefined
        if (cdn) {
          return {
            ...(await portraitFromCdn(cdn, input.proxyUrl, jobId)),
            jobStatus: jobStatus || 'ready',
            assetId: String(img.asset_id),
          }
        }
        lastErr = `已见立绘 asset ${String(img.asset_id)}（${scope}），等待 CDN`
      }
    }

    // 站内已出图时优先快轮询；仍无图时略放慢省 QPS
    const elapsed = Date.now() - started
    await sleep(elapsed < 90_000 ? 800 : elapsed < 240_000 ? 1200 : 2000)
  }

  return {
    ok: false,
    error:
      lastErr ||
      `角色已创建，但图片未就绪（job=${jobId || '无'} · ${jobStatus || 'timeout'}）。可点「重新生图」或去站内打开该角色`,
    jobId,
    jobStatus,
  }
}

function pickAssetId(obj: unknown, depth = 0): string | undefined {
  if (!obj || depth > 5) return undefined
  if (typeof obj === 'string' && /^asset_/.test(obj)) return obj
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = pickAssetId(item, depth + 1)
      if (hit) return hit
    }
    return undefined
  }
  if (typeof obj !== 'object') return undefined
  const rec = obj as Record<string, unknown>
  for (const key of ['asset_id', 'id']) {
    const v = rec[key]
    if (typeof v === 'string' && /^asset_/.test(v)) return v
  }
  for (const v of Object.values(rec)) {
    const hit = pickAssetId(v, depth + 1)
    if (hit) return hit
  }
  return undefined
}

/** 从角色立绘 candidate / visual-references / assets / 相关 job 取 input asset_id */
export async function resolvePortraitAssetId(input: {
  characterId: string
  sessionToken: string
  proxyUrl: string
  /** 已知生图 job，优先从 job.outputs 抠 asset */
  jobId?: string
  /** 本次运行开始时间；明确早于此时间的旧素材一律拒绝 */
  minCreatedAt?: number
  retries?: number
}): Promise<{ ok: boolean; error?: string; assetId?: string; cdnUrl?: string }> {
  const retries = input.retries ?? 8
  let lastErr = ''
  let expectedAssetId: string | undefined
  let expectedCdnUrl: string | undefined
  const directAssetId = (item: Record<string, unknown> | undefined) => {
    const value = item?.asset_id
    return typeof value === 'string' && value.startsWith('asset_') ? value : undefined
  }
  const directCdnUrl = (item: Record<string, unknown> | undefined) => {
    if (!item) return undefined
    return typeof item.cdn_url === 'string' && item.cdn_url.startsWith('http')
      ? item.cdn_url
      : pickDeepCdnUrl(item)
  }
  const matchesRun = (item: Record<string, unknown> | undefined) => {
    if (!item) return false
    const characterIds: string[] =
      JSON.stringify(item).match(/(?:chr_|character_)[a-zA-Z0-9_-]+/g) ?? []
    if (characterIds.length && !characterIds.includes(input.characterId)) return false
    const candidateJobId = pickJobId(item)
    if (input.jobId) {
      if (candidateJobId) return candidateJobId === input.jobId
      if (expectedAssetId) return directAssetId(item) === expectedAssetId
      return false
    }
    const at = jobRecordTime(item)
    if (input.minCreatedAt && at && at < input.minCreatedAt - 5000) return false
    return true
  }

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(800 + attempt * 400)

    if (input.jobId) {
      const job = await lovemiGetJson({
        path: `/v1/jobs/${encodeURIComponent(input.jobId)}`,
        sessionToken: input.sessionToken,
        proxyUrl: input.proxyUrl,
      })
      if (job.ok) {
        // 只读 job.outputs。job 根对象里常含 input/reference asset，深挖会把旧图当输出。
        expectedAssetId = pickAssetId(job.data.outputs)
        expectedCdnUrl = pickPortraitUrl(
          (job.data.outputs && typeof job.data.outputs === 'object'
            ? job.data.outputs
            : {}) as Record<string, unknown>,
        )
      } else {
        lastErr = job.error || lastErr
      }
    }

    const ch = await lovemiGetJson({
      path: `/v1/characters/${encodeURIComponent(input.characterId)}`,
      sessionToken: input.sessionToken,
      proxyUrl: input.proxyUrl,
    })
    if (ch.ok) {
      const cand = ch.data.latest_portrait_candidate as Record<string, unknown> | undefined
      const fromCand = directAssetId(cand)
      if (fromCand && matchesRun(cand)) {
        return {
          ok: true,
          assetId: fromCand,
          cdnUrl: directCdnUrl(cand) || (fromCand === expectedAssetId ? expectedCdnUrl : undefined),
        }
      }
      const visualProfile = ch.data.visual_profile as Record<string, unknown> | undefined
      const fromVp = directAssetId(visualProfile)
      if (fromVp && matchesRun(visualProfile)) {
        return {
          ok: true,
          assetId: fromVp,
          cdnUrl: directCdnUrl(visualProfile) || (fromVp === expectedAssetId ? expectedCdnUrl : undefined),
        }
      }
    } else {
      lastErr = ch.error || lastErr
    }

    const refs = await lovemiGetJson({
      path: `/v1/characters/${encodeURIComponent(input.characterId)}/visual-references`,
      sessionToken: input.sessionToken,
      proxyUrl: input.proxyUrl,
    })
    if (refs.ok) {
      const items = Array.isArray(refs.data.items) ? (refs.data.items as Record<string, unknown>[]) : []
      // 优先 accepted，其次任意带 asset_id 的
      const accepted = items.find(
        (x) =>
          String(x.status || '') === 'accepted' &&
          Boolean(directAssetId(x)) &&
          matchesRun(x),
      )
      const first =
        accepted ||
        items.find(
          (x) =>
            Boolean(directAssetId(x)) &&
            matchesRun(x),
        )
      const firstAssetId = directAssetId(first)
      if (firstAssetId) {
        return {
          ok: true,
          assetId: firstAssetId,
          cdnUrl: directCdnUrl(first) || (firstAssetId === expectedAssetId ? expectedCdnUrl : undefined),
        }
      }
    } else {
      lastErr = refs.error || lastErr
    }

    for (const scope of ['active', 'all'] as const) {
      const assets = await lovemiGetJson({
        path: `/v1/characters/${encodeURIComponent(input.characterId)}/assets?scope=${scope}`,
        sessionToken: input.sessionToken,
        proxyUrl: input.proxyUrl,
      })
      if (!assets.ok) {
        lastErr = assets.error || lastErr
        continue
      }
      const items = Array.isArray(assets.data.items) ? (assets.data.items as Record<string, unknown>[]) : []
      const ranked = items.filter((it) => {
        const id = directAssetId(it) || ''
        const kind = String(it.asset_kind || it.kind || '')
        return id.startsWith('asset_') && !/video/i.test(kind) && matchesRun(it)
      })
      ranked.sort((a, b) => jobRecordTime(b) - jobRecordTime(a))
      const prefer = ranked.find((it) => /portrait|cover|still|image|reference/i.test(String(it.asset_kind || it.kind || it.relation_type || '')))
      const hit = prefer || ranked[0]
      const hitAssetId = directAssetId(hit)
      if (hitAssetId) {
        return {
          ok: true,
          assetId: hitAssetId,
          cdnUrl: directCdnUrl(hit) || (hitAssetId === expectedAssetId ? expectedCdnUrl : undefined),
        }
      }
    }
  }

  return { ok: false, error: lastErr || '找不到立绘 asset_id（请先生成立绘）' }
}

/** 已有角色时拉回立绘 CDN（用于草稿恢复 / 对比区回填，不下载 base64） */
export async function fetchCharacterPortraitPreview(input: {
  characterId: string
  sessionToken: string
  proxyUrl: string
  jobId?: string
  minCreatedAt?: number
}): Promise<{ ok: boolean; error?: string; assetId?: string; cdnUrl?: string }> {
  // 单轮快查：给前端 2s 轮询用，不要内部再重试 8 次
  const resolved = await resolvePortraitAssetId({ ...input, retries: 1 })
  if (resolved.ok && resolved.cdnUrl) return resolved

  for (const scope of ['active', 'all'] as const) {
    const assets = await lovemiGetJson({
      path: `/v1/characters/${encodeURIComponent(input.characterId)}/assets?scope=${scope}`,
      sessionToken: input.sessionToken,
      proxyUrl: input.proxyUrl,
    })
    if (!assets.ok) continue
    const items = Array.isArray(assets.data.items) ? (assets.data.items as Record<string, unknown>[]) : []
    const img = items.find((it) => {
      const kind = String(it.asset_kind || it.kind || '')
      const url = typeof it.cdn_url === 'string' ? it.cdn_url : ''
      const candidateJobId = pickJobId(it)
      const at = jobRecordTime(it)
      const runOk =
        (!input.jobId || !candidateJobId || candidateJobId === input.jobId) &&
        (!input.minCreatedAt || !at || at >= input.minCreatedAt - 5000)
      return url && /image|portrait|cover|still/i.test(kind) && runOk
    })
    if (img && typeof img.cdn_url === 'string') {
      return {
        ok: true,
        assetId: typeof img.asset_id === 'string' ? img.asset_id : resolved.assetId,
        cdnUrl: img.cdn_url,
      }
    }
    const any = items.find(
      (it) =>
        typeof it.cdn_url === 'string' &&
        it.cdn_url &&
        !String(it.asset_kind || '').includes('video') &&
        (!input.jobId || !pickJobId(it) || pickJobId(it) === input.jobId) &&
        (!input.minCreatedAt || !jobRecordTime(it) || jobRecordTime(it) >= input.minCreatedAt - 5000),
    )
    if (any && typeof any.cdn_url === 'string') {
      return {
        ok: true,
        assetId: typeof any.asset_id === 'string' ? any.asset_id : resolved.assetId,
        cdnUrl: any.cdn_url,
      }
    }
  }

  const refs = await lovemiGetJson({
    path: `/v1/characters/${encodeURIComponent(input.characterId)}/visual-references`,
    sessionToken: input.sessionToken,
    proxyUrl: input.proxyUrl,
  })
  if (refs.ok) {
    const items = Array.isArray(refs.data.items) ? (refs.data.items as Record<string, unknown>[]) : []
    const first = items.find((x) => typeof x.cdn_url === 'string' && x.cdn_url)
    if (first && typeof first.cdn_url === 'string') {
      return {
        ok: true,
        cdnUrl: first.cdn_url,
        assetId:
          typeof first.asset_id === 'string' && first.asset_id.startsWith('asset_')
            ? first.asset_id
            : resolved.assetId,
      }
    }
  }

  if (resolved.ok && resolved.assetId) {
    return { ok: false, error: '找到立绘 asset 但暂无 CDN 预览', assetId: resolved.assetId }
  }
  return { ok: false, error: resolved.error || '无法拉回立绘预览' }
}

function pickVideoUrl(data: Record<string, unknown>): string | undefined {
  const outputs = Array.isArray(data.outputs) ? (data.outputs as Record<string, unknown>[]) : []
  for (const o of outputs) {
    if (typeof o.cdn_url === 'string' && o.cdn_url) return o.cdn_url
  }
  if (typeof data.cdn_url === 'string' && data.cdn_url) return data.cdn_url
  const result = data.result as Record<string, unknown> | undefined
  if (result && typeof result.cdn_url === 'string') return result.cdn_url
  return undefined
}

/** 图生视频：POST /v1/jobs · video.image_to_video.v1（不会自动设预览） */
export async function startImageToVideo(input: {
  sessionToken: string
  proxyUrl: string
  inputAssetId: string
  prompt: string
  characterId?: string
}): Promise<{ ok: boolean; error?: string; jobId?: string; data?: Record<string, unknown> }> {
  if (!input.proxyUrl) return { ok: false, error: '未配置出站代理' }
  if (!input.sessionToken) return { ok: false, error: '缺少管理员 Bearer' }
  if (!input.inputAssetId) return { ok: false, error: '缺少立绘 asset_id' }
  const prompt = (input.prompt || '').trim() || '自然微动，写实，高级感'
  const threadId = `gen_${createHash('sha256').update(`${input.inputAssetId}|${Date.now()}|${randomUUID()}`).digest('hex').slice(0, 32)}`
  const body = {
    public_model_key: 'video1_pro',
    capability_key: 'video.image_to_video.v1',
    prompt,
    aspect_ratio: 'portrait',
    duration_seconds: 5,
    width: 1088,
    height: 1920,
    input_asset_ids: [input.inputAssetId],
    prompt_enhancement: true,
    metadata: {
      public_model_key: 'video1_pro',
      product_model: 'Video1-pro',
      aspect_ratio: '9:16',
      generation_mode: 'image_to_video',
      generation_thread_id: threadId,
      prompt,
      prompt_enhancement: true,
      ...(input.characterId ? { character_id: input.characterId } : {}),
    },
    requested_options: {
      public_model_key: 'video1_pro',
      model_label: 'Video1-pro',
      aspect_ratio: '9:16',
      aspect: 'portrait',
      width: 1088,
      height: 1920,
      duration_seconds: 5,
      input_asset_ids: [input.inputAssetId],
      prompt,
      prompt_enhancement: true,
      reference_asset_count: 1,
    },
  }
  const res = await lovemiPostJson({
    path: '/v1/jobs',
    sessionToken: input.sessionToken,
    proxyUrl: input.proxyUrl,
    body,
  })
  if (!res.ok) {
    return { ok: false, error: res.error || `HTTP ${res.status}`, data: res.data }
  }
  const jobId = pickJobId(res.data)
  appendConsoleLog({
    level: 'info',
    action: 'create_char',
    message: `已发起图生视频 job ${jobId || '?'} · asset ${input.inputAssetId}`,
  })
  return { ok: true, jobId, data: res.data }
}

/** 轮询视频 job（常见 5–10 分钟） */
export async function waitImageToVideo(input: {
  jobId: string
  sessionToken: string
  proxyUrl: string
  timeoutMs?: number
}): Promise<{
  ok: boolean
  error?: string
  jobId: string
  jobStatus?: string
  cdnUrl?: string
  outputAssetId?: string
}> {
  const timeoutMs = input.timeoutMs ?? 600_000
  const started = Date.now()
  let lastErr = ''
  let jobStatus = ''
  while (Date.now() - started < timeoutMs) {
    const job = await lovemiGetJson({
      path: `/v1/jobs/${encodeURIComponent(input.jobId)}`,
      sessionToken: input.sessionToken,
      proxyUrl: input.proxyUrl,
    })
    if (!job.ok) {
      lastErr = job.error || '读视频 job 失败'
      await sleep(3000)
      continue
    }
    jobStatus = String(job.data.status || '')
    const live = (job.data.live || {}) as Record<string, unknown>
    const progress = live.progress != null ? ` · ${live.progress}%` : ''
    appendConsoleLog({
      level: 'info',
      action: 'create_char',
      message: `Lovemi 视频 ${jobStatus}${progress}`,
    })
    if (/fail|error|cancel/i.test(jobStatus)) {
      const detail =
        (typeof job.data.error === 'string' && job.data.error) ||
        (typeof (job.data.error as { message?: string } | undefined)?.message === 'string' &&
          (job.data.error as { message: string }).message) ||
        ''
      return {
        ok: false,
        error: `视频 job 失败：${jobStatus}${detail ? ` · ${detail}` : ''}`,
        jobId: input.jobId,
        jobStatus,
      }
    }
    if (/complete|succeed|success|done/i.test(jobStatus) || jobStatus === 'completed') {
      const cdnUrl = pickVideoUrl(job.data)
      let outputAssetId = pickAssetId(job.data.outputs) || pickAssetId(job.data)
      // job.outputs 常只有 cdn_url，没有 asset_id → 用 /v1/assets 按 generation_job_id 反查
      if (!outputAssetId) {
        const listed = await lovemiGetJson({
          path: `/v1/assets?limit=30`,
          sessionToken: input.sessionToken,
          proxyUrl: input.proxyUrl,
        })
        if (listed.ok) {
          const items = Array.isArray(listed.data.items)
            ? (listed.data.items as Record<string, unknown>[])
            : []
          const hit = items.find(
            (it) =>
              String(it.generation_job_id || '') === input.jobId &&
              String(it.asset_kind || '').includes('video') &&
              typeof it.asset_id === 'string' &&
              String(it.asset_id).startsWith('asset_'),
          )
          if (hit?.asset_id) outputAssetId = String(hit.asset_id)
        }
      }
      if (cdnUrl || outputAssetId) {
        return { ok: true, jobId: input.jobId, jobStatus, cdnUrl, outputAssetId }
      }
      // completed but url not yet populated
    }
    await sleep(4000)
  }
  return {
    ok: false,
    error: `等待视频超时（job=${input.jobId} · ${jobStatus || 'timeout'}）`,
    jobId: input.jobId,
    jobStatus,
  }
}

/** 立绘 asset → 图生视频 → 轮询（不自动设预览） */
export async function generateMotionVideo(input: {
  characterId: string
  sessionToken: string
  proxyUrl: string
  prompt?: string
  inputAssetId?: string
}): Promise<{
  ok: boolean
  error?: string
  jobId?: string
  inputAssetId?: string
  outputAssetId?: string
  cdnUrl?: string
  note?: string
}> {
  const asset =
    input.inputAssetId
      ? { ok: true as const, assetId: input.inputAssetId }
      : await resolvePortraitAssetId({
          characterId: input.characterId,
          sessionToken: input.sessionToken,
          proxyUrl: input.proxyUrl,
        })
  if (!asset.ok || !asset.assetId) return { ok: false, error: asset.error || '无立绘 asset' }

  const started = await startImageToVideo({
    sessionToken: input.sessionToken,
    proxyUrl: input.proxyUrl,
    inputAssetId: asset.assetId,
    prompt: input.prompt || '自然微动，呼吸感，写实高级感，禁止夸张变形',
    characterId: input.characterId,
  })
  if (!started.ok || !started.jobId) {
    return { ok: false, error: started.error || '发起视频失败', inputAssetId: asset.assetId }
  }
  const waited = await waitImageToVideo({
    jobId: started.jobId,
    sessionToken: input.sessionToken,
    proxyUrl: input.proxyUrl,
  })
  if (!waited.ok) {
    return {
      ok: false,
      error: waited.error,
      jobId: waited.jobId,
      inputAssetId: asset.assetId,
    }
  }
  return {
    ok: true,
    jobId: waited.jobId,
    inputAssetId: asset.assetId,
    outputAssetId: waited.outputAssetId,
    cdnUrl: waited.cdnUrl,
    note: '视频已生成，不会自动设预览；发布前需手动设为动态预览',
  }
}

export async function createLovemiCharacter(input: {
  sessionToken: string
  proxyUrl: string
  body: Record<string, unknown>
  waitPortrait?: boolean
}): Promise<{
  ok: boolean
  error?: string
  status?: number
  data?: Record<string, unknown>
  portrait?: { cdnUrl?: string; jobId?: string; imageDataUrl?: string; assetId?: string }
}> {
  if (!input.proxyUrl) return { ok: false, error: '未配置出站代理' }
  if (!input.sessionToken) return { ok: false, error: '缺少管理员 Bearer' }
  const url = `${LOVEMI}/v1/characters`
  const body = sanitizeCreateBody(input.body || {})
  // 短 appearance_tags 对齐官网；立绘长文不进 appearance_tags（否则易 PROMPT_COMPILATION_FAILED）
  prunePersonalityAndTagItems(body)
  const appearance = Array.isArray(body.appearance_tags) ? (body.appearance_tags as unknown[]).map(String) : []
  ensureBodyHairTag(appearance, body)
  body.appearance_tags = appearance
  stripLihuiAppearanceTags(body)
  pruneAppearanceTags(body)
  const idem = `character-agent:${createHash('sha256')
    .update(`${input.sessionToken}|${JSON.stringify(body)}|${randomUUID()}`)
    .digest('hex')
    .slice(0, 32)}`
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.sessionToken}`,
        Origin: 'https://app.lovemi.ai',
        Referer: 'https://app.lovemi.ai/',
        'Accept-Language': 'zh-CN',
        'Idempotency-Key': idem,
      },
      body: JSON.stringify(body),
      dispatcher: dispatcherFor(input.proxyUrl, url),
      signal: AbortSignal.timeout(60_000),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const msg =
        (typeof data.message === 'string' && data.message) ||
        (typeof data.error === 'string' && data.error) ||
        `HTTP ${res.status}`
      return { ok: false, error: msg, status: res.status, data }
    }

    if (input.waitPortrait === false) return { ok: true, status: res.status, data }

    const characterId = pickCharacterId(data)
    if (!characterId) {
      return { ok: true, status: res.status, data, error: '已创建，但响应里没有 character id，无法轮询立绘' }
    }
    const waited = await waitLovemiPortrait({
      characterId,
      sessionToken: input.sessionToken,
      proxyUrl: input.proxyUrl,
      jobId: pickJobId(data),
    })
    const portrait = {
      cdnUrl: waited.cdnUrl,
      jobId: waited.jobId,
      imageDataUrl: waited.imageDataUrl,
      assetId: waited.assetId,
    }
    // 立绘好了但没带 asset：立刻再解析一轮
    if (waited.ok && !portrait.assetId) {
      const resolved = await resolvePortraitAssetId({
        characterId,
        sessionToken: input.sessionToken,
        proxyUrl: input.proxyUrl,
        jobId: waited.jobId,
        retries: 3,
      })
      if (resolved.assetId) portrait.assetId = resolved.assetId
      if (!portrait.cdnUrl && resolved.cdnUrl) portrait.cdnUrl = resolved.cdnUrl
    }
    if (!waited.ok) {
      return {
        ok: true,
        status: res.status,
        data,
        portrait,
        error: waited.error || '角色已创建，立绘仍在生成',
      }
    }
    return { ok: true, status: res.status, data, portrait }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export { saveCreateCharSecrets, loadCreateCharSecrets }
