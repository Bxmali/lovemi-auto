import { useEmailStore } from '../store/emailStore'
import { useSettingsStore } from '../store/settingsStore'

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

function needsRename(a: {
  lovemiProfileReady?: boolean
  lovemiDisplayName?: string
  lovemiSessionToken?: string
}) {
  if (!a.lovemiSessionToken) return false
  if (!a.lovemiProfileReady || !a.lovemiDisplayName) return true
  // 带数字的旧网名 → 强制重改
  if (/\d/.test(a.lovemiDisplayName)) return true
  return false
}

let running = false

/** 为缺语言/未改名/带数字旧名的账号均分语言并 PATCH display_name */
export async function assignLocalesAndRename(opts?: {
  onlyMissing?: boolean
  silent?: boolean
  accountIds?: string[]
}) {
  if (running) return { ok: 0, fail: 0, skipped: true as const }
  running = true
  const onlyMissing = opts?.onlyMissing !== false
  const { accounts, setToast, setLovemiStatus } = useEmailStore.getState()
  try {
    if (!window.lovemi?.consolePickLocale || !window.lovemi.consoleRenameProfile) {
      if (!opts?.silent) setToast('请在 Electron 桌面窗口中操作')
      return { ok: 0, fail: 0 }
    }
    await window.lovemi.consoleEnsureSeed?.()
    const outbound = await resolveOutbound()
    if (!outbound.proxyUrl) {
      if (!opts?.silent) setToast(outbound.error || '无可用代理')
      return { ok: 0, fail: 0 }
    }

    const idSet = opts?.accountIds ? new Set(opts.accountIds) : null
    const pool = accounts.filter((a) => {
      if (a.id.startsWith('demo-') || a.email.endsWith('@example.com')) return false
      if (!a.lovemiSessionToken) return false
      if (idSet && !idSet.has(a.id)) return false
      if (!onlyMissing) return true
      return needsRename(a)
    })
    if (!pool.length) {
      if (!opts?.silent) setToast('没有需要分配语言/改名的账号')
      return { ok: 0, fail: 0 }
    }

    if (!opts?.silent) setToast(`自动改名：${pool.length} 个`)
    let ok = 0
    let fail = 0
    for (const account of pool) {
      const existing = useEmailStore
        .getState()
        .accounts.map((a) => a.lovemiLocale)
        .filter(Boolean) as string[]
      const locale =
        account.lovemiLocale || (await window.lovemi.consolePickLocale(existing))
      if (!account.lovemiLocale) {
        setLovemiStatus(account.id, account.lovemiRegStatus || 'registered', {
          lovemiLocale: locale,
        })
      }
      const token = account.lovemiSessionToken
      if (!token) {
        fail++
        continue
      }
      // 旧名带数字时先清占用，再领新名
      if (account.lovemiDisplayName && /\d/.test(account.lovemiDisplayName)) {
        setLovemiStatus(account.id, account.lovemiRegStatus || 'registered', {
          lovemiProfileReady: false,
          lovemiDisplayName: undefined,
        })
      }
      const res = await window.lovemi.consoleRenameProfile({
        accountId: account.id,
        email: account.email,
        sessionToken: token,
        proxyUrl: outbound.proxyUrl,
        locale,
      })
      if (res.ok && res.displayName) {
        setLovemiStatus(account.id, account.lovemiRegStatus || 'registered', {
          lovemiLocale: locale,
          lovemiDisplayName: res.displayName,
          lovemiProfileReady: true,
          lovemiRegError: undefined,
        })
        ok++
      } else {
        setLovemiStatus(account.id, account.lovemiRegStatus || 'registered', {
          lovemiLocale: locale,
          lovemiRegError: res.error || '改名失败',
        })
        fail++
      }
      await sleep(2500)
    }
    if (!opts?.silent) setToast(`改名完成：成功 ${ok} · 失败 ${fail}`)
    return { ok, fail }
  } finally {
    running = false
  }
}
