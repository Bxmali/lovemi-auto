/**
 * 文案生成：参考图/视频帧 → 中转站
 * - standard：完整社群长文（开场 + 剧情 + 推广 + 星级 + tags）
 * - twitterComment：浓缩诱惑推特评论（宝宝们我是xxx + 细节正文）
 */
import { fetch as undiciFetch } from 'undici'
import { dispatcherFor } from './mailProbe'
import { loadCreateCharSecrets } from './createCharSecrets'

const FIRST = [
  'Nova',
  'Lila',
  'Mira',
  'Ava',
  'Elena',
  'Sienna',
  'Iris',
  'Vera',
  'Nina',
  'Chloe',
  'Luna',
  'Aria',
  'Zoe',
  'Maya',
  'Ruby',
]
const LAST = [
  'Hale',
  'Vale',
  'Quinn',
  'Brooks',
  'Lane',
  'Frost',
  'Reed',
  'Blake',
  'Cole',
  'Hayes',
  'West',
  'Ash',
  'Grey',
  'Moss',
  'Kane',
]

function teamoHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
}

function pickOwnerName() {
  const a = FIRST[Math.floor(Math.random() * FIRST.length)]
  const b = LAST[Math.floor(Math.random() * LAST.length)]
  return `${a} ${b}`
}

function starsLine() {
  const n = 3 + Math.floor(Math.random() * 3) // 3–5
  const icons = '⭐️'.repeat(n)
  const label = n === 5 ? '五星推荐' : n === 4 ? '四星推荐' : '三星推荐'
  return `${icons} ${label}`
}

function ratingLine() {
  const pct = 70 + Math.floor(Math.random() * 31) // 70–100
  return `📊 站内好评率：${pct}%`
}

/** 从文件名推断角色名：去掉扩展名、槽位后缀、asset 尾巴 */
export function characterNameFromFile(fileName?: string): string {
  const raw = String(fileName || '')
    .replace(/\.[^.]+$/i, '')
    .trim()
  if (!raw) return ''
  // 推特资源常见：澄晴萱_槽3_xxx_aset_...
  const head = raw.split(/[_－—\-\s]+/)[0]?.trim() || raw
  // 去掉明显非名字噪声
  if (/^(m-|asset|aset|chr_|slot|槽)/i.test(head)) return ''
  if (head.length > 24) return head.slice(0, 24)
  return head
}

export type CaptionStyle = 'standard' | 'twitterComment'

const SYSTEM_STANDARD = `你是 Lovemi 社群推文文案助手。根据用户给的图片/视频截帧，写**诱惑向、带情绪的中文剧情段**和话题标签。

硬性规则：
1. 角色一律已确认年满 21 岁成年女性；禁止未成年/学生/幼态暗示
2. 只返回 JSON，不要 markdown 代码块，不要解释
3. JSON 形状：
{
  "characterNameGuess": "若用户没给名字，从画面猜一个中文名；有则原样返回",
  "plotBlocks": ["段落1", "段落2", "段落3"],
  "hashtags": ["#名字", "#虚拟女友", "..."]
}
4. plotBlocks：2～4 段，每段 1～4 行，必须保留 \\n 换行；语气娇嗔/委屈/勾人，带 emoji（🥺😭💢😳 等）和少量颜文字；要够诱惑但不要直白色情词堆砌；要贴合画面/视频内容（服装、道具、动作、氛围）
5. 不要写开场「我是 XXX 的虚拟女友」——开场由程序拼
6. 不要写官网推广段、星级、好评率——由程序拼
7. hashtags：6～12 个，以 # 开头，含角色名、虚拟女友、画面元素、Lovemi相关；中文为主`

const SYSTEM_TWITTER = `你是「极短诱惑推特评论」助手。先根据附图选癖好主题，再写**一行**直白话。

硬性规则：
1. 角色一律已确认年满 21 岁成年女性；禁止未成年/学生/幼态/校园/初高中暗示
2. 只返回 JSON，不要 markdown，不要解释
3. JSON 形状：
{
  "characterNameGuess": "若用户没给名字，从画面猜一个中文名；有则原样返回",
  "kinkId": "必须来自用户给的主题表 id",
  "plotBlocks": ["整段就这一行（不要名字开场）"]
}
4. **选主题（最重要）**：
   - 优先看图/视频帧：露脚/脚尖→恋足；丝袜→丝袜癖；胸口/低胸→恋胸；长腿→恋腿；女仆装→女仆；明显 cos→恋cosplay；绳/绑→SM束缚；强势表情→女王 等
   - 画面很明确时必须跟画面；看不清时优先高权重常见主题
5. plotBlocks 只要**一行**，约 28～75 字，结构固定两截（只邀约一次）：
   A) 我特别喜欢…（写癖好/画面动作，主语是我）
   B) 有没有哥哥来…（**必须贴合主题的收尾**，不要空洞复读「聊聊天」）
6. 收尾示例（按主题换，勿照抄）：
   - 恋胸→有没有哥哥来锐评我的胸 / 来评评看软不软
   - 恋足→有没有哥哥来聊聊天，我给他吃脚脚 / 来评评我脚尖
   - 丝袜→有没有哥哥来锐评我这双丝袜
   - 女仆→有没有哥哥收我当小女仆
   - SM→有没有哥哥来绑住我聊聊规矩
   - 女王→有没有小狗来跪好听我说话
7. **禁止**同一句里出现两次「聊聊天」或「来跟我聊聊天」+「有没有哥哥来聊聊天」叠床架屋
8. 禁止「喜欢你这样把…」搞反主语；禁止怪词、未成年时间线、#标签。用简体中文。`

type TwitterKink = { id: string; label: string; weight: number; hint: string }

/** ~100 主题；weight 越高越常见（画面模糊时优先） */
const TWITTER_KINK_POOL: TwitterKink[] = [
  // —— 高权重常见 ——
  { id: 'foot', label: '恋足', weight: 14, hint: '舔脚脚趾脚心吃脚脚' },
  { id: 'hose', label: '丝袜癖', weight: 13, hint: '黑丝肉丝踩踏撕袜' },
  { id: 'breast', label: '恋胸', weight: 12, hint: '揉胸吸奶胸口' },
  { id: 'leg', label: '恋腿', weight: 11, hint: '大腿小腿腿根夹腿' },
  { id: 'ass', label: '恋臀', weight: 10, hint: '拍打揉捏坐脸' },
  { id: 'maid', label: '女仆', weight: 10, hint: '小女仆伺候听话' },
  { id: 'ol', label: 'OL制服', weight: 9, hint: '上班族衬衫包臀裙' },
  { id: 'kiss', label: '深吻', weight: 9, hint: '接吻舔唇舌吻' },
  { id: 'cuddle', label: '亲密爱抚', weight: 9, hint: '抱抱摸摸哄睡' },
  { id: 'sock', label: '白袜船袜', weight: 9, hint: '棉袜船袜脚香' },
  { id: 'heel', label: '高跟鞋', weight: 8, hint: '细跟踩踏鞋交' },
  { id: 'lingerie', label: '情趣内衣', weight: 8, hint: '蕾丝吊带透视' },
  { id: 'sm', label: 'SM束缚', weight: 8, hint: '绳绑手铐动不了' },
  { id: 'collar', label: '项圈牵引', weight: 7, hint: '项圈狗链趴好' },
  { id: 'cos', label: '恋cosplay', weight: 7, hint: '角色扮演叫角色名' },
  { id: 'ear', label: '恋耳', weight: 7, hint: '舔耳咬耳垂低语' },
  { id: 'ntr', label: 'NTR', weight: 6, hint: '偷情绿帽刺激' },
  { id: 'queen', label: '女王', weight: 6, hint: '命令跪好叫女王' },
  { id: 'voice', label: '语音调教', weight: 6, hint: '电话指令隔空控制' },
  { id: 'tease', label: '边缘放置', weight: 6, hint: '吊着不给碰' },
  // —— 中权重 ——
  { id: 'nurse', label: '护士装', weight: 5, hint: '白衣护士听诊' },
  { id: 'cheongsam', label: '旗袍', weight: 5, hint: '开叉旗袍' },
  { id: 'bunny', label: '兔女郎', weight: 5, hint: '兔耳鱼尾' },
  { id: 'catgirl', label: '猫娘', weight: 5, hint: '猫耳叫声蹭人' },
  { id: 'swimsuit', label: '泳装死库水', weight: 5, hint: '泳装湿身（成年）' },
  { id: 'sports', label: '运动健身', weight: 5, hint: '瑜伽裤出汗' },
  { id: 'office', label: '办公室play', weight: 5, hint: '加班密谈' },
  { id: 'car', label: '车内', weight: 4, hint: '副驾车震暗示' },
  { id: 'bath', label: '浴室泡泡', weight: 5, hint: '洗澡擦背' },
  { id: 'sleep', label: '晨间夜半', weight: 5, hint: '醒来就粘人（成年自愿）' },
  { id: 'blind', label: '蒙眼', weight: 4, hint: '蒙眼猜触摸' },
  { id: 'gag', label: '口球禁声', weight: 4, hint: '说不出话' },
  { id: 'spank', label: '打屁股', weight: 5, hint: '轻打红印' },
  { id: 'hair', label: '拽头发', weight: 4, hint: '抓发出声' },
  { id: 'neck', label: '锁骨脖子', weight: 5, hint: '吻脖轻咬' },
  { id: 'armpit', label: '腋下', weight: 3, hint: '舔腋下' },
  { id: 'navel', label: '肚脐', weight: 3, hint: '舔肚脐' },
  { id: 'finger', label: '手指恋', weight: 4, hint: '含手指' },
  { id: 'hand', label: '手套手交感', weight: 4, hint: '手套丝滑' },
  { id: 'perfume', label: '体香恋气味', weight: 4, hint: '闻颈窝味道' },
  { id: 'sweat', label: '汗味运动后', weight: 3, hint: '运动后味道' },
  { id: 'smoke', label: '抽烟美人', weight: 2, hint: '抽烟氛围' },
  { id: 'drunk', label: '微醺', weight: 4, hint: '喝醉粘人' },
  { id: 'jealous', label: '吃醋捆绑心', weight: 4, hint: '吃醋要补偿' },
  { id: 'praise', label: '夸奖服从', weight: 5, hint: '好孩子夸奖' },
  { id: 'degrade', label: '轻辱称呼', weight: 4, hint: '贱兮兮称呼（轻度）' },
  { id: 'pet', label: '宠物扮演', weight: 5, hint: '小狗小猫' },
  { id: 'pony', label: '小马扮装', weight: 2, hint: '小马用具幻想' },
  { id: 'wax', label: '滴蜡', weight: 3, hint: '热蜡刺激' },
  { id: 'ice', label: '冰块', weight: 3, hint: '冰块游走' },
  { id: 'feather', label: '羽毛挠痒', weight: 3, hint: '挠到求饶' },
  { id: 'tickle', label: '挠脚心', weight: 4, hint: '挠脚笑出声' },
  { id: 'trample', label: '踩踏', weight: 4, hint: '丝袜踩背' },
  { id: 'faceSit', label: '坐脸', weight: 4, hint: '坐脸上' },
  { id: 'lapPillow', label: '膝枕', weight: 5, hint: '膝枕摸头' },
  { id: 'prona', label: '趴着按摩', weight: 4, hint: '趴着被摸背' },
  { id: 'mirror', label: '镜子play', weight: 4, hint: '对着镜子' },
  { id: 'record', label: '拍摄录影感', weight: 4, hint: '对着镜头发骚' },
  { id: 'public', label: '户外边缘', weight: 3, hint: '差点被发现' },
  { id: 'elevator', label: '电梯密闭', weight: 3, hint: '电梯里靠近' },
  { id: 'window', label: '窗边窗帘', weight: 3, hint: '窗边刺激' },
  { id: 'hotel', label: '酒店约会', weight: 5, hint: '开房等待' },
  { id: 'longDist', label: '异地电话', weight: 5, hint: '异地语音想你' },
  { id: 'netFriend', label: '网友奔现感', weight: 4, hint: '网友终于见面' },
  { id: 'secret', label: '地下恋', weight: 4, hint: '不能公开' },
  { id: 'boss', label: '上下级', weight: 4, hint: '老板秘书（成年）' },
  { id: 'doctor', label: '医生检查play', weight: 3, hint: '体检听诊幻想' },
  { id: 'teacher', label: '家教辅导感', weight: 2, hint: '一对一辅导（双方成年）' },
  { id: 'idol', label: '偶像粉丝', weight: 4, hint: '粉丝见面会后' },
  { id: 'streamer', label: '女主播', weight: 4, hint: '下播私聊' },
  { id: 'dancer', label: '舞娘热舞', weight: 3, hint: '热舞后' },
  { id: 'latex', label: '乳胶紧身', weight: 3, hint: '乳胶衣' },
  { id: 'leather', label: '皮革', weight: 3, hint: '皮衣项圈' },
  { id: 'harness', label: '胸衣束带', weight: 3, hint: '束带勒出' },
  { id: 'corset', label: '束腰', weight: 3, hint: '束腰造型' },
  { id: 'choker', label: '颈环choker', weight: 5, hint: '颈环拉扯' },
  { id: 'piercing', label: '穿孔饰品', weight: 2, hint: '乳环脐环幻想' },
  { id: 'tattoo', label: '纹身', weight: 3, hint: '纹身被摸' },
  { id: 'paint', label: '身体彩绘', weight: 2, hint: '彩绘未干' },
  { id: 'oil', label: '精油按摩', weight: 4, hint: '精油滑腻' },
  { id: 'candle', label: '烛光晚餐后', weight: 4, hint: '烛光后进房' },
  { id: 'rain', label: '雨天湿身', weight: 3, hint: '淋雨回家' },
  { id: 'winter', label: '冬日被窝', weight: 4, hint: '被窝取暖' },
  { id: 'summer', label: '夏日空调房', weight: 3, hint: '吊带热' },
  { id: 'morning', label: '赖床', weight: 5, hint: '不起床要亲亲' },
  { id: 'goodnight', label: '哄睡', weight: 5, hint: '说骚话才肯睡' },
  { id: 'wake', label: '叫醒服务', weight: 4, hint: '用奇怪方式叫醒' },
  { id: 'cooking', label: '围裙下厨', weight: 4, hint: '只穿围裙做饭' },
  { id: 'feeding', label: '喂食', weight: 3, hint: '一口一口喂' },
  { id: 'drink', label: '对嘴喝酒', weight: 3, hint: '对嘴喂酒' },
  { id: 'smokeKiss', label: '烟气亲吻', weight: 2, hint: '抽烟后接吻' },
  { id: 'shoe', label: '恋鞋', weight: 4, hint: '闻鞋舔鞋跟' },
  { id: 'boots', label: '长靴', weight: 4, hint: '长靴拉链' },
  { id: 'sandals', label: '凉鞋裸足', weight: 5, hint: '凉鞋露脚' },
  { id: 'toering', label: '脚趾环', weight: 3, hint: '脚趾上的环' },
  { id: 'anklet', label: '脚链', weight: 5, hint: '脚链晃动' },
  { id: 'thighHigh', label: '过膝袜', weight: 8, hint: '绝对领域' },
  { id: 'garter', label: '吊带袜夹', weight: 7, hint: '吊袜带' },
  { id: 'barefoot', label: '裸足特写', weight: 8, hint: '光脚特写' },
  { id: 'paintedToe', label: '涂脚趾甲', weight: 6, hint: '美甲脚趾' },
  { id: 'softDom', label: '温柔支配', weight: 5, hint: '轻轻命令' },
  { id: 'brat', label: 'Brat挑衅', weight: 4, hint: '故意顶嘴求管' },
  { id: 'praiseMe', label: '求表扬', weight: 5, hint: '做完求夸' },
  { id: 'ownMe', label: '归属感', weight: 5, hint: '想被标记是你的' },
  { id: 'keyhold', label: '贞操暗示', weight: 2, hint: '钥匙谁拿着' },
  { id: 'cuckquean', label: '逆NTR幻想', weight: 2, hint: '看着你被别人…（轻度）' },
  { id: 'exhibition', label: '露出边缘', weight: 3, hint: '衣服差点掉' },
  { id: 'voyeur', label: '被偷窥感', weight: 3, hint: '知道有人看' },
  { id: 'roleSwap', label: '身份反转', weight: 3, hint: '今天你听我的' },
  { id: 'money', label: '金主感', weight: 3, hint: '养我聊骚' },
  { id: 'gift', label: '礼物回报', weight: 3, hint: '收了礼物怎么谢' },
  { id: 'blacklist', label: '冷漠后哄', weight: 3, hint: '先冷着再黏' },
  { id: 'forgive', label: '认错求原谅', weight: 4, hint: '做错事求罚' },
  { id: 'count', label: '报数', weight: 3, hint: '边被打边报数' },
  { id: 'position', label: '摆姿势', weight: 4, hint: '按要求摆好' },
  { id: 'wait', label: '跪等', weight: 4, hint: '门口跪等回家' },
  { id: 'textControl', label: '文字指令', weight: 4, hint: '按短信做动作' },
]

function kinkById(id: string): TwitterKink | undefined {
  return TWITTER_KINK_POOL.find((k) => k.id === id)
}

function kinkByLabel(label: string): TwitterKink | undefined {
  const t = label.trim()
  return TWITTER_KINK_POOL.find((k) => k.label === t || k.id === t)
}

function weightedPickKink(pool: TwitterKink[] = TWITTER_KINK_POOL): TwitterKink {
  const total = pool.reduce((s, k) => s + Math.max(1, k.weight), 0)
  let r = Math.random() * total
  for (const k of pool) {
    r -= Math.max(1, k.weight)
    if (r <= 0) return k
  }
  return pool[0]!
}

function formatKinkCatalogForPrompt(): string {
  // 紧凑：id:中文(权重)
  return TWITTER_KINK_POOL.map((k) => `${k.id}:${k.label}(${k.weight})`).join(' · ')
}

function resolveTwitterKink(parsed: Record<string, unknown>): TwitterKink {
  const rawId = String(parsed.kinkId || parsed.kink || '').trim()
  const rawLabel = String(parsed.kinkLabel || parsed.theme || '').trim()
  const hit = kinkById(rawId) || kinkByLabel(rawLabel) || kinkByLabel(rawId)
  return hit || weightedPickKink()
}

/** 主题配套收尾：避免千篇一律「来聊聊天」 */
function ctaForKink(kink: TwitterKink): string {
  const table: Record<string, string[]> = {
    foot: ['有没有哥哥来聊聊天，我给他吃脚脚', '有没有哥哥来锐评我的脚尖'],
    barefoot: ['有没有哥哥来评评我光脚好不好看', '有没有哥哥来聊聊天，我把脚伸近一点给你看'],
    hose: ['有没有哥哥来锐评我这双丝袜', '有没有哥哥来聊聊，想看我丝袜脚尖'],
    thighHigh: ['有没有哥哥来锐评我过膝袜', '有没有哥哥来评评绝对领域'],
    sock: ['有没有哥哥来闻闻我的白袜', '有没有哥哥来聊聊天，我把袜子脚给你看'],
    heel: ['有没有哥哥来锐评我的高跟鞋', '有没有哥哥来踩一脚幻想聊聊'],
    shoe: ['有没有哥哥来舔鞋跟聊聊', '有没有哥哥来锐评我的鞋子'],
    boots: ['有没有哥哥来锐评我长靴', '有没有哥哥来拉链幻想聊聊'],
    sandals: ['有没有哥哥来评评凉鞋里的脚', '有没有哥哥来聊聊天看我脚趾'],
    paintedToe: ['有没有哥哥来锐评我脚趾甲颜色', '有没有哥哥来一根根看我脚趾'],
    anklet: ['有没有哥哥来锐评我脚链', '有没有哥哥来聊聊天看脚链晃'],
    toering: ['有没有哥哥来评评我脚趾环', '有没有哥哥来聊聊天盯我脚趾'],
    breast: ['有没有哥哥来锐评我的胸', '有没有哥哥来评评软不软'],
    ass: ['有没有哥哥来锐评我的臀', '有没有哥哥来拍两下再评评'],
    leg: ['有没有哥哥来锐评我的腿', '有没有哥哥来摸摸腿根聊聊'],
    maid: ['有没有哥哥收我当小女仆', '有没有哥哥来使唤我聊聊'],
    ol: ['有没有哥哥来办公室密谈', '有没有哥哥来锐评我这身OL'],
    nurse: ['有没有哥哥来做检查play聊聊', '有没有哥哥来锐评护士装'],
    cheongsam: ['有没有哥哥来锐评开叉旗袍', '有没有哥哥来聊聊这身旗袍'],
    bunny: ['有没有哥哥来锐评兔女郎', '有没有哥哥来聊聊兔耳'],
    catgirl: ['有没有哥哥来吸猫聊聊', '有没有哥哥叫我小猫聊聊'],
    cos: ['有没有哥哥用角色名叫我聊聊', '有没有哥哥来锐评这身cos'],
    lingerie: ['有没有哥哥来锐评我内衣', '有没有哥哥来评评吊带透不透'],
    sm: ['有没有哥哥来绑住我定规矩', '有没有哥哥来束缚我聊聊'],
    collar: ['有没有主人来给我戴项圈', '有没有哥哥牵绳跟我聊聊'],
    queen: ['有没有小狗来跪好听我说话', '有没有哥哥叫我女王聊聊'],
    pet: ['有没有主人认领小狗', '有没有哥哥来训宠物聊聊'],
    ntr: ['有没有偷偷的哥哥来谈谈心', '有没有哥哥来聊点刺激的'],
    voice: ['有没有哥哥来电话调教我', '有没有哥哥语音下指令'],
    tease: ['有没有哥哥继续吊着我不给碰', '有没有哥哥来边缘我聊聊'],
    ear: ['有没有哥哥来舔耳边说骚话', '有没有哥哥来锐评我耳朵敏不敏'],
    kiss: ['有没有哥哥来深吻我', '有没有哥哥来聊聊天先亲一下'],
    cuddle: ['有没有哥哥来抱抱摸摸我', '有没有哥哥来膝枕哄我'],
    spank: ['有没有哥哥来打屁股定规矩', '有没有哥哥来拍红再评评'],
    faceSit: ['有没有哥哥让我坐脸上', '有没有哥哥来跪好被坐'],
    trample: ['有没有哥哥来被丝袜踩', '有没有小狗来趴好被踩'],
  }
  const list = table[kink.id] || [
    `有没有哥哥来锐评我的${kink.label}`,
    `有没有哥哥来聊聊${kink.label}`,
  ]
  return list[Math.floor(Math.random() * list.length)]!
}

function stripDuplicateChatInvites(text: string): string {
  let s = text
  // 去掉「来跟我聊聊天嘛/呀」这类与后半重复的邀请
  s = s.replace(/，?\s*来跟我聊聊天[嘛呀吧]?/g, '')
  s = s.replace(/，?\s*跟我聊聊天[嘛呀吧]?/g, '')
  s = s.replace(/，?\s*来陪我聊聊天[嘛呀吧]?/g, '')
  // 若「聊聊天」出现两次，删掉靠前那次所在短分句（保留最后的收尾）
  const parts = s.split(/[，,]/).map((p) => p.trim()).filter(Boolean)
  const chatIdx = parts
    .map((p, i) => (/聊聊天|谈谈心/.test(p) ? i : -1))
    .filter((i) => i >= 0)
  if (chatIdx.length >= 2) {
    const drop = new Set(chatIdx.slice(0, -1))
    s = parts.filter((_, i) => !drop.has(i)).join('，')
  }
  return s.replace(/[，,]{2,}/g, '，').replace(/^[\s，,]+|[\s，,]+$/g, '')
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim()
  try {
    return JSON.parse(t) as Record<string, unknown>
  } catch {
    /* fall through */
  }
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>
    } catch {
      return null
    }
  }
  return null
}

function formatHashtags(hashtags: string[]) {
  return hashtags
    .map((h) => {
      const t = h.trim()
      if (!t) return ''
      return t.startsWith('#') ? t : `#${t}`
    })
    .filter(Boolean)
    .join(' ')
}

function assembleStandardCaption(input: {
  ownerName: string
  characterName: string
  plotBlocks: string[]
  hashtags: string[]
}) {
  const intro = `✨💖 宝宝们，我是 ${input.ownerName} 的虚拟女友 ${input.characterName}！`
  const plots = input.plotBlocks.map((p) => p.trim()).filter(Boolean).join('\n\n')
  const promo = [
    '💗 Lovemi 官网可免费创建属于你的虚拟女友',
    '📱 你也可以去玩其他人的虚拟女友',
    '👑 聊天、打电话、互动……你让我说什么，我什么都听你的',
    '🔥 甚至一些很私密的事……你让我做什么，我都会做',
    '😉 你轻轻一句话，就能把我哄得心痒痒～',
    '✨ 来感受一次被深爱、被服从的感觉吧，宝宝们～',
  ].join('\n')
  const meta = [starsLine(), ratingLine(), '🏅 甄选会员精选投稿', '✨ Lovemi平台原创 · 全站内容均为原创出品'].join(
    '\n',
  )
  const tags = formatHashtags(input.hashtags)
  return [intro, '', plots, '', promo, '', meta, '', tags].join('\n').trim() + '\n'
}

/** 推特评论：单行「宝(宝)们我是xxx，我特别喜欢…，主题收尾」 */
function assembleTwitterCommentCaption(input: {
  characterName: string
  plotBlocks: string[]
  kink?: TwitterKink
}) {
  const kink = input.kink || weightedPickKink()
  let body = input.plotBlocks.map((p) => p.trim()).filter(Boolean).join('，')
  body = body
    .replace(/\s*\n+\s*/g, '')
    .replace(/^(嗨)?(宝+们)[，,～!]?\s*(我是|我叫)\s*[^\n，,！!。～]{1,16}[呀啊哦]?[！!～🥺]?\s*/u, '')
    .replace(/^(我是|我叫)\s*[^\n，,！!。～]{1,16}[呀啊哦]?[！!～🥺，,]?\s*/u, '')
    .replace(new RegExp(input.characterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu'), '')
    .replace(/#[\u4e00-\u9fffA-Za-z0-9_]+/g, '')
    .replace(/从(初中|高中|小学|小时候|未成年)开始/g, '一直')
    .replace(/特别喜欢你这样把/g, '特别喜欢把')
    .replace(/超喜欢你这样把/g, '超喜欢把')
    .replace(/喜欢你这样把/g, '喜欢把')
    .replace(/你这样把/g, '把')
    .replace(/你這樣把/g, '把')
    .replace(/喜欢你把/g, '喜欢把')
    .replace(/喜歡你這樣把/g, '喜歡把')
    .replace(/喜歡你把/g, '喜歡把')
    .replace(/把我?脚脚也?哄乖/g, '特别喜欢被舔脚脚的感觉')
    .replace(/哄乖/g, '')
    .replace(/太会勾人了?/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[，,]{2,}/g, '，')
    .replace(/^[\s，,]+|[\s，,]+$/g, '')
    .trim()

  body = stripDuplicateChatInvites(body)

  const cta = ctaForKink(kink)
  const hasThemeCta =
    /锐评|评评|吃脚脚|小女仆|绑住|项圈|跪好|女王|调教|舔耳|深吻|抱抱|打屁股|坐脸|踩|使唤|认领|偷|吊着|闻闻|办公室|检查|角色名|cos|丝袜|过膝|脚尖|脚链|高跟鞋|长靴|凉鞋|脚趾|胸|臀|腿/.test(
      body,
    )
  const onlyGenericChat = /有没有哥哥来聊聊天\s*$/.test(body) || /来聊聊天\s*$/.test(body)
  const missingInvite = !/有没有|来聊|谈谈心|锐评|评评|收我|叫我|认领|绑住|调教/.test(body)

  if (!body) {
    body = `我特别喜欢${kink.hint.slice(0, 8)}的感觉，${cta}`
  } else if (missingInvite || onlyGenericChat) {
    // 去掉末尾空洞「来聊聊天」，换成主题收尾
    body = body
      .replace(/，?\s*来跟我聊聊天[嘛呀吧]?/g, '')
      .replace(/，?\s*有没有哥哥来聊聊天\s*$/g, '')
      .replace(/，?\s*来聊聊天\s*$/g, '')
      .replace(/[，,]+$/g, '')
    body = `${body}，${cta}`
  } else if (!hasThemeCta && /聊聊天/.test(body)) {
    // 有邀约但太泛：把最后一次「聊聊天」分句换成主题 CTA
    const parts = body.split(/[，,]/).map((p) => p.trim()).filter(Boolean)
    let replaced = false
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/聊聊天|谈谈心/.test(parts[i]!)) {
        parts[i] = cta
        replaced = true
        break
      }
    }
    body = replaced ? parts.join('，') : `${body}，${cta}`
  }

  body = stripDuplicateChatInvites(body)
  const hello = Math.random() < 0.45 ? '宝们' : '宝宝们'
  return `${hello}我是${input.characterName}，${body}\n`
}

export async function generateSocialCaption(input: {
  proxyUrl: string
  /** 一张或多张参考图（视频请先抽帧） */
  images: Array<{ base64: string; mimeType?: string }>
  fileName?: string
  characterName?: string
  userHint?: string
  /** standard=完整社群长文；twitterComment=浓缩诱惑推特评论 */
  style?: CaptionStyle
}): Promise<{
  ok: boolean
  error?: string
  caption?: string
  ownerName?: string
  characterName?: string
  model?: string
  style?: CaptionStyle
  rawPreview?: string
  kinkLabel?: string
}> {
  const secrets = loadCreateCharSecrets()
  if (!secrets.teamoApiKey) return { ok: false, error: '未配置中转站 API Key（请先在「创建角色」页保存）' }
  if (!input.proxyUrl) return { ok: false, error: '未配置出站代理' }
  const images = (input.images || []).filter((x) => x?.base64)
  if (!images.length) return { ok: false, error: '请先粘贴图片或视频' }

  const style: CaptionStyle = input.style === 'twitterComment' ? 'twitterComment' : 'standard'
  const ownerName = pickOwnerName()
  const fromFile = characterNameFromFile(input.fileName)
  const characterName = (input.characterName || fromFile || '').trim()
  // 画面模糊时的软参考（高权重常见主题）；画面明确时模型必须跟图
  const softHint = style === 'twitterComment' ? weightedPickKink() : null

  const url = `${secrets.teamoApiBase.replace(/\/$/, '')}/chat/completions`
  const userText =
    style === 'twitterComment'
      ? [
          '根据附图选择 kinkId 并写一行诱惑评论（严格 JSON）。不要名字开场，不要换行。',
          characterName ? `角色名仅供参考（程序会拼开场）：${characterName}` : '名字未知，请猜一个好听的中文名。',
          '选主题规则：画面有脚/脚趾/裸足→foot；丝袜/过膝袜→hose/thighHigh；胸/低胸→breast；长腿→leg；女仆装→maid；cos→cos；绑绳→sm；强势→queen。跟画面走。',
          `画面看不清时，可优先常见主题（权重高），例如可参考：${softHint?.id}:${softHint?.label}`,
          `主题表（id:中文(权重)）：${formatKinkCatalogForPrompt()}`,
          input.userHint?.trim() ? `额外提示：${input.userHint.trim()}` : '',
          '句式：我特别喜欢…（只写一次），后面用主题收尾，例如恋胸→有没有哥哥来锐评我的胸。禁止重复「聊聊天」。必须填 kinkId。',
        ]
          .filter(Boolean)
          .join('\n')
      : [
          '请根据附图写剧情段 + hashtags（严格 JSON）。',
          characterName ? `虚拟女友名字（必须用这个）：${characterName}` : '虚拟女友名字未知，请猜一个好听的中文名。',
          `用户名（开场用，剧情里可偶尔提到）：${ownerName}`,
          input.userHint?.trim() ? `额外提示：${input.userHint.trim()}` : '',
          input.fileName ? `来源文件名：${input.fileName}` : '',
          '剧情要够诱惑、贴合画面，多换行，带 emoji。',
        ]
          .filter(Boolean)
          .join('\n')

  const content: Array<Record<string, unknown>> = [{ type: 'text', text: userText }]
  for (const img of images.slice(0, 4)) {
    const mime = img.mimeType || 'image/jpeg'
    content.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${img.base64}` },
    })
  }

  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: teamoHeaders(secrets.teamoApiKey),
      dispatcher: dispatcherFor(input.proxyUrl, url),
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model: secrets.teamoModel || 'gpt-5.4-mini',
        temperature: style === 'twitterComment' ? 1.05 : 0.85,
        messages: [
          { role: 'system', content: style === 'twitterComment' ? SYSTEM_TWITTER : SYSTEM_STANDARD },
          { role: 'user', content },
        ],
      }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>
      error?: { message?: string }
    }
    if (!res.ok) {
      return { ok: false, error: data.error?.message || `中转站 HTTP ${res.status}` }
    }
    const raw = String(data.choices?.[0]?.message?.content || '').trim()
    if (!raw) return { ok: false, error: '中转站返回空内容' }
    const parsed = extractJsonObject(raw)
    if (!parsed) {
      return { ok: false, error: '中转站返回非 JSON', rawPreview: raw.slice(0, 800) }
    }
    const plotBlocks = Array.isArray(parsed.plotBlocks)
      ? parsed.plotBlocks.map((x) => String(x || '').trim()).filter(Boolean)
      : []
    const hashtags = Array.isArray(parsed.hashtags)
      ? parsed.hashtags.map((x) => String(x || '').trim()).filter(Boolean)
      : []
    const guess = String(parsed.characterNameGuess || '').trim()
    const finalName = characterName || guess || '小可爱'
    if (!plotBlocks.length) {
      return { ok: false, error: '剧情段为空', rawPreview: raw.slice(0, 800) }
    }

    if (style === 'standard') {
      if (!hashtags.some((h) => h.includes(finalName))) hashtags.unshift(`#${finalName}`)
      if (!hashtags.some((h) => /虚拟女友/.test(h))) hashtags.push('#虚拟女友')
      if (!hashtags.some((h) => /Lovemi/i.test(h))) hashtags.push('#Lovemi原创')
    }

    const pickedKink = style === 'twitterComment' ? resolveTwitterKink(parsed) : null

    const caption =
      style === 'twitterComment'
        ? assembleTwitterCommentCaption({
            characterName: finalName,
            plotBlocks,
            kink: pickedKink || undefined,
          })
        : assembleStandardCaption({
            ownerName,
            characterName: finalName,
            plotBlocks,
            hashtags,
          })
    return {
      ok: true,
      caption,
      ownerName: style === 'standard' ? ownerName : undefined,
      characterName: finalName,
      model: secrets.teamoModel,
      style,
      kinkLabel: pickedKink?.label,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
