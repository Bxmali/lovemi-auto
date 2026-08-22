export type RegisterHttpProfile = {
  userAgent: string
  acceptLanguage: string
  secChUa: string
  secChUaMobile: string
  secChUaPlatform: string
  secChUaPlatformVersion?: string
  locale: 'en' | 'zh' | 'ja' | 'ko'
  platform: 'mac' | 'win'
  chromeMajor: number
  timezone: string
  viewport: { width: number; height: number }
  screen: { width: number; height: number }
  deviceMemory: number
  hardwareConcurrency: number
  refererUrl: string
}

const CHROME_MAJORS = [122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136]

const MAC_OS_STRINGS = [
  '10_15_7',
  '13_6_7',
  '13_6_9',
  '14_4_1',
  '14_5_0',
  '14_6_1',
  '14_7_1',
  '15_0_1',
  '15_1_0',
  '15_2_0',
]

const WIN_BUILDS = ['19045', '22621', '22631', '26100']

const US_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
]

const LANG_POOL: Array<{ acceptLanguage: string; locale: RegisterHttpProfile['locale'] }> = [
  { acceptLanguage: 'en-US,en;q=0.9', locale: 'en' },
  { acceptLanguage: 'en-US,en;q=0.9,zh-CN;q=0.7', locale: 'en' },
  { acceptLanguage: 'en-US,en;q=0.9,zh;q=0.8', locale: 'en' },
  { acceptLanguage: 'en-US,en;q=0.9,es;q=0.6', locale: 'en' },
  { acceptLanguage: 'en-US,en;q=0.9,ja;q=0.5', locale: 'en' },
  { acceptLanguage: 'en,en-US;q=0.9', locale: 'en' },
  { acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8', locale: 'zh' },
  { acceptLanguage: 'zh-CN,zh;q=0.9,en-US;q=0.7', locale: 'zh' },
  { acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.8', locale: 'ja' },
  { acceptLanguage: 'ja,ja-JP;q=0.9,en;q=0.8', locale: 'ja' },
  { acceptLanguage: 'ko-KR,ko;q=0.9,en-US;q=0.8', locale: 'ko' },
  { acceptLanguage: 'ko,ko-KR;q=0.9,en;q=0.7', locale: 'ko' },
]

const VIEWPORTS: Array<{ width: number; height: number }> = [
  { width: 1440, height: 900 },
  { width: 1512, height: 982 },
  { width: 1536, height: 864 },
  { width: 1680, height: 1050 },
  { width: 1728, height: 1117 },
  { width: 1920, height: 1080 },
  { width: 1920, height: 1200 },
  { width: 2560, height: 1440 },
]

const REFERER_URLS = ['https://ackr.app/e2', 'https://ackr.app/s3']

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

function randInt(min: number, max: number) {
  return min + Math.floor(Math.random() * (max - min + 1))
}

function chromePatch(major: number) {
  const build = randInt(6000, 6999)
  const patch = randInt(40, 220)
  return `${major}.0.${build}.${patch}`
}

function buildMacUa(chromeFull: string, os: string) {
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X ${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeFull} Safari/537.36`
}

function buildWinUa(chromeFull: string) {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeFull} Safari/537.36`
}

function secChUa(chromeMajor: number) {
  const notBrand = pick(['"Not_A Brand";v="8"', '"Not-A.Brand";v="99"', '"Not)A;Brand";v="24"'])
  const order = Math.random() > 0.5
    ? [`"Chromium";v="${chromeMajor}"`, `"Google Chrome";v="${chromeMajor}"`, notBrand]
    : [`"Google Chrome";v="${chromeMajor}"`, `"Chromium";v="${chromeMajor}"`, notBrand]
  return order.join(', ')
}

function jitterAcceptLanguage(base: string) {
  const parts = base.split(',').map((p) => p.trim())
  if (parts.length < 2 || Math.random() > 0.45) return base
  const tail = parts.slice(1).map((seg) => {
    const m = seg.match(/^([a-zA-Z0-9-]+)(;q=[\d.]+)?$/)
    if (!m) return seg
    const q = Math.max(0.5, Math.min(0.95, (Number(m[2]?.slice(3)) || 0.8) + (Math.random() - 0.5) * 0.12))
    return `${m[1]};q=${q.toFixed(1)}`
  })
  return [parts[0], ...tail].join(',')
}

function screenForViewport(vp: { width: number; height: number }) {
  const scale = pick([1, 1, 1, 1.25, 1.5, 2])
  return {
    width: Math.round(vp.width * scale),
    height: Math.round(vp.height * scale),
  }
}

function platformVersion(mac: boolean) {
  if (mac) {
    const os = pick(MAC_OS_STRINGS)
    const major = os.startsWith('15') ? '15' : os.startsWith('14') ? '14' : os.startsWith('13') ? '13' : '10'
    return `"${major}.${randInt(0, 6)}.0"`
  }
  return `"${pick(WIN_BUILDS)}.0"`
}

/** 每任务一份固定设备画像（注册全程复用） */
export function buildRegisterFingerprint(regionHint?: string): RegisterHttpProfile {
  const chromeMajor = pick(CHROME_MAJORS)
  const chromeFull = chromePatch(chromeMajor)
  const mac = Math.random() > 0.48
  const userAgent = mac
    ? buildMacUa(chromeFull, pick(MAC_OS_STRINGS))
    : buildWinUa(chromeFull)

  let lang = pick(LANG_POOL)
  const hint = String(regionHint || '').toLowerCase()
  if (/纽约|洛杉矶|华盛顿|美国|us|ny|la|chicago|denver/.test(hint)) {
    lang = pick(LANG_POOL.filter((l) => l.locale === 'en'))
  }

  const viewport = pick(VIEWPORTS)
  const screen = screenForViewport(viewport)
  const timezone = /纽约|ny|美国|us|华盛顿|洛杉矶|la|chicago|denver/.test(hint)
    ? pick(US_TIMEZONES)
    : pick([...US_TIMEZONES, 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Europe/London'])

  return {
    userAgent,
    acceptLanguage: jitterAcceptLanguage(lang.acceptLanguage),
    secChUa: secChUa(chromeMajor),
    secChUaMobile: '?0',
    secChUaPlatform: mac ? '"macOS"' : '"Windows"',
    secChUaPlatformVersion: platformVersion(mac),
    locale: lang.locale,
    platform: mac ? 'mac' : 'win',
    chromeMajor,
    timezone,
    viewport,
    screen,
    deviceMemory: pick([4, 8, 8, 16, 16, 32]),
    hardwareConcurrency: pick([4, 6, 8, 8, 10, 12, 16]),
    refererUrl: pick(REFERER_URLS),
  }
}

export function headersFromProfile(profile?: RegisterHttpProfile): Record<string, string> {
  if (!profile) {
    return {
      Accept: 'application/json',
      'Accept-Language': 'zh-CN',
    }
  }
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': profile.acceptLanguage,
    'User-Agent': profile.userAgent,
    'Sec-CH-UA': profile.secChUa,
    'Sec-CH-UA-Mobile': profile.secChUaMobile,
    'Sec-CH-UA-Platform': profile.secChUaPlatform,
    Origin: 'https://ackr.app',
    Referer: profile.refererUrl,
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  }
  if (profile.secChUaPlatformVersion) {
    headers['Sec-CH-UA-Platform-Version'] = profile.secChUaPlatformVersion
  }
  if (profile.chromeMajor >= 124 && Math.random() > 0.35) {
    headers.Priority = pick(['u=1, i', 'u=1'])
  }
  return headers
}

/** 模拟人工输入验证码：多数 2–7s，少数走神 10–18s */
export function randomOtpDelayMs() {
  if (Math.random() < 0.12) return 10_000 + Math.floor(Math.random() * 8_000)
  return 2_000 + Math.floor(Math.random() * 5_500)
}

export function randomQueueGapMs() {
  return 30_000 + Math.floor(Math.random() * 90_000)
}
