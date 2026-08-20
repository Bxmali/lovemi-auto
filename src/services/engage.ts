import { useEmailStore } from '../store/emailStore'
import { useSettingsStore } from '../store/settingsStore'
import { useConsoleStore } from '../store/consoleStore'

async function resolveOutbound() {
  const settings = useSettingsStore.getState()
  if (!window.lovemi?.resolveMailProxy) {
    return { proxyUrl: undefined as string | undefined, error: '请在 Electron 中运行' }
  }
  const st = await window.lovemi.resolveMailProxy({
    vlessEnabled: settings.urlProxyEnabled && settings.mailProxyRoute === 'vless',
    subscriptionUrl: settings.urlProxy,
    localEnabled: settings.localProxyEnabled,
    localHost: settings.localProxyHost,
    localPort: settings.localProxyPort,
  })
  return { proxyUrl: st.proxyUrl, error: st.error }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function randBetween(min: number, max: number) {
  return min + Math.random() * (max - min)
}

let draining = false

function participateAccounts() {
  return useEmailStore
    .getState()
    .accounts.filter(
      (a) =>
        !a.id.startsWith('demo-') &&
        !a.email.endsWith('@example.com') &&
        a.lovemiSessionToken,
    )
    .map((a) => ({
      id: a.id,
      email: a.email,
      sessionToken: a.lovemiSessionToken!,
      locale: a.lovemiLocale,
      displayName: a.lovemiDisplayName,
    }))
}

/** 处理一条 pending；返回是否应继续 */
export async function engageOneStep(): Promise<{
  continue: boolean
  rateLimited?: boolean
  done?: boolean
  failed?: boolean
}> {
  const consoleSt = useConsoleStore.getState()
  if (!window.lovemi?.consoleEngageStep) {
    useEmailStore.getState().setToast('请在 Electron 中运行')
    return { continue: false }
  }
  const outbound = await resolveOutbound()
  if (!outbound.proxyUrl) {
    useEmailStore.getState().setToast(outbound.error || '无可用代理')
    return { continue: false }
  }
  const accounts = participateAccounts()
  if (!accounts.length) {
    useEmailStore.getState().setToast('没有可用 Bearer 账号')
    return { continue: false }
  }

  const res = await window.lovemi.consoleEngageStep({
    accounts,
    proxyUrl: outbound.proxyUrl,
    rateMin: consoleSt.rateMin,
    rateMax: consoleSt.rateMax,
  })

  if (res.done) return { continue: true, done: true }

  if (res.rateLimited) {
    useConsoleStore.getState().bumpFailStreak()
    return { continue: true, rateLimited: true, failed: !res.ok }
  }

  if (!res.ok && res.action === 'failed') {
    useConsoleStore.getState().bumpFailStreak()
    return { continue: true, failed: true }
  }

  if (res.ok && (res.action === 'liked' || res.action === 'commented' || res.action === 'skipped')) {
    useConsoleStore.getState().resetFailStreak()
  }

  return { continue: true, failed: !res.ok }
}

/** 自动互动：多路并发 + 短间隔 */
export async function drainEngageQueue() {
  if (draining) return
  draining = true
  const store = useConsoleStore.getState()
  store.setEngaging(true)

  let refreshChain: Promise<void> = Promise.resolve()
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  const flushRefresh = () => {
    refreshChain = refreshChain
      .then(async () => {
        await useConsoleStore.getState().refreshStats()
        await useConsoleStore.getState().refreshLogs()
      })
      .catch(() => {})
  }
  const scheduleRefresh = () => {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      flushRefresh()
    }, 2000)
  }

  const worker = async (workerId: number) => {
    while (useConsoleStore.getState().autoEngage) {
      if (useConsoleStore.getState().failStreak >= useConsoleStore.getState().failPauseAt) {
        useConsoleStore.getState().setAutoEngage(false)
        useEmailStore.getState().setToast('连续失败过多，已自动暂停互动')
        await window.lovemi?.consoleLog?.({
          level: 'error',
          action: 'pause',
          message: `连续失败 ${useConsoleStore.getState().failStreak} 次，自动关闭自动互动`,
        })
        break
      }

      const step = await engageOneStep()
      scheduleRefresh()

      if (!useConsoleStore.getState().autoEngage) break

      if (step.rateLimited) {
        await sleep(20_000 + workerId * 800)
        continue
      }
      if (step.done) {
        await sleep(5_000 + workerId * 400)
        continue
      }

      const { gapMinMs, gapMaxMs } = useConsoleStore.getState()
      await sleep(randBetween(gapMinMs, gapMaxMs))
    }
  }

  try {
    const n = Math.max(1, Math.min(12, useConsoleStore.getState().engageConcurrency || 8))
    await window.lovemi?.consoleLog?.({
      level: 'info',
      action: 'auto',
      message: `互动并发 ${n} 路 · 间隔 ${Math.round(store.gapMinMs / 1000)}–${Math.round(store.gapMaxMs / 1000)}s`,
    })
    await Promise.all(Array.from({ length: n }, (_, i) => worker(i)))
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = undefined
    }
    flushRefresh()
    await refreshChain
  } finally {
    draining = false
    useConsoleStore.getState().setEngaging(false)
  }
}

export function kickEngageLoop() {
  if (!useConsoleStore.getState().autoEngage) return
  void drainEngageQueue()
}
