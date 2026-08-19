import { useEmailStore } from '../store/emailStore'
import { useSettingsStore } from '../store/settingsStore'

function isDemo(email: string, id: string) {
  return id.startsWith('demo-') || email.endsWith('@example.com')
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function resolveOutbound() {
  const settings = useSettingsStore.getState()
  if (!window.lovemi?.resolveMailProxy) {
    return { proxyUrl: undefined as string | undefined, label: '无主进程', error: '请在 Electron 中运行' }
  }
  const st = await window.lovemi.resolveMailProxy({
    vlessEnabled: settings.urlProxyEnabled && settings.mailProxyRoute === 'vless',
    subscriptionUrl: settings.urlProxy,
    localEnabled: settings.localProxyEnabled,
    localHost: settings.localProxyHost,
    localPort: settings.localProxyPort,
  })
  return {
    proxyUrl: st.proxyUrl,
    label:
      st.source === 'vless'
        ? `VLESS ${st.nodeServer || ''}`.trim()
        : st.source === 'fallback-local'
          ? '本地兜底'
          : st.error || '无可用出站',
    error: st.error,
  }
}

const pendingIds: string[] = []
let draining = false
const GAP_MS = 1500
const RATE_WAIT_MS = 12_000

export function enqueueLovemiLogin(ids: string[]) {
  const { accounts } = useEmailStore.getState()
  const byId = new Map(accounts.map((a) => [a.id, a]))
  for (const id of ids) {
    const a = byId.get(id)
    if (!a || isDemo(a.email, a.id)) continue
    if (!a.lovemiPassword && !(a.refreshToken && a.clientId)) continue
    if (pendingIds.includes(id)) continue
    pendingIds.push(id)
  }
  void drainLoginQueue()
}

/** 为已注册但缺 Bearer 的账号排队登录取票 */
export function enqueueLoginMissingTokens() {
  const ids = useEmailStore
    .getState()
    .accounts.filter(
      (a) =>
        !isDemo(a.email, a.id) &&
        a.lovemiRegistered &&
        !a.lovemiSessionToken &&
        (a.lovemiPassword || (a.refreshToken && a.clientId)),
    )
    .map((a) => a.id)
  enqueueLovemiLogin(ids)
}

async function drainLoginQueue() {
  if (draining) return
  draining = true
  const { setToast, applyLovemiLogins, probing, registering } = useEmailStore.getState()
  if (probing || registering) {
    draining = false
    return
  }
  if (!window.lovemi?.loginLovemi) {
    draining = false
    return
  }

  const outbound = await resolveOutbound()
  if (!outbound.proxyUrl) {
    setToast(outbound.error || '无可用代理，无法登录取票')
    pendingIds.length = 0
    draining = false
    return
  }

  let ok = 0
  let fail = 0
  if (pendingIds.length) setToast(`登录取票队列：${pendingIds.length} 个`)

  while (pendingIds.length > 0) {
    const st = useEmailStore.getState()
    if (st.probing || st.registering) break

    const id = pendingIds.shift()!
    const account = useEmailStore.getState().accounts.find((a) => a.id === id)
    if (!account) continue
    if (account.lovemiSessionToken) continue
    if (!account.lovemiPassword && !(account.refreshToken && account.clientId)) continue

    try {
      let result = await window.lovemi.loginLovemi({
        email: account.email,
        password: account.lovemiPassword,
        refreshToken: account.refreshToken,
        clientId: account.clientId,
        proxyUrl: outbound.proxyUrl,
      })
      if (!result.ok && /too many|rate|429/i.test(result.error || '')) {
        setToast('登录限流，等待后重试…')
        await sleep(RATE_WAIT_MS)
        result = await window.lovemi.loginLovemi({
          email: account.email,
          password: account.lovemiPassword,
          refreshToken: account.refreshToken,
          clientId: account.clientId,
          proxyUrl: outbound.proxyUrl,
        })
      }
      applyLovemiLogins([
        {
          email: result.email,
          ok: result.ok,
          error: result.error,
          sessionToken: result.sessionToken,
          userId: result.userId,
        },
      ])
      if (result.ok) ok++
      else fail++
    } catch (err) {
      applyLovemiLogins([
        {
          email: account.email,
          ok: false,
          error: err instanceof Error ? err.message : '登录失败',
        },
      ])
      fail++
    }
    if (pendingIds.length > 0) await sleep(GAP_MS)
  }

  draining = false
  if (ok + fail > 0) setToast(`取票完成：成功 ${ok} · 失败 ${fail}`)
  if (pendingIds.length > 0 && !useEmailStore.getState().probing && !useEmailStore.getState().registering) {
    void drainLoginQueue()
  }
}
