import { createHash } from 'node:crypto'
import { LOCALES, type LocaleCode } from './locales'

type Frag = { hooks: string[]; mids: string[]; tails: string[] }

/** 夸奖 + 欲望感 + 网络口语，短句；组合去重凑满 300（禁犯罪字样） */
const COMMENT_FRAG: Record<LocaleCode, Frag> = {
  zh: {
    hooks: [
      '卧槽', '我靠', '天啊', '救命', '停一下', '不行了', '姐妹们', '家人们', '真的假的', '啊这',
      '嘶', '哈…', '额啊', '操', '妈呀', '绝了', '疯了', '完了', '心跳加速', '屏住呼吸',
    ],
    mids: [
      '这也太性感了', '腰线绝了', '眼神太勾人', '这氛围感直接拿下', '衣服都多余', '好欲好欲',
      '这张图犯规了', '气质太野了', '笑一下我就没了', '腿好长好直', '唇色好撩', '这个角度太坏',
      '氛围拉满', '色气溢出屏幕', '好想靠近一点', '呼吸都乱了', '今天克制不住', '这反差萌杀我',
      '皮肤也太细了', '这身材比例', '眼神往下瞟的瞬间', '简直犯规', '太会拍了', '直接硬控我',
    ],
    tails: [
      '真忍不住了…!', '我先去冷静一下', '收藏了别删', '可以再来一张吗', '晚上别这样发',
      '我酸了', '谁懂啊', '直接沦陷', '嘴角压不住', '心跳漏拍了', '我宣布今天过了',
      '好想咬一口', '再看一口就睡', '别诱惑我了', '已截图珍藏了', '我是认真的',
    ],
  },
  en: {
    hooks: [
      'damn', 'holy', 'wait', 'bro', 'help', 'okay', 'nah', 'yo', 'bruh', 'omfg',
      'shit', 'wow', 'girl', 'babe', 'hold up', 'no way', 'i—', 'ahh', 'fuck', 'please',
    ],
    mids: [
      'this is unfairly hot', 'that waist tho', 'eyes got me weak', 'outfit is unreal',
      'so soft so filthy', 'aura is insane', 'this angle is unfair', 'lips look dangerous',
      'legs for days', 'too sexy for public', 'mood is filthy', 'i’m not okay',
      'skin looks unreal', 'that smirk killed me', 'tension is crazy', 'need a cold shower',
      'this pic owns me', 'too tempting', 'body proportions insane', 'can’t look away',
    ],
    tails: [
      'i’m losing it…!', 'saving this rn', 'send more pls', 'gonna dream about this',
      'stop teasing', 'i’m cooked', 'who allowed this', 'heart rate up', 'need a minute',
      'biting my lip', 'down bad fr', 'can’t breathe', 'obsessed already', 'help me',
    ],
  },
  ja: {
    hooks: [
      'やば', '待って', 'うそ', 'は？', 'きつい', 'だめ', 'えっ', 'うわ', '神', '無理',
      'はぁ…', 'くそ', 'マジ', 'あぶね', '尊い', '沼', '死', 'えぐ', 'やばみ', 'お願い',
    ],
    mids: [
      '色気強すぎ', '腰のライン反則級', '目線でやられる', 'この雰囲気ずるい', '服いらない説',
      'エロかわ限界突破', '角度が意地悪', '唇が危険', '脚ながっ', '吐息聞こえそう',
      '肌きれいすぎ', 'その微笑み反則', '空気が熱い', '理智が溶ける', 'ドキドキが止まない',
      '写真上手すぎ', '誘惑しかない', 'スタイルえぐい', '視線そらせない', '夜に見たら終わる',
    ],
    tails: [
      '我慢できない…!', '保存した', 'もっと見せて', '冷静になりたい', 'いじわるしないで',
      '沼った', '誰か止めて', '心拍上がった', 'ひと息いる', 'かみたくなる', '本気で好き',
      'もう一回見る', '眠れない', 'やられた', '沼確定',
    ],
  },
  ko: {
    hooks: [
      '헐', '대박', '잠깐', '진짜', '미쳤다', '안 돼', '와', '아', '씨', '개',
      '하…', '제발', '뭐야', '미쳤음', '존예', '심장', '숨', '야', '오마이갓', '그만',
    ],
    mids: [
      '너무 야해', '허리라인 실화냐', '눈빛에 녹음', '분위기 미침', '옷이 거추장',
      '섹시 과함', '각도 치사하다', '입술 위험', '다리 미쳤다', '숨 막힘',
      '피부 반칙남', '그 미소 반칙', '공기가 뜨거움', '이성 증발', '심장 뛰어',
      '사진 너무 잘 나옴', '유혹만 남음', '비율 미쳤다', '눈 못 뗌', '밤에 보면 큰일',
    ],
    tails: [
      '참을 수가 없네…!', '저장함', '더 올려줘', '진정 좀', '놀리지 마',
      '빠졌어', '누가 말려줘', '심박 상승', '숨 고를게', '깨물고 싶다', '진심임',
      '또 봄', '잠 못 잠', '당했다', '완전 취함',
    ],
  },
  vi: {
    hooks: [
      'đm', 'trời', 'chờ đã', 'thật á', 'điên', 'thôi', 'wow', 'á', ' helpp', 'omgg',
      'haiz', 'please', 'gì vậy', 'cháy', 'đỉnh', 'tim', 'thở', 'ê', 'ủa', 'stop',
    ],
    mids: [
      'sexy quá trời', 'eo này quá đỉnh', 'mắt nhìn là chết', 'không khí nóng quá',
      'đồ như thừa', 'gợi cảm quá mức', 'góc chụp ác', 'môi nguy hiểm', 'chân dài ảo',
      'nghẹt thở', 'da đẹp muốn chạm', 'nụ cười phản đòn', 'nóng người', 'lý trí tan',
      'tim đập loạn', 'ảnh quá chất', 'chỉ còn dụ dỗ', 'tỉ lệ body đỉnh', 'không rời mắt',
    ],
    tails: [
      'không nhịn nổi…!', 'đã lưu', 'cho xem thêm', 'để tớ bình tĩnh', 'đừng trêu',
      'sa lưới rồi', 'ai cứu với', 'tim tăng tốc', 'thở cái đã', 'muốn cắn một cái',
      'nghiêm túc đó', 'xem lại lần nữa', 'mất ngủ', 'thua rồi', 'mê cứng',
    ],
  },
  th: {
    hooks: [
      'เห้ย', 'รอดิ', 'จริงดิ', 'บ้า', 'พอ', 'ว้าว', 'อ่า', 'ช่วยด้วย', 'โอ้ย', 'แม่',
      'ห๊ะ', 'please', 'อะไรนะ', 'ไฟลุก', 'สุด', 'หัวใจ', 'หายใจ', 'เออ', 'หยุด', 'damn',
    ],
    mids: [
      'เซ็กซี่เกิน', 'เอวนี้ผิดกติกา', 'สายตาทำให้ใจอ่อน', 'บรรยากาศร้อนมาก', 'เสื้อเหมือนเกิน',
      'ยั่วเกินปุยมุ้ย', 'มุมถ่ายใจร้าย', 'ปากอันตราย', 'ขายาวมาก', 'หายใจไม่ออก',
      'ผิวสวยอยากแตะ', 'รอยยิ้มผิดกติกา', 'ตัวร้อน', 'สติละลาย', 'ใจเต้นรัว',
      'รูปสวยชิบหาย', 'เหลือแต่การยั่ว', 'สัดส่วนเทพ', 'ตาไม่กะพริบ', 'ดึกๆอย่าโพสต์',
    ],
    tails: [
      'ทนไม่ไหว…!', 'เซฟแล้ว', 'ขออีกหน่อย', 'ขอใจเย็นก่อน', 'อย่ายั่ว',
      'ตกแล้ว', 'ใครช่วยที', 'ชีพจรพุ่ง', 'หายใจก่อน', 'อยากกัดนิด', 'จริงจังนะ',
      'ดูอีกรอบ', 'นอนไม่หลับ', 'แพ้แล้ว', 'ฟินมาก',
    ],
  },
  es: {
    hooks: [
      'joder', 'espera', 'en serio', 'loco', 'para', 'wow', 'ay', 'help', 'dios', 'uff',
      'hostia', 'please', 'qué', 'fuego', 'brutal', 'corazón', 'respira', 'eh', 'stop', 'damn',
    ],
    mids: [
      'esto está demasiado sexy', 'esa cintura es injusta', 'esa mirada me derrite',
      'el vibe está caliente', 'la ropa sobra', 'demasiado provocador', 'ángulo traicionero',
      'labios peligrosos', 'piernas kilométricas', 'sin aire', 'piel de tocártela',
      'esa sonrisa es trampa', 'me sube la temperatura', 'se me va la cabeza',
      'el corazón dispara', 'foto letal', 'pura tentación', 'proporciones locas',
      'no puedo mirar a otro lado',
    ],
    tails: [
      'no me aguanto…!', 'guardado ya', 'manda más', 'necesito calmarme', 'deja de tentar',
      'caí redondo', 'que alguien me pare', 'pulso alto', 'un segundo', 'quiero morder',
      'voy en serio', 'otra vez mirando', 'no duermo', 'perdí', 'obsesionado',
    ],
  },
  ru: {
    hooks: [
      'блять', 'стой', 'серьёзно', 'пиздец', 'хватит', 'вау', 'ах', 'help', 'боже', 'ух',
      'ё-моё', 'please', 'что', 'огонь', 'жестко', 'сердце', 'дышу', 'эй', 'стоп', 'damn',
    ],
    mids: [
      'слишком сексуально', 'талия — чит-код', 'взгляд сносит крышу', 'атмосфера горячая',
      'одежда лишняя', 'слишком провокационно', 'ракурс подлый', 'губы опасные',
      'ноги бесконечные', 'нечем дышать', 'кожа хочется трогать', 'улыбка — ловушка',
      'температура растёт', 'мозг плавится', 'сердце колотится', 'фото как удар',
      'сплошное искушение', 'пропорции огонь', 'глаза не отвести',
    ],
    tails: [
      'не могу сдержаться…!', 'сохранил', 'дай ещё', 'остыну секунду', 'не дразни',
      'я пропал', 'остановите меня', 'пульс вверх', 'вдох-выдох', 'хочу укусить',
      'я серьёзно', 'смотрю снова', 'не усну', 'сдался', 'залип',
    ],
  },
  fil: {
    hooks: [
      'grabe', 'teka', 'seriously', 'ano ba', 'tama na', 'wow', 'aray', 'help', 'jusko', 'shit',
      'huh', 'please', 'ha?', 'angas', 'galing', 'puso', 'hinga', 'uy', 'stop', 'damn',
    ],
    mids: [
      'ang sexy nito', 'sobrang linya ng bewang', 'matang nakakahilo', 'mainit ang vibe',
      'parang sobra ang damit', 'sobra makatawag-pansin', 'angle na mandaraya',
      'delikadong labi', 'ang haba ng binti', 'hirap huminga', 'skin na gusto hawakan',
      'ngiting trap', 'umiinit ako', 'nawawala ang isip', 'tumitibok agad',
      'ang gandang pic', 'purotemptation', 'proportional goals', 'di makatingin sa iba',
    ],
    tails: [
      'di ko mapigilan…!', 'save na', 'more please', 'pahinga muna', 'wag magtanim ng gana',
      'bagsak na ako', 'pigilan nyo ako', 'taas ang pulse', 'hinga sandali', 'gusto ko kagatin',
      'seryoso to', 'ulit ulit ko tinitignan', 'di makatulog', 'talo na', 'obsessed',
    ],
  },
  fr: {
    hooks: [
      'putain', 'attends', 'sérieux', 'ouf', 'stop', 'wow', 'ah', 'help', 'bordel', 'uff',
      'merde', 'please', 'quoi', 'chaud', 'dingue', 'cœur', 'respire', 'eh', 'non', 'damn',
    ],
    mids: [
      'c’est trop sexy', 'cette taille est injuste', 'ce regard me fond', 'l’ambiance est brûlante',
      'les fringues sont en trop', 'trop provocant', 'angle vicieux', 'lèvres dangereuses',
      'jambes interminables', 'plus d’air', 'peau trop touchable', 'sourire piège',
      'ça chauffe', 'cerveau en fusion', 'cœur qui s’emballe', 'photo trop forte',
      'que de la tentation', 'proportions ouf', 'impossible de détourner les yeux',
    ],
    tails: [
      'je tiens plus…!', 'sauvegardé', 'encore s’il te plaît', 'besoin de calme', 'arrête de tenter',
      'je suis cuit', 'quelqu’un m’arrête', 'pouls en hausse', 'une seconde', 'envie de mordre',
      'je suis sérieux', 'je re-regarde', 'pas de sommeil', 'j’ai perdu', 'obsédé',
    ],
  },
}

type NameFrag = { a: string[]; b: string[]; c: string[] }

/** 偏男性网名；后缀禁止数字（一眼机器人） */
const NAME_FRAG: Record<LocaleCode, NameFrag> = {
  zh: {
    a: [
      '北巷', '孤狼', '夜行', '硬核', '灰烬', '野火', '铁皮', '暗潮', '冷刃', '荒原',
      '独行', '焦土', '沉香', '雷暴', '旧巷', '钝刀', '黑砂', '碎岩', '残响', '深渊',
    ],
    b: [
      '路过', '在逃', '未熄', '执刀', '望海', '听雨', '藏锋', '醒酒', '赶路', '守夜',
      '沉默', '破晓', '踏雪', '饮风', '停火', '回望', '沉底', '抬头', '咬牙', '收刀',
    ],
    c: ['叔', '哥', '侠', '客', '郎', '汉', '君', '枭', '狼', '虎', 'x', 'z', 'xo', 'vv', '君', '客', '侠', '郎', '汉', '哥'],
  },
  en: {
    a: [
      'cold', 'steel', 'ash', 'night', 'iron', 'raw', 'dark', 'wolf', 'blaze', 'grim',
      'rough', 'stone', 'smoke', 'blade', 'storm', 'hollow', 'north', 'dust', 'ember', 'black',
    ],
    b: [
      'wolf', 'drift', 'hawk', 'forge', 'knight', 'rider', 'shade', 'pulse', 'rook', 'fang',
      'brook', 'vale', 'crest', 'thorn', 'marsh', 'cliff', 'wraith', 'ranger', 'sentry', 'mason',
    ],
    c: ['x', 'z', 'xo', 'vv', 'rx', 'kx', 'vx', 'nx', 'lx', 'mx', 'ox', 'px', 'qx', 'sx', 'tx', 'ux', 'wx', 'yx', 'zx', 'ax'],
  },
  ja: {
    a: [
      '孤狼', '夜行', '鉄', '灰', '嵐', '影', '剣', '荒野', '残火', '黒砂',
      '深淵', '冷刃', '雷', '岩', '霧男', '潮', '焔', '鋼', '砂', '闇',
    ],
    b: [
      '漢', '男', '騎', '守', '駆', '眠らず', '渡り', '斬', '歩', '醒',
      '黙', '暁', '雪踏', '風飲', '戻', '沈', '見上', '噛', '納刀', '独',
    ],
    c: ['くん', '氏', '兄', '漢', '狼', '虎', 'x', 'z', 'xo', 'vv', '郎', '男', '客', '侠', '君', '狼', '虎', '兄', '氏', '漢'],
  },
  ko: {
    a: [
      '고독한', '야행', '강철', '재', '폭풍', '그림자', '칼날', '황야', '잔화', '흑사',
      '심연', '냉인', '번개', '바위', '안개', '파도', '불꽃', '쇠', '모래', '어둠',
    ],
    b: [
      '늑대', '사내', '기사', '수호', '질주', '불면', '유랑', '참', '도보', '각성',
      '침묵', '여명', '설원', '음풍', '귀환', '침잠', '올려봄', '악물', '수납', '독행',
    ],
    c: ['형', '씨', '군', '늑', '호', 'x', 'z', 'xo', 'vv', '맨', '형', '씨', '군', '형님', '형', '씨', '군', '맨', '형', '씨'],
  },
  vi: {
    a: [
      'soi', 'dem', 'thep', 'tro', 'bao', 'bong', 'luoi', 'hoang', 'troitan', 'catsam',
      'vuc', 'luoiLanh', 'sam', 'da', 'suong', 'song', 'lua', 'sat', 'cat', 'toi',
    ],
    b: [
      'don', 'nam', 'ky', 'giu', 'chay', 'thuc', 'langthang', 'chem', 'buoc', 'tinh',
      'lang', 'binhminh', 'tuyet', 'gio', 've', 'chim', 'nguoc', 'can', 'kip', 'motminh',
    ],
    c: ['anh', 'bro', 'x', 'z', 'xo', 'vv', 'rx', 'kx', 'nam', 'a', 'anh', 'bro', 'x', 'z', 'xo', 'vv', 'rx', 'kx', 'nam', 'a'],
  },
  th: {
    a: [
      'mailap', 'yen', 'lek', 'tephun', 'phayu', 'ngao', 'mit', 'thung', 'faimai', 'saisam',
      'wong', 'mityen', 'faa', 'hin', 'mok', 'kluen', 'fai', 'lekmai', 'sai', 'meut',
    ],
    b: [
      'phuchai', 'deo', 'nakrop', 'fak', 'wing', 'maidai', 'jolai', 'tat', 'doen', 'tuen',
      'ngiap', 'arun', 'him', 'lom', 'klap', 'jom', 'mongbon', 'kat', 'kep', 'diao',
    ],
    c: ['bro', 'x', 'z', 'xo', 'vv', 'rx', 'phi', 'nai', 'bro', 'x', 'z', 'xo', 'vv', 'rx', 'phi', 'nai', 'bro', 'x', 'z', 'xo'],
  },
  es: {
    a: [
      'lobo', 'noche', 'acero', 'ceniza', 'tormenta', 'sombra', 'filo', 'yermo', 'brasas', 'arena',
      'abismo', 'filofrio', 'rayo', 'roca', 'niebla', 'marea', 'llama', 'hierro', 'polvo', 'oscuro',
    ],
    b: [
      'solo', 'hombre', 'jinete', 'guarda', 'corre', 'insomne', 'errante', 'tajo', 'paso', 'despierta',
      'calla', 'alba', 'nieve', 'viento', 'vuelve', 'hunde', 'mira', 'muerde', 'guardaarma', 'anda',
    ],
    c: ['x', 'z', 'xo', 'vv', 'rx', 'kx', 'vx', 'nx', 'bro', 'sr', 'x', 'z', 'xo', 'vv', 'rx', 'kx', 'vx', 'nx', 'bro', 'sr'],
  },
  ru: {
    a: [
      'volk', 'noch', 'stal', 'pepel', 'burya', 'ten', 'klinok', 'pustosh', 'zola', 'pesok',
      'bezdna', 'holod', 'molniya', 'kamen', 'tuman', 'priliv', 'plamya', 'zhelezo', 'pyl', 'mrak',
    ],
    b: [
      'odin', 'muzhik', 'vsadnik', 'strazh', 'beg', 'besson', 'brodyaga', 'rub', 'shag', 'probuzh',
      'molch', 'rassvet', 'sneg', 'veter', 'vozvrat', 'tonu', 'smotri', 'kusai', 'ubeir', 'idi',
    ],
    c: ['x', 'z', 'xo', 'vv', 'rx', 'kx', 'vx', 'nx', 'bro', 'muj', 'x', 'z', 'xo', 'vv', 'rx', 'kx', 'vx', 'nx', 'bro', 'muj'],
  },
  fil: {
    a: [
      'lobo', 'gabi', 'bakal', 'abo', 'bagyo', 'anino', 'talim', 'disyerto', 'baga', 'buhangin',
      'bangin', 'malamig', 'kidlat', 'bato', 'ulap', 'alon', 'apoy', 'bakal', 'alikabok', 'dilim',
    ],
    b: [
      'magisa', 'lalaki', 'mangangabayo', 'bantay', 'takbo', 'puyat', 'lagalag', 'hiwa', 'hakbang', 'gising',
      'tahimik', 'bukangliwayway', 'niyebe', 'hangin', 'balik', 'lubog', 'tingala', 'kagat', 'itagong', 'lakad',
    ],
    c: ['x', 'z', 'xo', 'vv', 'rx', 'kx', 'bro', 'kuya', 'x', 'z', 'xo', 'vv', 'rx', 'kx', 'bro', 'kuya', 'x', 'z', 'xo', 'vv'],
  },
  fr: {
    a: [
      'loup', 'nuit', 'acier', 'cendre', 'orage', 'ombre', 'lame', 'lande', 'braise', 'sable',
      'abime', 'froid', 'foudre', 'roche', 'brume', 'maree', 'flamme', 'fer', 'poussiere', 'noir',
    ],
    b: [
      'seul', 'gars', 'cavalier', 'garde', 'court', 'insomn', 'errant', 'taille', 'pas', 'eveille',
      'silence', 'aube', 'neige', 'vent', 'retour', 'plonge', 'regarde', 'mord', 'range', 'marche',
    ],
    c: ['x', 'z', 'xo', 'vv', 'rx', 'kx', 'vx', 'nx', 'bro', 'mec', 'x', 'z', 'xo', 'vv', 'rx', 'kx', 'vx', 'nx', 'bro', 'mec'],
  },
}

function hasDigit(s: string) {
  return /\d/.test(s)
}

function uniqPushComment(set: Set<string>, arr: string[], v: string, max: number) {
  // 禁止数字：旧种子会拼 `#52`，站内评论绝不能带序号
  const t = v.replace(/\s+/g, ' ').trim()
  if (!t || /\d/.test(t) || set.has(t) || arr.length >= max) return
  set.add(t)
  arr.push(t)
}

function uniqPushName(set: Set<string>, arr: string[], v: string, max: number) {
  const t = v.replace(/\s+/g, ' ').trim()
  if (!t || set.has(t) || arr.length >= max) return
  if (hasDigit(t)) return
  set.add(t)
  arr.push(t)
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

export function generateComments(locale: LocaleCode, count = 300): string[] {
  const frag = COMMENT_FRAG[locale]
  const out: string[] = []
  const seen = new Set<string>()
  const spices = ['', '~', '…', '!!', '～', '—', '·', '♡', 'lol', 'imo', 'rn', 'pls', 'bro']
  const joiners = [' ', ' · ', ' — ', '… ', '！', '，', ' / ', ' ·· ', '~~']
  let i = 0
  while (out.length < count && i < count * 200) {
    i++
    const h = frag.hooks[i % frag.hooks.length]
    const m = frag.mids[(i * 3) % frag.mids.length]
    const t = frag.tails[(i * 7) % frag.tails.length]
    const m2 = frag.mids[(i * 11) % frag.mids.length]
    const t2 = frag.tails[(i * 13) % frag.tails.length]
    const sp = spices[i % spices.length]
    const j = joiners[(i * 5) % joiners.length]
    const patterns = [
      `${h}！${m}，${t}${sp}`,
      `${h}… ${m}. ${t}${sp}`,
      `${m}（${h}）${t}${sp}`,
      `${h}${j}${m}${j}${t}${sp}`,
      `${m} — ${t}${sp}`,
      `${h}${j}${m}，${m2}${sp}`,
      `${t}${j}${m}${sp}`,
      `${h}~ ${m}${sp}`,
      `${m2}${j}${t2}${j}${h}${sp}`,
      `${h}${j}${t}${j}${m}${sp}`,
      `${m} ${t2}${sp}`,
      `${h} ${m2} ${t}${sp}`,
    ]
    uniqPushComment(seen, out, patterns[i % patterns.length], count)
  }
  let pad = 0
  while (out.length < count && pad < count * 120) {
    pad++
    const spice = frag.hooks[(pad * 17) % frag.hooks.length]
    const sp = spices[(pad * 3) % spices.length]
    uniqPushComment(
      seen,
      out,
      `${frag.mids[pad % frag.mids.length]}${joiners[pad % joiners.length]}${frag.tails[(pad * 5) % frag.tails.length]}${joiners[(pad * 2) % joiners.length]}${spice}${sp}`,
      count,
    )
  }
  return out.slice(0, count)
}

export function generateDisplayNames(locale: LocaleCode, count = 300): string[] {
  const frag = NAME_FRAG[locale]
  const out: string[] = []
  const seen = new Set<string>()
  let i = 0
  while (out.length < count && i < count * 200) {
    i++
    const a = frag.a[i % frag.a.length]
    const b = frag.b[(i * 5) % frag.b.length]
    const c = frag.c[(i * 11) % frag.c.length]
    const d = frag.c[(i * 13 + 3) % frag.c.length]
    const e = frag.a[(i * 17) % frag.a.length]
    const patterns = [
      `${a}${b}${c}`,
      `${a}_${b}`,
      `${a}${b}_${c}`,
      `${a}_${b}${c}`,
      `${a}${c}_${b}`,
      `${b}${a}${d}`,
      `${a}${b}${d}`,
      `${e}_${b}${c}`,
      `${a}_${b}_${c}`,
      `${a}${b}${c}${d}`,
    ]
    let name = patterns[i % patterns.length]
    if (name.length > 22) name = name.slice(0, 22)
    if (name.length < 3) continue
    uniqPushName(seen, out, name, count)
  }
  let pad = 0
  while (out.length < count && pad < count * 200) {
    pad++
    const a = frag.a[pad % frag.a.length]
    const b = frag.b[(pad * 7) % frag.b.length]
    const c = frag.c[(pad * 11) % frag.c.length]
    const s1 = LETTERS[pad % LETTERS.length]
    const s2 = LETTERS[(pad * 3) % LETTERS.length]
    const s3 = LETTERS[(pad * 7) % LETTERS.length]
    uniqPushName(seen, out, `${a}_${b}${c}${s1}${s2}${s3}`.slice(0, 22), count)
  }
  return out.slice(0, count)
}

export function normalizeName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, '')
}

export function commentId(locale: LocaleCode, body: string, index: number) {
  return `cmt_${locale}_${createHash('sha1').update(`${locale}|${body}|${index}`).digest('hex').slice(0, 16)}`
}

export function nameId(locale: LocaleCode, name: string) {
  return `name_${locale}_${createHash('sha1').update(`${locale}|${normalizeName(name)}`).digest('hex').slice(0, 16)}`
}


export function buildAllCopySeed(opts?: { namesOnly?: boolean }) {
  const comments: Array<{ id: string; locale: LocaleCode; body: string }> = []
  const names: Array<{ id: string; locale: LocaleCode; name: string; normalized: string }> = []
  const globalName = new Set<string>()
  for (const locale of LOCALES) {
    if (!opts?.namesOnly) {
      const bodies = generateComments(locale, 300)
      bodies.forEach((body, idx) => comments.push({ id: commentId(locale, body, idx), locale, body }))
    }
    const nm = generateDisplayNames(locale, 300)
    for (const name of nm) {
      let n = name
      let norm = normalizeName(n)
      let guard = 0
      while ((globalName.has(norm) || hasDigit(n)) && guard < 80) {
        guard++
        const suffix = LETTERS[guard % LETTERS.length] + LETTERS[(guard * 3) % LETTERS.length]
        n = `${name}${suffix}`.slice(0, 22)
        norm = normalizeName(n)
      }
      if (globalName.has(norm) || hasDigit(n)) continue
      globalName.add(norm)
      names.push({ id: nameId(locale, n), locale, name: n, normalized: norm })
    }
    let extra = 0
    while (names.filter((x) => x.locale === locale).length < 300 && extra < 1200) {
      extra++
      const a = NAME_FRAG[locale].a[extra % 20]
      const b = NAME_FRAG[locale].b[(extra * 3) % 20]
      const c = NAME_FRAG[locale].c[(extra * 5) % 20]
      const n = `${a}_${b}${c}`.slice(0, 22)
      const norm = normalizeName(n)
      if (globalName.has(norm) || hasDigit(n)) continue
      globalName.add(norm)
      names.push({ id: nameId(locale, n), locale, name: n, normalized: norm })
    }
  }
  return { comments, names }
}
