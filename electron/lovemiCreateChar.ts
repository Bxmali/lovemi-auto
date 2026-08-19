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
    "发型:必须超细（刘海形状/遮眼侧/层次/蓬松度/碎发/长度落点/有无扎发；禁止擅自加丸子头或改发型）",
    "发质:卷直纹理光泽蓬松凌乱度",
    "体型:...",
    "胸型:...",
    "臀型:...",
    "肤色:#RRGGBB",
    "瞳色:#RRGGBB",
    "发色:#RRGGBB",
    "朝向:身体与脸相对镜头的左右朝向（观众视角，禁止左右镜像）",
    "惯用手:持物在左/右手（观众视角，禁止左右互换）",
    "服装:在参考图服装基础上更性感暴露（深V/高开衩/短下摆/吊带等），材质配色剪裁配件仍复刻参考图，禁止露点",
    "露肤度:比参考图更暴露但不露点、不透明到乳头",
    "脚:若参考图出现脚/足必须超细写（见 FOOT LOCK）；无脚则写「画面未出现脚」",
    "配饰:头饰/耳饰/手套/袜/鞋等（必填，有则写全；无鞋禁止擅自加高跟鞋）",
    "姿势:身体姿态手势重心朝向（必填，与朝向/惯用手一致；含腿与脚相对镜头位置）",
    "背景:场景环境景深（必填）",
    "表情:眼神嘴角情绪（必填）",
    "气质:一句话气质锁（必填）"
  ],
  "fantasy_species_tags": [],
  "occupation_tags": ["..."],
  "personality_tags": ["性格短标签…","对话风格:Chloe","职业:…","性癖:真实生理/性需求，见 SEXUAL KINK RULES"],
  "relationship_tags": ["从下方关系池随机选 1 个，不要永远陌生人"],
  "style_tags": ["写实"],
  "supported_lab_apps": ["companion","intimacy_lab","galgame","adult_film_director"],
  "custom_parameter_access_level": "basic",
  "tag_items": ["short","labels"],
  "tag_selections": [{"kind":"preset","preset_id":"gender.female"},{"kind":"preset","preset_id":"style.realistic"}],
  "ancestry_region": "east_asian"|"western"|"other",
  "portrait_prompt": "超长中文立绘提示词，见下方规则"
}

SEXUAL KINK RULES（性癖 = 生理/性需求，不是性格）：
- personality_tags MUST include one tag starting with「性癖:」describing THIS character's adult sexual preferences / turn-ons.
- 性癖 means what they want sexually (acts, body focus, power dynamics) — NOT everyday personality.
- FORBIDDEN as 性癖 (these are NOT kinks): 喜欢被夸奖、害羞、粘人、撒娇、温柔、腹黑、傲娇、社恐、怕黑、爱干净、喜欢吃甜食, etc. Everyone likes praise — that is not a 性癖.
- GOOD examples (pick 1–2 concrete adult ones matching vibe/look; vary across runs):
  性癖:喜欢给男朋友足交、足底与脚趾挑逗
  性癖:享受被口到腿软、主动按着对方头
  性癖:轻微SM、喜欢被绑手腕轻咬锁骨
  性癖:乳交与被玩弄乳头会很快湿
  性癖:喜欢骑乘位自己动、边做边看对方失神
  性癖:高潮后还想被内射、余韵里求再来一次
  性癖:喜欢在镜子前被后入、盯着自己被干的样子
  性癖:耳边脏话与命令式语气会立刻兴奋
- Keep it adult, specific, and character-flavored. Do NOT write vague「性格温柔」as 性癖.

NAME RULES:
- display_name: invent a UNIQUE cute **Chinese** girl name (2 **or** 3 汉字，三字也要常有). NEVER reuse 柚子/千夏/陽葵/芽衣/宁宁/瑾萱/葵/琴音 or any name you just used.
- The app WILL replace display_name from a large unused Chinese pool — still invent varied CN names; never blank; NO digits; avoid JP-only names unless the character is clearly Japanese.

RELATIONSHIP RULES:
- relationship_tags MUST be exactly ONE string randomly chosen from:
  ["陌生人","青梅竹马","同事","邻居","网友","合租室友","暗恋对象","学长学妹","前同事","偶遇","粉丝","笔友","社团同伴","远房表亲","上下级","客户"]
- Do NOT always use 陌生人. Vary across runs.

CRITICAL — Lovemi image job mostly reads SHORT appearance_tags, NOT only the long 立绘提示词.
So appearance_tags MUST lock the reference with concrete Chinese short labels:
- Never output bare face/hair only.
- ORIENTATION LOCK (critical): describe left/right from the VIEWER's perspective. If reference holds phone in RIGHT hand, tags must say 右手持手机 — NEVER mirror to left. If body leans / face turns to viewer's right, write that side explicitly. Add tags 朝向:… and 惯用手:…. Forbid 左右镜像 / mirrored pose.
- HAIR LOCK (critical): 发型 tag must be HIGH DETAIL — bangs shape, which eye covered, layers, volume/messiness, strand fall, whether hair is tied. Do NOT invent a top bun / odango / neat idol cut if the reference is loose messy voluminous hair. Add 发质:… for texture.
- FOOT / 足 LOCK (critical — models often DROP feet):
  - If ANY foot/sole/toe/ankle/socked-foot/shoe is visible in the reference (even at frame bottom), you MUST output a dedicated short tag 脚:… AND strengthen feet in 姿势 + portrait_prompt.
  - Describe: 脚是否朝镜头、脚掌/脚心是否朝向观众、脚趾并拢还是张开、脚在画面前景还是被裁切、是否穿丝袜/裤袜/裸足、有无鞋（种类）、袜的材质颜色覆盖到哪。
  - If feet are a FOCAL point in the reference (large in foreground, soles facing camera, between camera and body), write explicitly: 脚部前景占比大、足部是构图重点、低机位突出脚掌/脚心 — NEVER shrink feet to tiny tips at the bottom edge.
  - NEVER invent 高跟鞋 / sandals / boots if reference has no shoes (e.g. only lace tights covering feet). Match 袜 vs 鞋 exactly.
  - If no feet visible at all, 脚:画面未出现脚.
- 服装 / 配饰 / 姿势 / 背景 / 表情 / 气质 / 脚 are MANDATORY fields (脚 always present as above).
- CLOTHING EXPOSURE: keep the reference outfit identity (colors/style/accessories) but make it mildly MORE revealing / sexy than the photo — deeper cleavage, higher slit, shorter hem, thinner straps, more shoulder/thigh/waist skin, tighter fit, sheer side panels OK. NEVER show nipples / areola / 露点 / fully bare breasts / transparent fabric over nipples / pubic exposure. Add tag 露肤度:….

REGION RULES:
- East Asian / 东亚 / 中日韩 (CRITICAL — models love drifting to Western faces):
  - ancestry_region MUST be "east_asian"
  - ancestry_tags MUST include "东亚裔" (and may add 华裔/日系/韩系 if look matches)
  - appearance_tags MUST repeatedly lock: 人种:东亚中日韩, 五官:东亚脸型, 禁止欧美五官, 禁止高加索面孔, 禁止西方混血跑偏
  - portrait_prompt MUST open with and keep repeating: 东亚女性/中日韩面孔、东亚五官、不是欧美脸
  - HARD moe stack (adult 20+): personality_tags + tag_items MUST include many of: 超可爱, 萌妹, 软萌, 甜美, 娇软, 超级娇羞, 粘人, 撒娇, 依赖感, 想被抱抱, 可爱到犯规, 水润大眼, 粉嫩皮肤, 想捏的小脸蛋, 娇滴滴
  - 气质 tag: 萌妹娇羞粘人东亚感. Expression cute/shy — NOT cold Western model face, NOT deep-set Caucasian eyes, NOT high nose bridge Western sculpt
  - If reference is East Asian, NEVER output western / european / mixed Caucasian identity
- Western / 欧美: ancestry_region="western". PERFECT identity lock — photoreal fidelity, no kawaii spam.

portrait_prompt RULES (Chinese, for Lovemi 立绘 tag; still write it even though short tags matter more):
ONE long paragraph 350–750 字. Order of content MUST be:
1) 若东亚：先写死「东亚中日韩面孔/五官」防跑偏欧美，再写朝向与惯用手（观众视角左右锁死，禁止镜像）+ 构图视角 + 姿势动作
2) 若参考图有脚：紧接写足部构图（脚掌/脚心朝向、前景占比、袜/鞋、脚趾姿态）——禁止省略脚；脚大就写脚大
3) 发型发色发质超细节（刘海/遮眼/层次/蓬松凌乱/碎发；禁止擅自改发型）
4) 完整服装与配饰（材质颜色层次；在参考图基础上更暴露性感，但不露点；鞋袜与参考一致，禁止乱加高跟鞋）
5) 背景环境与光线
6) 五官气质表情（东亚：超级可爱娇羞粘人萌妹感 + 明确东亚五官细节）
7) 写真级真实感 / 拒绝AI塑料感 / 可含身高约值
Must be locked to THIS reference — do not swap outfit identity, flip left/right, simplify hair, or drop/minimize visible feet.
Do NOT wrap in「立绘提示词:」prefix (we add that later).
In clothing description explicitly: 比参考图更暴露但不露点.
For East Asian: throughout the paragraph keep saying 东亚/中日韩，forbid 欧美脸.

Adult only. Prefer 写实.`

function ensureTagged(list: string[], prefix: string, fallback: string) {
  if (!list.some((t) => t.startsWith(prefix))) list.push(`${prefix}${fallback}`)
}

function pushUnique(list: string[], items: string[]) {
  for (const item of items) {
    if (!list.some((x) => x === item || x.includes(item))) list.push(item)
  }
}

/** Lovemi 生图更吃短 tag：补齐服装/姿势/背景/萌系气质 */
function reinforceVisualAndCuteTags(payload: Record<string, unknown>, isEast: boolean) {
  const appearance = Array.isArray(payload.appearance_tags)
    ? (payload.appearance_tags as unknown[]).map(String)
    : []
  ensureTagged(appearance, '服装:', '复刻参考图服装但更性感暴露（深V/开衩/短下摆），禁止露点')
  ensureTagged(appearance, '露肤度:', '比参考图更暴露但不露点')
  ensureTagged(appearance, '配饰:', '复刻参考图头饰配饰手套袜鞋，无鞋禁止加高跟鞋')
  ensureTagged(appearance, '姿势:', '复刻参考图身体姿态与手势，禁止左右镜像')
  ensureTagged(appearance, '朝向:', '观众视角左右与参考图一致，禁止镜像')
  ensureTagged(appearance, '惯用手:', '持物左右手与参考图一致，禁止左右互换')
  ensureTagged(appearance, '发型:', '复刻参考图刘海层次蓬松碎发，禁止擅自改扎发')
  ensureTagged(appearance, '发质:', '复刻参考图发丝纹理与凌乱蓬松度')
  ensureTagged(appearance, '背景:', '复刻参考图场景与景深')
  ensureTagged(appearance, '表情:', isEast ? '超级娇羞可爱对视' : '复刻参考图表情')
  ensureTagged(appearance, '气质:', isEast ? '萌妹超级娇羞粘人' : '完美复刻参考气质')
  ensureTagged(appearance, '脚:', '复刻参考图足部：朝向/脚掌脚心/前景占比/袜或鞋；有脚必须写细，禁止缩小脚或乱加高跟鞋')
  pushUnique(appearance, [
    '禁止左右镜像',
    '发型细节锁死禁止简化',
    '禁止露点',
    '禁止透明到乳头',
    '服装比参考图更暴露性感',
    '足部细节锁死禁止省略',
    '禁止擅自添加高跟鞋',
  ])

  // 若姿势/配饰已暗示有脚，强化脚部前景，并去掉乱加的鞋类（保留袜）
  const blob = appearance.join('｜')
  const feetLikely =
    /脚|足|脚掌|脚心|脚趾|丝袜|裤袜|蕾丝袜|裸足|鞋|坐|双腿|大腿/.test(blob) &&
    !/脚:画面未出现脚/.test(blob)
  if (feetLikely) {
    const footIdx = appearance.findIndex((t) => t.startsWith('脚:'))
    const strongFoot =
      '脚:参考图足部必须完整保留——脚在画面前景占比大、朝向镜头、脚掌/脚心细节可见时要写明；袜/裸足与参考一致；禁止把脚缩成画面底边小尖；禁止无鞋却加高跟鞋'
    if (footIdx >= 0) {
      const cur = appearance[footIdx]
      if (cur.length < 40 || /未出现/.test(cur) || !/前景|脚掌|脚心|足/.test(cur)) {
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
      '东亚锁:中日韩面孔',
      '禁止欧美五官',
      '禁止高加索面孔',
      '禁止西方混血跑偏',
      '禁止欧美模特脸',
      '萌系脸:水润大眼粉嫩软妹',
      '可爱感:超级可爱想捏脸',
      '氛围:娇羞粘人撒娇东亚感',
    ])
    ensureTagged(appearance, '人种:', '东亚中日韩')
    ensureTagged(appearance, '五官:', '东亚脸型，不是欧美深邃五官')
  }
  payload.appearance_tags = appearance

  const personality = Array.isArray(payload.personality_tags)
    ? (payload.personality_tags as unknown[]).map(String)
    : []
  if (isEast) {
    pushUnique(personality, [
      '超可爱',
      '萌妹',
      '软萌',
      '甜美可人',
      '超级娇羞',
      '粘人',
      '撒娇',
      '依赖感强',
      '可爱到犯规',
      '娇滴滴',
      '东亚萌妹感',
    ])
  }
  payload.personality_tags = personality

  const items = Array.isArray(payload.tag_items) ? (payload.tag_items as unknown[]).map(String) : []
  if (isEast) {
    pushUnique(items, ['萌', '可爱', '软萌', '娇羞', '粘人', '撒娇', '东亚', '中日韩'])
  }
  payload.tag_items = items

  const style = Array.isArray(payload.style_tags) ? (payload.style_tags as unknown[]).map(String) : []
  pushUnique(style, ['写实', '写真'])
  if (isEast) pushUnique(style, ['萌系', '东亚'])
  payload.style_tags = style

  if (isEast) {
    payload.ancestry_region = 'east_asian'
    const ancestry = Array.isArray(payload.ancestry_tags)
      ? (payload.ancestry_tags as unknown[]).map(String)
      : []
    pushUnique(ancestry, ['东亚裔'])
    // 去掉明显欧美跑偏标签
    payload.ancestry_tags = ancestry.filter((t) => !/欧洲|欧美|高加索|western|caucasian|european/i.test(t))
    if (!payload.ancestry_tags.length) payload.ancestry_tags = ['东亚裔']
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
  if (
    region === 'western' ||
    /欧美|欧洲|western|caucasian|european|英伦|法式|德系/.test(blob)
  ) {
    return 'en'
  }
  // 明确韩国风才用韩名
  if (/(^|[^日])韩系|韩国|korean|korea|首尔|韩风/.test(blob) && !/中国|华语|中式|chinese/.test(blob)) {
    return 'kr'
  }
  // 明确日本风才用日名（「日系」 alone 不够 — 东亚立绘常误标日系导致撞 千夏/陽葵）
  if (
    (/日本|和风|和服|京都|japanese|japan/.test(blob) || /日系萌|纯日系/.test(blob)) &&
    !/中国|华语|中式|chinese|汉服/.test(blob)
  ) {
    return 'jp'
  }
  // 默认：中文甜名（词库最大，最不易撞）
  return 'zh'
}

function extractNameFromUserHint(hint?: string): string | undefined {
  const h = (hint || '').trim()
  if (!h) return undefined
  const m =
    h.match(/(?:名字|昵称|叫|名为|name)\s*[:：是为]?\s*[「『"']?([\u4e00-\u9fffA-Za-z·]{2,12})/) ||
    h.match(/^[「『"']?([\u4e00-\u9fff]{2,4})[」』"']?\s*$/)
  const name = m?.[1]?.trim()
  if (!name || /^\d+$/.test(name)) return undefined
  return name
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
 * 可爱女孩名：默认中文大词库抽**未用过**的；用户 hint 指定则尊重。
 * 不信任模型返回名（极易撞车）。
 */
function ensureDisplayName(payload: Record<string, unknown>, userHint?: string) {
  const hinted = extractNameFromUserHint(userHint)
  if (hinted) {
    payload.display_name = hinted.replace(/\d+/g, '').trim() || hinted
    rememberName(payload.display_name)
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
  '喜欢给男朋友足交、足底脚趾慢慢磨',
  '享受被口到发颤、会按着对方的头',
  '轻微SM、喜欢被绑手腕轻咬锁骨',
  '乳交与被玩弄乳头会很快湿',
  '喜欢骑乘位自己摇、边看对方失神',
  '高潮后还想被内射、余韵里求再来',
  '喜欢镜子前被后入、盯着自己被干',
  '耳边脏话和命令语气会立刻兴奋',
  '喜欢被边摸边夸骚、越羞越想要',
  '迷恋被手指玩到求饶再换成真枪',
  '喜欢用腿夹住对方腰不让拔出去',
  '对颈部亲吻和低喘特别敏感',
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

/** 性癖必须是生理/性需求；把「喜欢被夸奖」这类假性癖换掉 */
function ensureSexualKinks(payload: Record<string, unknown>) {
  const personality = Array.isArray(payload.personality_tags)
    ? (payload.personality_tags as unknown[]).map(String)
    : []
  const kinkIdx = personality.findIndex((t) => /^性癖[:：]/.test(t))
  const pick = () => SEXUAL_KINK_POOL[Math.floor(Math.random() * SEXUAL_KINK_POOL.length)]
  if (kinkIdx >= 0) {
    if (isFakeSexualKink(personality[kinkIdx])) {
      personality[kinkIdx] = `性癖:${pick()}`
    }
  } else {
    personality.push(`性癖:${pick()}`)
  }
  payload.personality_tags = personality
}

/** 立绘长提示词：有脚必须钉死足部，禁止省略/缩小/乱加鞋 */
function reinforceFootPortraitPrompt(payload: Record<string, unknown>) {
  const appearance = Array.isArray(payload.appearance_tags)
    ? (payload.appearance_tags as unknown[]).map(String)
    : []
  const footTag = appearance.find((t) => t.startsWith('脚:')) || ''
  if (/未出现脚/.test(footTag)) {
    payload.appearance_tags = appearance
    return
  }
  const feetLikely =
    /脚|足|脚掌|脚心|脚趾|丝袜|裤袜|蕾丝袜|裸足|双腿|大腿|坐/.test(appearance.join('｜')) &&
    !/脚:画面未出现脚/.test(footTag)
  if (!feetLikely) {
    payload.appearance_tags = appearance
    return
  }
  const lock =
    '【足部锁死】参考图中的脚必须作为构图重点完整保留：脚部前景占比、脚掌/脚心朝向镜头、脚趾与袜足细节写清楚；禁止弱化成画面底边小尖；禁止无鞋却添加高跟鞋。'
  const idx = appearance.findIndex((t) => t.startsWith('立绘提示词:'))
  if (idx >= 0) {
    const raw = appearance[idx].replace(/^立绘提示词:/, '')
    if (!/足部锁死|脚掌|脚心|足部前景/.test(raw)) {
      appearance[idx] = `立绘提示词:${lock}${raw}`
    }
    // 长提示词里若写了高跟鞋但有袜足描述，去掉高跟鞋措辞
    if (/蕾丝袜|裤袜|丝袜|袜足|裸足/.test(appearance[idx]) && /高跟/.test(appearance[idx])) {
      appearance[idx] = appearance[idx]
        .replace(/透明感高跟鞋/g, '袜足无鞋')
        .replace(/高跟鞋/g, '无鞋')
    }
  }
  payload.appearance_tags = appearance
}

/** 东亚立绘长提示词再钉死一轮，防止生图跑欧美 */
function reinforceEastAsianPortraitPrompt(payload: Record<string, unknown>, isEast: boolean) {
  if (!isEast) return
  const lock =
    '【东亚锁死】必须是东亚中日韩面孔与五官，东亚黑发或参考发色，东亚皮肤质感；禁止欧美脸、禁止高加索深邃五官、禁止西方混血跑偏。'
  const appearance = Array.isArray(payload.appearance_tags)
    ? (payload.appearance_tags as unknown[]).map(String)
    : []
  const idx = appearance.findIndex((t) => t.startsWith('立绘提示词:'))
  if (idx >= 0) {
    const raw = appearance[idx].replace(/^立绘提示词:/, '')
    if (!/东亚|中日韩|禁止欧美/.test(raw)) {
      appearance[idx] = `立绘提示词:${lock}${raw}`
    }
  }
  payload.appearance_tags = appearance
}

function injectLihuiTag(payload: Record<string, unknown>, portraitPrompt: string) {
  const prompt = portraitPrompt.trim()
  if (!prompt) return
  const tag = prompt.startsWith('立绘提示词:') ? prompt : `立绘提示词:${prompt}`
  const appearance = Array.isArray(payload.appearance_tags)
    ? (payload.appearance_tags as unknown[]).map(String).filter((t) => !t.startsWith('立绘提示词:'))
    : []
  appearance.push(tag)
  payload.appearance_tags = appearance
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
      'ORIENTATION: lock viewer-left/right — same hand holding props as reference; NO horizontal mirror.',
      'HAIR: ultra-detailed bangs/layers/volume/messiness; do NOT invent bun or simplify.',
      'appearance_tags MUST include 朝向/惯用手/发型/发质/服装/露肤度/脚/配饰/姿势/背景/表情/气质.',
      'portrait_prompt order: 朝向惯用手 → 足部构图(若有脚) → 发型细节 → 服装(更暴露不露点) → 背景 → 五官表情.',
      'FOOT LOCK: if feet/soles/socks visible, MUST detail 脚前景/脚掌朝向/袜或鞋; NEVER drop feet or invent heels when reference is socked/bare.',
      'CLOTHING: sexier/more revealing than reference, NEVER nipples/露点.',
      'If East Asian: HARD lock 东亚中日韩面孔 everywhere — ancestry/tags/portrait_prompt MUST say 东亚 and FORBID 欧美脸; moe 超级娇羞粘人.',
      'If Western: perfect identity lock, premium realism.',
      '性癖 MUST be real sexual preference (足交/被口/SM/骑乘等), NEVER「喜欢被夸奖」类性格.',
      'display_name: UNIQUE cute Chinese 2–3字名 each run; never 柚子/千夏/陽葵/琴音等老面孔；NO digits.',
      hint ? `\nUser notes (must respect for name/lore/occupation):\n${hint}` : '',
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

    const payload = extractJsonObject(content)
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

    const portraitPrompt =
      typeof payload.portrait_prompt === 'string' ? String(payload.portrait_prompt).trim() : ''
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
    ensureSexualKinks(payload)

    // 无字数限制的立绘提示词 → appearance_tags
    if (portraitPrompt) injectLihuiTag(payload, portraitPrompt)
    reinforceEastAsianPortraitPrompt(payload, isEast)
    reinforceFootPortraitPrompt(payload)

    appendConsoleLog({
      level: 'info',
      action: 'create_char',
      message: `分析成功 · ${String(payload.display_name || '?')} · ${secrets.teamoModel}${portraitPrompt ? ' · 已写入立绘提示词tag' : ''}`,
    })
    return { ok: true, payload, portraitPrompt: portraitPrompt || undefined, model: secrets.teamoModel }
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
}): Promise<string | undefined> {
  const paths = [
    `/v1/jobs?character_id=${encodeURIComponent(input.characterId)}`,
    `/v1/characters/${encodeURIComponent(input.characterId)}/jobs`,
  ]
  for (const path of paths) {
    const res = await lovemiGetJson({
      path,
      sessionToken: input.sessionToken,
      proxyUrl: input.proxyUrl,
    })
    if (!res.ok) continue
    const hit = pickJobId(res.data)
    if (hit) return hit
  }
  return undefined
}

async function tryStartPortraitJob(input: {
  characterId: string
  sessionToken: string
  proxyUrl: string
}): Promise<string | undefined> {
  const bodies: Record<string, unknown>[] = [
    {
      capability_key: 'image.generate.v1',
      job_type: 'image',
      public_model_key: 'image1_pro',
      metadata: { character_id: input.characterId, source: 'character_creation' },
      requested_options: {
        aspect_ratio: '9:16',
        width: 1088,
        height: 1920,
        prompt_enhancement: true,
      },
    },
    {
      capability_key: 'image.generate.v1',
      character_id: input.characterId,
      public_model_key: 'image1_pro',
      requested_options: {
        aspect_ratio: '9:16',
        width: 1088,
        height: 1920,
        prompt_enhancement: true,
      },
    },
  ]
  const paths = ['/v1/jobs', `/v1/characters/${encodeURIComponent(input.characterId)}/jobs`]
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
    }
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
  let didFailRestart = false
  let jobStatus = ''
  let lastLoggedJobLine = ''

  if (input.forceRestart) {
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
    if (!jobId) {
      jobId = await discoverPortraitJobId({
        characterId: input.characterId,
        sessionToken: input.sessionToken,
        proxyUrl: input.proxyUrl,
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
        const st = String(job.data.status || '')
        jobStatus = st
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
        if (/fail|error|cancel/i.test(st)) {
          const detail =
            (typeof job.data.error === 'string' && job.data.error) ||
            (typeof (job.data.error as { message?: string } | undefined)?.message === 'string' &&
              (job.data.error as { message: string }).message) ||
            (typeof job.data.message === 'string' && job.data.message) ||
            ''
          if (!didFailRestart) {
            didFailRestart = true
            triedStart = true
            const next = await tryStartPortraitJob({
              characterId: input.characterId,
              sessionToken: input.sessionToken,
              proxyUrl: input.proxyUrl,
            })
            if (next && next !== jobId) {
              jobId = next
              await sleep(2000)
              continue
            }
          }
          return {
            ok: false,
            error: `生图 job 失败：${st}${detail ? ` · ${detail}` : ''}（角色已在，可点「重新生图」）`,
            jobId,
            jobStatus: st,
          }
        }
        const fromJob =
          pickPortraitUrl(job.data) ||
          (typeof job.data.cdn_url === 'string' ? job.data.cdn_url : undefined) ||
          (typeof (job.data.result as Record<string, unknown> | undefined)?.cdn_url === 'string'
            ? String((job.data.result as Record<string, unknown>).cdn_url)
            : undefined)
        if (fromJob) {
          const assetId = pickAssetId(job.data.outputs) || pickAssetId(job.data)
          return {
            ...(await portraitFromCdn(fromJob, input.proxyUrl, jobId)),
            jobStatus: st,
            assetId,
          }
        }
        // job 已完成但 cdn 尚未写入：先拿 asset_id
        if (/complete|succeed|success|done/i.test(st) || st === 'completed') {
          const assetId = pickAssetId(job.data.outputs) || pickAssetId(job.data)
          if (assetId) {
            // 再等一轮 CDN；同时把 asset 带回
            const url = pickPortraitUrl(job.data)
            if (url) {
              return {
                ...(await portraitFromCdn(url, input.proxyUrl, jobId)),
                jobStatus: st,
                assetId,
              }
            }
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
      const url = pickPortraitUrl(ch.data)
      const assetId =
        pickAssetId(ch.data.latest_portrait_candidate) || pickAssetId(ch.data.visual_profile)
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
          (typeof x.cdn_url === 'string' && x.cdn_url) ||
          (typeof x.asset_id === 'string' && String(x.asset_id).startsWith('asset_')),
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
        return id.startsWith('asset_') && !/video/i.test(kind)
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
  retries?: number
}): Promise<{ ok: boolean; error?: string; assetId?: string; cdnUrl?: string }> {
  const retries = input.retries ?? 8
  let lastErr = ''

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(800 + attempt * 400)

    if (input.jobId) {
      const job = await lovemiGetJson({
        path: `/v1/jobs/${encodeURIComponent(input.jobId)}`,
        sessionToken: input.sessionToken,
        proxyUrl: input.proxyUrl,
      })
      if (job.ok) {
        const assetId = pickAssetId(job.data.outputs) || pickAssetId(job.data)
        const cdnUrl = pickPortraitUrl(job.data)
        if (assetId) return { ok: true, assetId, cdnUrl }
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
      const fromCand = pickAssetId(cand)
      if (fromCand) {
        return {
          ok: true,
          assetId: fromCand,
          cdnUrl: typeof cand?.cdn_url === 'string' ? cand.cdn_url : pickPortraitUrl(ch.data),
        }
      }
      const fromVp = pickAssetId(ch.data.visual_profile)
      if (fromVp) return { ok: true, assetId: fromVp, cdnUrl: pickPortraitUrl(ch.data) }
      const jobFromCh = pickJobId(ch.data)
      if (jobFromCh && jobFromCh !== input.jobId) {
        const job = await lovemiGetJson({
          path: `/v1/jobs/${encodeURIComponent(jobFromCh)}`,
          sessionToken: input.sessionToken,
          proxyUrl: input.proxyUrl,
        })
        if (job.ok) {
          const assetId = pickAssetId(job.data.outputs) || pickAssetId(job.data)
          if (assetId) {
            return { ok: true, assetId, cdnUrl: pickPortraitUrl(job.data) || pickPortraitUrl(ch.data) }
          }
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
          typeof x.asset_id === 'string' &&
          String(x.asset_id).startsWith('asset_'),
      )
      const first =
        accepted ||
        items.find((x) => typeof x.asset_id === 'string' && String(x.asset_id).startsWith('asset_'))
      if (first?.asset_id) {
        return {
          ok: true,
          assetId: String(first.asset_id),
          cdnUrl: typeof first.cdn_url === 'string' ? first.cdn_url : undefined,
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
        const id = typeof it.asset_id === 'string' ? it.asset_id : ''
        const kind = String(it.asset_kind || it.kind || '')
        return id.startsWith('asset_') && !/video/i.test(kind)
      })
      const prefer = ranked.find((it) => /portrait|cover|still|image|reference/i.test(String(it.asset_kind || it.kind || it.relation_type || '')))
      const hit = prefer || ranked[0]
      if (hit?.asset_id) {
        return {
          ok: true,
          assetId: String(hit.asset_id),
          cdnUrl: typeof hit.cdn_url === 'string' ? hit.cdn_url : undefined,
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
      return url && /image|portrait|cover|still/i.test(kind)
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
        !String(it.asset_kind || '').includes('video'),
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
  // 若 JSON 里改过提示词，确保 tag 同步
  const appearance = Array.isArray(body.appearance_tags) ? (body.appearance_tags as unknown[]).map(String) : []
  const hasLihui = appearance.some((t) => t.startsWith('立绘提示词:'))
  if (!hasLihui && typeof input.body?.portrait_prompt === 'string') {
    injectLihuiTag(body, String(input.body.portrait_prompt))
  }
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
