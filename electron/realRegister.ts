import { randomUUID } from 'node:crypto'
import { fetch as undiciFetch } from 'undici'
import { upsertAccount } from './accountsDb'
import { claimDisplayName } from './consoleDb'
import { dispatcherFor } from './mailProbe'
import { loginLovemiPassword } from './lovemiAuth'
import { registerLovemiAccount } from './lovemiRegister'
import { markRealRegisterEmailUsed } from './realRegisterPool'
import {
  buildRegisterFingerprint,
  randomOtpDelayMs,
  type RegisterHttpProfile,
} from './registerFingerprint'
import {
  type LocalUpstreamOptions,
  resolveLocalUpstreamProxy,
  withResidentialProxyChain,
} from './residentialProxyChain'

export type RealRegisterTaskInput = {
  email: string
  emailPassword: string
  refreshToken: string
  clientId: string
  proxyUrl: string
  proxyHost: string
  region?: string
  /** 本地 Clash mixed-port；未传则自动探测 7897 / 7890 */
  localUpstream?: LocalUpstreamOptions
}

export type RealRegisterTaskResult = {
  ok: boolean
  email: string
  error?: string
  stage?: string
  egressIp?: string
  reclaimed?: boolean
  accountId?: string
  lovemiPassword?: string
  sessionToken?: string
  userId?: string
  displayName?: string
  fingerprint?: RegisterHttpProfile
}

let cancelFlag = false

export function cancelRealRegisterBatch() {
  cancelFlag = true
}

export function resetRealRegisterCancel() {
  cancelFlag = false
}

export function isRealRegisterCancelled() {
  return cancelFlag
}

/** host:port:user:pass → http://user:pass@host:port */
export function parseResidentialProxyLine(line: string): { proxyUrl: string; host: string } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const parts = trimmed.split(':')
  if (parts.length < 4) return null
  const host = parts[0]?.trim()
  const port = parts[1]?.trim()
  const user = parts[2]?.trim()
  const pass = parts.slice(3).join(':').trim()
  if (!host || !port || !user || !pass) return null
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.includes('.')) return null
  const proxyUrl = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`
  return { proxyUrl, host }
}

async function probeEgressViaChainedProxy(
  chainedProxyUrl: string,
  localUpstreamUrl: string,
): Promise<{ ok: boolean; ip?: string; error?: string; localUpstreamUrl: string }> {
  const url = 'https://api.ipify.org?format=json'
  try {
    const res = await undiciFetch(url, {
      headers: { Accept: 'application/json' },
      dispatcher: dispatcherFor(chainedProxyUrl, url),
      signal: AbortSignal.timeout(35_000),
    })
    const data = (await res.json().catch(() => ({}))) as { ip?: string }
    if (!res.ok) return { ok: false, error: `探测 HTTP ${res.status}`, localUpstreamUrl }
    const ip = String(data.ip || '').trim()
    if (!ip) return { ok: false, error: '未获取出口 IP', localUpstreamUrl }
    return { ok: true, ip, localUpstreamUrl }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), localUpstreamUrl }
  }
}

export async function probeProxyEgress(
  residentialProxyUrl: string,
  localUpstream?: LocalUpstreamOptions,
): Promise<{ ok: boolean; ip?: string; error?: string; localUpstreamUrl?: string }> {
  try {
    return await withResidentialProxyChain(residentialProxyUrl, localUpstream, async ({ proxyUrl, localUpstreamUrl }) =>
      probeEgressViaChainedProxy(proxyUrl, localUpstreamUrl),
    )
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function runRealRegisterTask(input: RealRegisterTaskInput): Promise<RealRegisterTaskResult> {
  const email = input.email.trim().toLowerCase()
  if (cancelFlag) return { ok: false, email, error: '已取消', stage: 'cancelled' }
  if (!input.proxyUrl) return { ok: false, email, error: '缺少代理', stage: 'validate' }
  if (/127\.0\.0\.1|localhost|192\.168\.|10\.\d+\./i.test(input.proxyUrl)) {
    return { ok: false, email, error: '禁止局域网代理', stage: 'validate' }
  }

  const fingerprint = buildRegisterFingerprint(input.region)
  const accountId = randomUUID()

  const localUpstream = input.localUpstream
  const localUpstreamUrl = await resolveLocalUpstreamProxy(localUpstream)
  if (!localUpstreamUrl) {
    const ports = (localUpstream?.ports?.length ? localUpstream.ports : [7897, 7890]).join('、')
    return { ok: false, email, error: `本地代理未监听（已尝试 ${ports}）`, stage: 'validate', fingerprint }
  }

  let probe: Awaited<ReturnType<typeof probeEgressViaChainedProxy>> | undefined
  let reg: Awaited<ReturnType<typeof registerLovemiAccount>> | undefined
  let sessionToken: string | undefined
  let userId: string | undefined
  let lovemiPassword: string | undefined
  let reclaimed = false
  let claimed: ReturnType<typeof claimDisplayName> | undefined
  let displayName = email.split('@')[0]

  try {
    await withResidentialProxyChain(input.proxyUrl, localUpstream, async ({ proxyUrl, localUpstreamUrl }) => {
      probe = await probeEgressViaChainedProxy(proxyUrl, localUpstreamUrl)
      if (cancelFlag) return
      if (!probe.ok) return

      claimed = claimDisplayName(fingerprint.locale, accountId)
      displayName = claimed.ok && claimed.name ? claimed.name : email.split('@')[0]

      reg = await registerLovemiAccount({
        email,
        refreshToken: input.refreshToken,
        clientId: input.clientId,
        proxyUrl,
        displayName,
        httpProfile: fingerprint,
        otpDelayMs: randomOtpDelayMs(),
        preferReclaim: false,
      })

      if (cancelFlag || !reg.ok) return

      sessionToken = reg.sessionToken
      userId = reg.userId
      lovemiPassword = reg.password
      reclaimed = reg.otpSource === 'graph_mail' && !reg.challengeId

      if (!sessionToken && lovemiPassword) {
        const login = await loginLovemiPassword({
          email,
          password: lovemiPassword,
          proxyUrl,
          httpProfile: fingerprint,
        })
        if (login.ok) {
          sessionToken = login.sessionToken
          userId = login.userId || userId
        }
      }
    })
  } catch (err) {
    return {
      ok: false,
      email,
      error: err instanceof Error ? err.message : String(err),
      stage: 'probe',
      fingerprint,
    }
  }

  if (cancelFlag) return { ok: false, email, error: '已取消', stage: 'cancelled' }
  if (!probe?.ok) {
    return {
      ok: false,
      email,
      error: `代理不可用: ${probe?.error || '探测失败'}`,
      stage: 'probe',
      fingerprint,
    }
  }

  if (!reg?.ok) {
    if (claimed?.ok) {
      const { releaseDisplayName } = await import('./consoleDb')
      releaseDisplayName(accountId)
    }
    return {
      ok: false,
      email,
      error: reg?.error || '注册失败',
      stage: 'register',
      egressIp: probe.ip,
      fingerprint,
    }
  }

  const now = new Date().toISOString()
  const account = {
    id: accountId,
    email,
    authMode: 'oauth_graph' as const,
    password: input.emailPassword,
    refreshToken: input.refreshToken,
    clientId: input.clientId,
    labels: ['real-register', input.region || ''].filter(Boolean),
    status: sessionToken ? ('ready' as const) : ('idle' as const),
    notes: `真实注册 · ${input.proxyHost}${probe.ip ? ` · 出口 ${probe.ip}` : ''}`,
    createdAt: now,
    lastOkAt: sessionToken ? now : undefined,
    lovemiRegistered: true,
    lovemiRegStatus: 'registered' as const,
    lovemiRegisteredAt: now,
    lovemiPassword,
    lovemiSessionToken: sessionToken,
    lovemiUserId: userId,
    lovemiTokenAt: sessionToken ? now : undefined,
    lovemiDisplayName: displayName,
    lovemiLocale: fingerprint.locale,
    lovemiProfileReady: !!claimed?.ok,
    registerProxyUrl: input.proxyUrl,
    registerEgressIp: probe.ip,
    registerFingerprint: JSON.stringify({
      userAgent: fingerprint.userAgent,
      acceptLanguage: fingerprint.acceptLanguage,
      locale: fingerprint.locale,
      platform: fingerprint.platform,
      chromeMajor: fingerprint.chromeMajor,
      timezone: fingerprint.timezone,
      viewport: fingerprint.viewport,
      screen: fingerprint.screen,
      deviceMemory: fingerprint.deviceMemory,
      hardwareConcurrency: fingerprint.hardwareConcurrency,
      refererUrl: fingerprint.refererUrl,
    }),
    registerSource: 'real' as const,
  }

  const saved = upsertAccount(account)
  if (!saved.ok) {
    return {
      ok: false,
      email,
      error: saved.error || '入库失败',
      stage: 'persist',
      egressIp: probe.ip,
      fingerprint,
    }
  }

  markRealRegisterEmailUsed(email)

  return {
    ok: true,
    email,
    stage: 'done',
    egressIp: probe.ip,
    reclaimed,
    accountId,
    lovemiPassword,
    sessionToken,
    userId,
    displayName,
    fingerprint,
  }
}
