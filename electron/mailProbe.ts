import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'

export type ProbeInput = {
  email: string
  authMode: string
  refreshToken?: string
  clientId?: string
  proxyUrl?: string
  forceUrlProxy?: boolean
  /** 代理失败时是否直连重试，默认 true */
  fallbackDirect?: boolean
}

export type ProbeResult = {
  ok: boolean
  email: string
  error?: string
  refreshToken?: string
  displayName?: string
  via?: string
}

export type ProxyTestResult = {
  localPortOpen: boolean
  viaProxy: { ok: boolean; error?: string; status?: number }
  direct: { ok: boolean; error?: string; status?: number }
  urlProxyKind: 'vless-subscription' | 'http-proxy' | 'unknown' | 'empty'
  urlProxyHint: string
  recommendation: string
}

type TokenOk = {
  accessToken: string
  refreshToken?: string
  via: string
}

export function dispatcherFor(proxyUrl?: string, targetUrl?: string): Dispatcher | undefined {
  const next = (proxyUrl || '').trim()
  if (!next) return undefined
  if (targetUrl) {
    try {
      if (new URL(next).hostname === new URL(targetUrl).hostname) return undefined
    } catch {
      /* ignore */
    }
  }
  try {
    return new ProxyAgent(next)
  } catch {
    return undefined
  }
}

async function postForm(
  url: string,
  fields: Record<string, string>,
  proxyUrl?: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; networkError?: string }> {
  try {
    const body = new URLSearchParams(fields)
    const dispatcher = dispatcherFor(proxyUrl, url)
    if (proxyUrl && !dispatcher) {
      return {
        ok: false,
        status: 0,
        data: {},
        networkError: '代理地址无法作为 HTTP 代理使用（可能是订阅链接而非 http://host:port）',
      }
    }
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      dispatcher,
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return { ok: res.ok && Boolean(data.access_token), status: res.status, data }
  } catch (err) {
    const cause = err instanceof Error && 'cause' in err ? (err as Error & { cause?: Error }).cause : undefined
    const msg = cause?.message || (err instanceof Error ? err.message : String(err))
    return { ok: false, status: 0, data: {}, networkError: msg }
  }
}

function sanitizeOAuthField(value?: string): string {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[\r\n\t]+/g, '')
    // 误粘贴整段回调 URL / 带 session_state 的尾巴
    .replace(/[?&](session_state|state|code)=.*$/i, '')
    .trim()
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function looksLikeClientId(value: string) {
  return UUID_RE.test(value)
}

/** 纠正导入时 clientId / refreshToken 对调，并清洗空白/引号 */
export function normalizeOAuthCredentials(input: {
  clientId?: string
  refreshToken?: string
}): { clientId: string; refreshToken: string; swapped: boolean; warning?: string } {
  let clientId = sanitizeOAuthField(input.clientId)
  let refreshToken = sanitizeOAuthField(input.refreshToken)
  let swapped = false
  let warning: string | undefined

  // 常见：末尾 UUID 才是 client_id；若 refresh 位是 UUID、client 位是长串 → 对调
  if (looksLikeClientId(refreshToken) && !looksLikeClientId(clientId) && clientId.length > 40) {
    const tmp = clientId
    clientId = refreshToken
    refreshToken = tmp
    swapped = true
    warning = '已自动对调 clientId / refreshToken（导入字段疑似反了）'
  }

  return { clientId, refreshToken, swapped, warning }
}

function tokenError(data: Record<string, unknown>, networkError?: string, status?: number) {
  if (networkError) {
    return `网络失败: ${networkError}`
  }
  const desc = String(data.error_description || data.error || '')
  if (/service abuse/i.test(desc)) return '账号被微软标记 abuse，已不可用'
  if (/AADSTS9002313/i.test(desc)) {
    return 'AADSTS9002313 请求无效（refresh_token/client_id 格式坏了或被截断，请重导账号行）'
  }
  if (/AADSTS70000|AADSTS70008|expired|invalid_grant/i.test(desc)) {
    return desc.slice(0, 180) || 'refresh_token 无效或已过期'
  }
  if (!desc && status) return `token HTTP ${status}`
  return desc.slice(0, 180) || '换票失败'
}

function isNetworkFail(msg?: string) {
  if (!msg) return false
  return /网络失败|ECONNRESET|ECONNREFUSED|fetch failed|ETIMEDOUT|代理地址无法/i.test(msg)
}

export async function acquireAccessToken(
  clientIdRaw: string,
  refreshTokenRaw: string,
  proxyUrl?: string,
): Promise<TokenOk | { error: string }> {
  const { clientId, refreshToken, warning } = normalizeOAuthCredentials({
    clientId: clientIdRaw,
    refreshToken: refreshTokenRaw,
  })

  if (!clientId || !refreshToken) {
    return { error: '缺少刷新令牌或客户端 ID（导入后字段为空）' }
  }
  if (!looksLikeClientId(clientId)) {
    return {
      error: `clientId 不是合法 UUID（当前 ${clientId.slice(0, 12)}…，请检查导入格式 email:pass:refresh:clientId）`,
    }
  }
  if (refreshToken.length < 40) {
    return {
      error: `refresh_token 过短（${refreshToken.length} 字符），多半导入被截断或字段错位`,
    }
  }

  const errors: string[] = []
  // 注意：对公共客户端用 graph `.default` 做 refresh 常触发 AADSTS9002313，放到最后兜底
  const attempts: { name: string; url: string; fields: Record<string, string> }[] = [
    {
      name: 'graph-mail',
      url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      fields: {
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read offline_access openid profile',
      },
    },
    {
      name: 'graph-openid',
      url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      fields: {
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'openid offline_access https://graph.microsoft.com/Mail.Read',
      },
    },
    {
      name: 'live',
      url: 'https://login.live.com/oauth20_token.srf',
      fields: {
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      },
    },
    {
      name: 'imap',
      url: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
      fields: {
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
      },
    },
    {
      name: 'graph-default',
      url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      fields: {
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'https://graph.microsoft.com/.default offline_access',
      },
    },
  ]

  for (const a of attempts) {
    const r = await postForm(a.url, a.fields, proxyUrl)
    if (r.ok) {
      return {
        accessToken: String(r.data.access_token),
        refreshToken: r.data.refresh_token ? String(r.data.refresh_token) : refreshToken,
        via: warning ? `${a.name}+fixed` : a.name,
      }
    }
    errors.push(`${a.name}: ${tokenError(r.data, r.networkError, r.status)}`)
  }

  // 优先展示非 9002313；否则带格式提示
  const preferred =
    errors.find((e) => !/AADSTS9002313/.test(e)) ||
    errors[0] ||
    '全部换票路径失败'
  return { error: preferred }
}

async function graphMe(accessToken: string, proxyUrl?: string) {
  const url = 'https://graph.microsoft.com/v1.0/me'
  try {
    const res = await undiciFetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      dispatcher: dispatcherFor(proxyUrl, url),
    })
    const data = (await res.json()) as {
      mail?: string
      userPrincipalName?: string
      displayName?: string
      error?: { message?: string }
    }
    if (!res.ok) {
      return { ok: false as const, error: data.error?.message || `graph /me HTTP ${res.status}` }
    }
    return {
      ok: true as const,
      displayName: data.displayName || data.mail || data.userPrincipalName,
    }
  } catch (err) {
    return {
      ok: false as const,
      error: `Graph 网络失败: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export async function probeAccount(input: ProbeInput): Promise<ProbeResult> {
  const email = input.email
  const fallbackDirect = input.fallbackDirect !== false
  const normalized = normalizeOAuthCredentials({
    clientId: input.clientId,
    refreshToken: input.refreshToken,
  })

  if (!normalized.refreshToken || !normalized.clientId) {
    return { ok: false, email, error: '缺少刷新令牌或客户端 ID' }
  }

  let acquired = await acquireAccessToken(
    normalized.clientId,
    normalized.refreshToken,
    input.proxyUrl,
  )
  let usedProxy = Boolean(input.proxyUrl)

  // 仅在明确允许时才直连；默认禁止
  if ('error' in acquired && fallbackDirect && input.proxyUrl && isNetworkFail(acquired.error)) {
    acquired = await acquireAccessToken(normalized.clientId, normalized.refreshToken, undefined)
    usedProxy = false
    if (!('error' in acquired)) {
      acquired = { ...acquired, via: `${acquired.via}+direct` }
    }
  }

  if ('error' in acquired) {
    return { ok: false, email, error: acquired.error }
  }

  const proxyForMe = usedProxy ? input.proxyUrl : undefined
  if (acquired.via.startsWith('graph') || acquired.via.includes('graph')) {
    const me = await graphMe(acquired.accessToken, proxyForMe)
    return {
      ok: true,
      email,
      refreshToken: acquired.refreshToken || normalized.refreshToken,
      via: acquired.via,
      displayName: me.ok ? me.displayName : email,
    }
  }

  return {
    ok: true,
    email,
    refreshToken: acquired.refreshToken || normalized.refreshToken,
    via: acquired.via,
    displayName: `${email} · ${acquired.via}`,
  }
}

export async function probeAccountsBatch(
  inputs: ProbeInput[],
  concurrency = 3,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = []
  let i = 0

  async function worker() {
    while (i < inputs.length) {
      const idx = i++
      results[idx] = await probeAccount(inputs[idx]!)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()))
  return results
}

async function pingMicrosoft(proxyUrl?: string) {
  const url = 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration'
  try {
    const dispatcher = dispatcherFor(proxyUrl, url)
    if (proxyUrl && !dispatcher) {
      return { ok: false, error: '代理 URI 无效（订阅链接不能当 HTTP 代理）' }
    }
    const res = await undiciFetch(url, { dispatcher })
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}` }
  } catch (err) {
    const cause = err instanceof Error && 'cause' in err ? (err as Error & { cause?: Error }).cause : undefined
    return { ok: false, error: cause?.message || (err instanceof Error ? err.message : String(err)) }
  }
}

export async function testProxyConnectivity(input: {
  localProxyUrl?: string
  urlProxy?: string
}): Promise<ProxyTestResult> {
  const net = await import('node:net')
  let localPortOpen = false
  if (input.localProxyUrl) {
    try {
      const u = new URL(input.localProxyUrl)
      const port = Number(u.port || 80)
      localPortOpen = await new Promise<boolean>((resolve) => {
        const s = net.connect({ host: u.hostname, port }, () => {
          s.end()
          resolve(true)
        })
        s.on('error', () => resolve(false))
        s.setTimeout(1200, () => {
          s.destroy()
          resolve(false)
        })
      })
    } catch {
      localPortOpen = false
    }
  }

  const viaProxy = input.localProxyUrl
    ? await pingMicrosoft(input.localProxyUrl)
    : { ok: false, error: '未配置本地代理' }
  const direct = await pingMicrosoft(undefined)

  let urlProxyKind: ProxyTestResult['urlProxyKind'] = 'empty'
  let urlProxyHint = '未填写'
  const raw = (input.urlProxy || '').trim()
  if (raw) {
    try {
      new ProxyAgent(raw)
      urlProxyKind = 'http-proxy'
      urlProxyHint = '可作为 HTTP 代理 URI'
    } catch {
      try {
        const res = await undiciFetch(raw)
        const text = await res.text()
        const decoded = Buffer.from(text.trim(), 'base64').toString('utf8')
        if (/^vless:\/\//i.test(decoded) || /^vmess:\/\//i.test(decoded) || /^ss:\/\//i.test(decoded)) {
          urlProxyKind = 'vless-subscription'
          urlProxyHint = '这是机场/节点订阅（VLESS），请导入 Clash，应用请走本地 7890，不能把此 URL 当 HTTP 代理'
        } else {
          urlProxyKind = 'unknown'
          urlProxyHint = `可访问（HTTP ${res.status}），但不是标准 HTTP 代理 URI`
        }
      } catch (e) {
        urlProxyKind = 'unknown'
        urlProxyHint = `无法识别：${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  let recommendation = ''
  if (viaProxy.ok) {
    recommendation = '本地代理可访问微软，邮箱检测可走本地代理'
  } else if (direct.ok) {
    recommendation =
      '本地代理访问微软失败（常见 ECONNRESET），直连可用。已启用「代理失败自动直连」。请检查 Clash 对 microsoft 域名的规则/节点'
  } else {
    recommendation = '本地代理与直连都无法访问微软，请检查网络'
  }

  return {
    localPortOpen,
    viaProxy,
    direct,
    urlProxyKind,
    urlProxyHint,
    recommendation,
  }
}
