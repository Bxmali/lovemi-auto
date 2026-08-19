import { createHash } from 'node:crypto'
import { LOCALES, type LocaleCode } from './locales'

type Frag = { hooks: string[]; mids: string[]; tails: string[] }

/** 短视频/图文 Explore 评论：更像刷 feed 的真实语气（禁数字、禁犯罪字样） */
const EXPLORE_COMMENT_FRAG: Record<LocaleCode, Frag> = {
  zh: {
    hooks: [
      '这条', '刷到', '等等', '卧槽', '天啊', '家人们', '姐妹', '真的', '停一下', '啊这',
      '哈', '绝了', '完了', '嘶', '救命', '好家伙', '不是', '等等啊', '我去', '靠',
    ],
    mids: [
      '也太上头了', '剪辑节奏绝了', 'BGM 配得真好', '看到停不下来', '这转场太丝滑',
      '画面质感好强', '结尾杀我', '情绪一下就起来了', '镜头好会拍', '氛围感拉满',
      '这卡点太准了', '刷第三遍了还想看', '像在现场一样', '光影好舒服', '节奏拿捏死了',
      '这波内容太会了', '短短几秒信息量爆', '海报感也好强', '声音设计绝了', '越往后越好看',
    ],
    tails: [
      '收藏了', '再来一条呗', '算法真懂我', '今晚循环', '手滑又看一遍',
      '发给朋友了', '想二创', '已关注', '等更新', '这才叫短视频',
      '我宣布今天过了', '良心推荐', '别停更', '太真实了', '直接沦陷',
    ],
  },
  en: {
    hooks: [
      'yo', 'wait', 'okay', 'damn', 'bro', 'help', 'nah', 'dude', 'wow', 'hold up',
      'omg', 'hey', 'fr', 'no way', 'girl', 'bruh', 'ahh', 'please', 'look', 'this',
    ],
    mids: [
      'this edit slaps', 'audio choice is perfect', 'can’t stop rewatching', 'transitions are so clean',
      'that ending hit hard', 'visuals are unreal', 'pacing is chef’s kiss', 'feels cinematic',
      'the cut on the beat tho', 'watched it twice already', 'vibes are immaculate', 'camera work crazy',
      'sound design is wild', 'short but packed', 'poster frame is fire', 'mood switch so smooth',
      'algorithm ate with this', 'this feed find is elite', 'hook in three seconds', 'rewatching again',
    ],
    tails: [
      'saved', 'drop another', 'algo knows me', 'on loop tonight', 'sending this',
      'need a part two', 'followed', 'don’t stop posting', 'this is content', 'i’m obsessed',
      'real talk', 'peak scroll', 'bookmarking', 'too good', 'down bad for this clip',
    ],
  },
  ja: {
    hooks: [
      '待って', 'やば', 'これ', 'マジ', 'えっ', 'うわ', '神', '無理', 'は？', 'きつい',
      'はぁ', '尊い', '沼', 'お願い', '見て', 'ほんと', 'うそ', 'あぶね', 'えぐ', 'いい',
    ],
    mids: [
      '編集うますぎ', 'BGM選定が神', '何回も見てる', 'カットが気持ちいい',
      '締めが刺さる', '映像きれい', 'テンポ完璧', '映画みたい',
      '音ハメ上手', 'もう三回見た', '空気感えぐい', 'カメラワーク好き',
      '短いのに濃い', '光が綺麗', 'サウンドデザイン良い', 'スクロール止まらない',
      'アルゴリズム優秀', '続きが見たい', 'フック強すぎ', 'ループ確定',
    ],
    tails: [
      '保存した', 'もっと見たい', '推せる', '今夜リピート', '友だちに送る',
      'フォローした', '更新まってる', '沼った', '最高', 'また見る',
      '刺さった', 'おすすめ', '止まらない', '好きすぎ', '完敗',
    ],
  },
  ko: {
    hooks: [
      '헐', '잠깐', '이거', '진짜', '와', '대박', '야', '아', '미치', '뭐야',
      '하', '존좋', '제발', '봐봐', '오', 'ㄹㅇ', '아니', '개', '숨', '그만',
    ],
    mids: [
      '편집 미쳤다', 'BGM 센스 뭐냐', '또 보게 됨', '컷 넘김 너무 깔끔',
      '엔딩 소름', '화면 퀄 좋음', '템포 완벽', '영화 느낌',
      '박자 칼각', '세 번 봄', '분위기 미침', '카메라 워크 좋음',
      '짧은데 알차다', '빛 예쁘다', '사운드 디자인 굿', '스크롤 멈춤',
      '알고리즘 인정', '속편 원해', '훅이 세다', '루프 확정',
    ],
    tails: [
      '저장함', '더 올려줘', '추천함', '오늘 밤 반복', '친구한테 보냄',
      '팔로우함', '업데이트 기다림', '빠졌어', '최고', '또 봄',
      '꽂힘', '강추', '손 안 떨어짐', '너무 좋음', '완패',
    ],
  },
  vi: {
    hooks: [
      'ủa', 'chờ', 'clip này', 'thật á', 'trời', 'wow', 'ê', 'á', 'đỉnh', 'gì vậy',
      'haiz', 'please', 'xem', 'ôm', 'đm', 'này', 'stop', 'tim', 'thở', 'ơi',
    ],
    mids: [
      'edit quá cháy', 'nhạc nền chọn đúng bài', 'xem lại mãi', 'cắt cảnh mượt quá',
      'đuôi clip đỉnh', 'hình đẹp muốn lưu', 'nhịp độ chuẩn', 'như phim ngắn',
      'canh beat quá đã', 'xem tới lần ba', 'mood quá đã', 'máy quay biết chiều',
      'ngắn mà đủ vị', 'ánh sáng đẹp', 'âm thanh chỉnh kỹ', 'kéo feed dừng luôn',
      'algo hiểu tui', 'muốn phần hai', 'hook mạnh', 'loop suốt',
    ],
    tails: [
      'đã lưu', 'đăng thêm đi', 'recommend', 'tối nay nghe lại', 'gửi bạn rồi',
      'follow rồi', 'chờ update', 'mê cứng', 'đỉnh thật', 'xem lại',
      'dính rồi', 'nên xem', 'tay không rời', 'quá đã', 'thua rồi',
    ],
  },
  th: {
    hooks: [
      'เห้ย', 'รอดิ', 'คลิปนี้', 'จริงดิ', 'ว้าว', 'บ้า', 'เออ', 'อ่า', 'สุด', 'อะไรนะ',
      'ห๊ะ', 'please', 'ดูดิ', 'โอ้ย', 'แม่', 'นี่', 'หยุด', 'หัวใจ', 'หายใจ', 'โห',
    ],
    mids: [
      'ตัดต่อดีมาก', 'เลือกเพลงเป๊ะ', 'ดูซ้ำไม่เบื่อ', 'ทรานซิชันลื่น',
      'จบคลิปแรง', 'ภาพสวยมาก', 'จังหวะลงตัว', 'เหมือนหนังสั้น',
      'ตัดตามบีทสุด', 'ดูรอบสามแล้ว', 'มู้ดสุดๆ', 'มุมกล้องเฉียบ',
      'สั้นแต่แน่น', 'แสงสวย', 'เสียงดีมาก', 'เลื่อนฟีดแล้วหยุด',
      'อัลกอรู้ใจ', 'อยากได้ภาคสอง', 'ฮุคแรง', 'ลูปยาว',
    ],
    tails: [
      'เซฟแล้ว', 'ขออีกคลิป', 'แนะนำเลย', 'คืนนี้วนซ้ำ', 'ส่งเพื่อนแล้ว',
      'ฟอลแล้ว', 'รออัปเดต', 'ตกแล้ว', 'สุดยอด', 'ดูอีกรอบ',
      'ติดใจ', 'ควรดู', 'มือไม่ยอมเลื่อน', 'ฟินมาก', 'แพ้แล้ว',
    ],
  },
  es: {
    hooks: [
      'espera', 'mira', 'este clip', 'en serio', 'wow', 'joder', 'eh', 'ay', 'brutal', 'qué',
      'uff', 'please', 'ojo', 'dios', 'bro', 'esto', 'stop', 'corazón', 'respira', 'loco',
    ],
    mids: [
      'el edit está brutal', 'el audio pega perfecto', 'lo veo en bucle', 'las transiciones fluyen',
      'el final pega duro', 'la imagen se ve cara', 'el ritmo está perfecto', 'parece cortometraje',
      'corte al beat brutal', 'ya lo vi tres veces', 'la vibra es top', 'cámara de cine',
      'corto pero denso', 'la luz está bella', 'el sonido está cuidado', 'el feed se frenó aquí',
      'el algo me conoce', 'quiero la parte dos', 'el gancho es fuerte', 'loop infinito',
    ],
    tails: [
      'guardado', 'sube otro', 'recomendado', 'esta noche en loop', 'se lo mandé a un colega',
      'ya te sigo', 'espero update', 'me atrapó', 'top', 'otra vez',
      'enganchado', 'hay que verlo', 'no puedo pasar', 'demasiado bueno', 'me rindó',
    ],
  },
  ru: {
    hooks: [
      'стой', 'смотри', 'этот клип', 'серьёзно', 'вау', 'блин', 'эй', 'ах', 'огонь', 'что',
      'ух', 'please', 'смотри-ка', 'боже', 'бро', 'это', 'стоп', 'сердце', 'дышу', 'ну',
    ],
    mids: [
      'монтаж огонь', 'саундтрек в точку', 'пересматриваю снова', 'переходы гладкие',
      'финал впечатал', 'картинка дорогая', 'темп идеален', 'как короткометражка',
      'резка в бит', 'уже третий раз', 'атмосфера качает', 'камера умеет',
      'коротко но насыщенно', 'свет красивый', 'звук продуман', 'лента здесь встала',
      'алгоритм понял', 'хочу часть два', 'хук жёсткий', 'в вечный луп',
    ],
    tails: [
      'сохранил', 'дай ещё', 'рекомендую', 'ночью на репите', 'скинул другу',
      'подписался', 'жду апдейт', 'залип', 'топ', 'ещё раз',
      'зацепило', 'надо смотреть', 'не листается', 'слишком хорошо', 'сдаюсь',
    ],
  },
  fil: {
    hooks: [
      'teka', 'tingnan', 'clip na to', 'serious', 'wow', 'grabe', 'uy', 'ah', 'angas', 'ano',
      'ha', 'please', 'uyy', 'jusko', 'bro', 'ito', 'stop', 'puso', 'hinga', 'pre',
    ],
    mids: [
      'ang galing mag-edit', 'tama na BGM', 'paulit-ulit ko pinapanood', 'smooth ang transition',
      'ang lakas ng ending', 'ang ganda ng visuals', 'perfect ang pace', 'parang short film',
      'timed sa beat', 'ikatlong ulit na', 'ang vibes', 'galing mag-camera',
      'maikli pero puno', 'ang ganda ng lighting', 'solid ang sound', 'tumigil ang feed dito',
      'gets ako ng algo', 'gusto ko part two', 'ang lakas ng hook', 'loop forever',
    ],
    tails: [
      'naka-save', 'mag-post pa', 'recommended', 'i-loop tonight', 'pinasa ko sa tropa',
      'finollow na', 'abang update', 'naadik', 'ang galing', 'ulit ulit',
      'na-hook', 'dapat panoorin', 'di maka-scroll', 'sobrang solid', 'sukong',
    ],
  },
  fr: {
    hooks: [
      'attends', 'regarde', 'ce clip', 'sérieux', 'wow', 'putain', 'eh', 'ah', 'brutal', 'quoi',
      'ouf', 'please', 'vas-y', 'dieu', 'bro', 'ça', 'stop', 'cœur', 'respire', 'mec',
    ],
    mids: [
      'le montage claque', 'le son est parfait', 'je rewatch encore', 'les transitions glissent',
      'la fin fait mal', 'l’image est propre', 'le rythme est nickel', 'comme un court-métrage',
      'coupé sur le beat', 'déjà trois fois', 'l’ambiance est ouf', 'caméra au top',
      'court mais dense', 'la lumière est belle', 'le sound design soigné', 'le feed s’arrête ici',
      'l’algo m’a capté', 'je veux la partie deux', 'le hook est fort', 'en boucle',
    ],
    tails: [
      'sauvegardé', 'encore un', 'je recommande', 'ce soir en loop', 'envoyé à un pote',
      'follow fait', 'j’attends l’update', 'accroché', 'top', 'encore',
      'ça m’a eu', 'à voir', 'je scroll plus', 'trop bien', 'je cède',
    ],
  },
}

function uniqPush(set: Set<string>, arr: string[], v: string, max: number) {
  const t = v.replace(/\s+/g, ' ').trim()
  if (!t || /\d/.test(t) || set.has(t) || arr.length >= max) return
  if (/犯罪|criminal|crime|krimen|преступ|illegal|illégale|phạm luật/i.test(t)) return
  set.add(t)
  arr.push(t)
}

export function generateExploreComments(locale: LocaleCode, count = 200): string[] {
  const frag = EXPLORE_COMMENT_FRAG[locale]
  const out: string[] = []
  const seen = new Set<string>()
  const spices = ['', '~', '…', '!!', '～', '—', '·', '♡', 'lol', 'imo', 'rn', 'pls']
  const joiners = [' ', ' · ', ' — ', '… ', '！', '，', ' / ', '~~']
  let i = 0
  while (out.length < count && i < count * 220) {
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
    uniqPush(seen, out, patterns[i % patterns.length], count)
  }
  let pad = 0
  while (out.length < count && pad < count * 140) {
    pad++
    uniqPush(
      seen,
      out,
      `${frag.mids[pad % frag.mids.length]}${joiners[pad % joiners.length]}${frag.tails[(pad * 5) % frag.tails.length]}${joiners[(pad * 2) % joiners.length]}${frag.hooks[(pad * 17) % frag.hooks.length]}${spices[(pad * 3) % spices.length]}`,
      count,
    )
  }
  return out.slice(0, count)
}

export function exploreCommentId(locale: LocaleCode, body: string, index: number) {
  return `cmt_explore_${locale}_${createHash('sha1').update(`explore|${locale}|${body}|${index}`).digest('hex').slice(0, 16)}`
}

export function buildExploreCopySeed() {
  const comments: Array<{ id: string; locale: LocaleCode; body: string; surface: 'explore' }> = []
  for (const locale of LOCALES) {
    const bodies = generateExploreComments(locale, 200)
    bodies.forEach((body, idx) =>
      comments.push({ id: exploreCommentId(locale, body, idx), locale, body, surface: 'explore' }),
    )
  }
  return { comments }
}
