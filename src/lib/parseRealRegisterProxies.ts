export type ParsedProxyRow = {
  lineNo: number
  raw: string
  region?: string
  skip?: boolean
  skipReason?: string
  proxyUrl?: string
  proxyHost?: string
}

const REGION_RE = /^(纽约|洛杉矶|华盛顿|芝加哥|达拉斯|西雅图|波士顿|迈阿密|[\u4e00-\u9fff]{2,8})$/

function isRegionLabel(line: string) {
  const t = line.trim()
  if (!t) return false
  if (REGION_RE.test(t)) return true
  if (/[a-zA-Z0-9@.]/.test(t)) return false
  return /^[\u4e00-\u9fff\s·-]+$/.test(t)
}

/** host:port:user:pass */
export function parseProxyLine(line: string, lineNo: number, region?: string, regionSkip?: boolean): ParsedProxyRow {
  const raw = line.trim()
  if (!raw || raw.startsWith('#')) {
    return { lineNo, raw, skip: true, skipReason: '空行' }
  }
  if (isRegionLabel(raw)) {
    return { lineNo, raw, skip: true, skipReason: '地区标题' }
  }
  const parts = raw.split(':')
  if (parts.length < 4) {
    return { lineNo, raw, region, skip: true, skipReason: '代理格式无效（需 host:port:user:pass）' }
  }
  const host = parts[0]?.trim() || ''
  const port = parts[1]?.trim() || ''
  const user = parts[2]?.trim() || ''
  const pass = parts.slice(3).join(':').trim()
  if (!host || !port || !user || !pass) {
    return { lineNo, raw, region, skip: true, skipReason: '代理字段不完整' }
  }
  if (regionSkip || /华盛顿/.test(region || '')) {
    return {
      lineNo,
      raw,
      region,
      skip: true,
      skipReason: '华盛顿组不执行',
      proxyHost: host,
    }
  }
  const proxyUrl = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`
  return { lineNo, raw, region, proxyUrl, proxyHost: host }
}

export function parseProxyBlock(raw: string): ParsedProxyRow[] {
  const rows: ParsedProxyRow[] = []
  let region: string | undefined
  let regionSkip = false
  const lines = raw.split(/\r?\n/)
  lines.forEach((line, i) => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return
    if (isRegionLabel(t)) {
      region = t.replace(/\s+/g, '')
      regionSkip = /华盛顿/.test(region)
      return
    }
    rows.push(parseProxyLine(t, i + 1, region, regionSkip))
  })
  return rows.filter((r) => r.raw && !r.skipReason?.includes('空行') && !r.skipReason?.includes('地区标题'))
}
