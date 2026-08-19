import type { EmailAccount } from '../types/email'
import { useEmailStore } from '../store/emailStore'

/** 从本机加密库存刷新 UI。silent 时不弹 toast（启动/聚焦自动同步） */
export async function reloadAccountsFromDisk(opts?: { silent?: boolean }): Promise<number> {
  const { replaceAccounts, setToast, setSuspendPersist } = useEmailStore.getState()
  if (!window.lovemi?.loadAccounts) {
    if (!opts?.silent) setToast('无法读取本机库存')
    return 0
  }
  setSuspendPersist(true)
  try {
    const raw = await window.lovemi.loadAccounts()
    if (!raw) {
      replaceAccounts([])
      if (!opts?.silent) setToast('本机库存为空')
      return 0
    }
    const parsed = JSON.parse(raw) as EmailAccount[]
    const real = Array.isArray(parsed)
      ? parsed
          .filter(
            (a) =>
              a && !String(a.id || '').startsWith('demo-') && !String(a.email || '').endsWith('@example.com'),
          )
          .map((a) => ({
            ...a,
            labels: (a.labels || []).filter((l) => !/^lovemi(-reg)?$/i.test(String(l))),
          }))
      : []
    replaceAccounts(real)
    if (!opts?.silent) {
      const ready = real.filter((a) => a.status === 'ready').length
      const err = real.filter((a) => a.status === 'error').length
      setToast(`已同步磁盘：可用 ${ready} · 异常 ${err} · 共 ${real.length}`)
    }
    return real.length
  } catch (e) {
    if (!opts?.silent) setToast(e instanceof Error ? e.message : '同步失败')
    return 0
  } finally {
    window.setTimeout(() => setSuspendPersist(false), 1500)
  }
}
