import type { RealRegisterTask } from '../lib/parseRealRegister'
import { reloadAccountsFromDisk } from './reloadAccounts'
import { useSettingsStore } from '../store/settingsStore'

const CONCURRENCY = 2

function localUpstreamFromSettings() {
  const s = useSettingsStore.getState()
  const ports = [s.localProxyPort || 7897, 7897, 7890].filter((p, i, arr) => arr.indexOf(p) === i)
  return {
    host: s.localProxyHost || '127.0.0.1',
    ports,
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function randomGap() {
  return 30_000 + Math.floor(Math.random() * 90_000)
}

export type RealRegisterProgress = {
  running: boolean
  done: number
  total: number
  ok: number
  fail: number
  skipped: number
}

let cancelLocal = false

export function cancelRealRegisterQueue() {
  cancelLocal = true
  void window.lovemi?.realRegisterCancel?.()
}

export async function runRealRegisterQueue(
  tasks: RealRegisterTask[],
  onTaskUpdate: (task: RealRegisterTask) => void,
  onProgress: (p: RealRegisterProgress) => void,
): Promise<RealRegisterProgress> {
  cancelLocal = false
  await window.lovemi?.realRegisterResetCancel?.()

  const runnable = tasks.filter((t) => !t.skip && t.status === 'pending')
  const skipped = tasks.filter((t) => t.skip).length
  let done = 0
  let ok = 0
  let fail = 0
  const total = runnable.length

  const progress = (): RealRegisterProgress => ({
    running: done < total && !cancelLocal,
    done,
    total,
    ok,
    fail,
    skipped,
  })

  onProgress({ ...progress(), running: true })

  let cursor = 0
  async function worker() {
    while (true) {
      if (cancelLocal) break
      const idx = cursor++
      if (idx >= runnable.length) break
      const task = runnable[idx]!
      if (!task.proxyUrl || !task.email || !task.refreshToken || !task.clientId) {
        task.status = 'failed'
        task.error = task.parseError || '字段不完整'
        fail++
        done++
        onTaskUpdate({ ...task })
        onProgress(progress())
        continue
      }

      task.status = 'running'
      task.stage = '探测代理'
      onTaskUpdate({ ...task })

      try {
        const result = await window.lovemi!.realRegisterRunOne({
          email: task.email,
          emailPassword: task.emailPassword || '',
          refreshToken: task.refreshToken,
          clientId: task.clientId,
          proxyUrl: task.proxyUrl,
          proxyHost: task.proxyHost || '',
          region: task.region,
          localUpstream: localUpstreamFromSettings(),
        })

        if (cancelLocal) {
          task.status = 'failed'
          task.error = '已取消'
          fail++
        } else if (result.ok) {
          task.status = 'success'
          task.egressIp = result.egressIp
          task.accountId = result.accountId
          task.stage = '已入库'
          ok++
          await reloadAccountsFromDisk({ silent: true })
        } else {
          task.status = 'failed'
          task.error = result.error || '失败'
          task.stage = result.stage
          task.egressIp = result.egressIp
          fail++
        }
      } catch (err) {
        task.status = 'failed'
        task.error = err instanceof Error ? err.message : String(err)
        fail++
      }

      done++
      onTaskUpdate({ ...task })
      onProgress(progress())

      if (idx < runnable.length - 1 && !cancelLocal) {
        await sleep(randomGap())
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, runnable.length) }, () => worker())
  await Promise.all(workers)

  const final = { ...progress(), running: false }
  onProgress(final)
  return final
}
