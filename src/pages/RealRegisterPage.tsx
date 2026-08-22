import { useEffect, useMemo, useState } from 'react'
import { buildRealRegisterTasks, type RealRegisterTask } from '../lib/parseRealRegister'
import type { ParsedImportLine } from '../types/email'
import { cancelRealRegisterQueue, runRealRegisterQueue, type RealRegisterProgress } from '../services/realRegisterQueue'
import { useEmailStore } from '../store/emailStore'

const STATUS_LABEL: Record<RealRegisterTask['status'], string> = {
  pending: '待执行',
  running: '进行中',
  success: '成功',
  failed: '失败',
  skipped: '跳过',
}

type PoolState = {
  path: string
  total: number
  available: number
  excluded: number
  accounts: ParsedImportLine[]
}

export function RealRegisterPage() {
  const setToast = useEmailStore((s) => s.setToast)
  const [proxyRaw, setProxyRaw] = useState('')
  const [poolPath, setPoolPath] = useState('')
  const [pool, setPool] = useState<PoolState | null>(null)
  const [poolLoading, setPoolLoading] = useState(false)
  const [tasks, setTasks] = useState<RealRegisterTask[]>([])
  const [parseErrors, setParseErrors] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<RealRegisterProgress | null>(null)

  const loadPool = async (customPath?: string) => {
    if (!window.lovemi?.realRegisterLoadEmailPool) {
      setToast('无法加载邮箱池')
      return
    }
    setPoolLoading(true)
    try {
      const res = await window.lovemi.realRegisterLoadEmailPool(customPath)
      if (!res.ok) {
        setPool(null)
        setToast(res.error || '邮箱池加载失败')
        return
      }
      const accounts: ParsedImportLine[] = (res.accounts || []).map((a) => ({
        email: a.email,
        password: a.password,
        refreshToken: a.refreshToken,
        clientId: a.clientId,
        authMode: 'oauth_graph' as const,
      }))
      setPoolPath(res.path)
      setPool({
        path: res.path,
        total: res.total,
        available: res.available,
        excluded: res.excluded,
        accounts,
      })
      if (res.badLines > 0) {
        setParseErrors([`文件中有 ${res.badLines} 行格式无法解析`])
      }
    } finally {
      setPoolLoading(false)
    }
  }

  useEffect(() => {
    void (async () => {
      const p = await window.lovemi?.realRegisterDefaultEmailPoolPath?.()
      if (p) setPoolPath(p)
      await loadPool(p)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stats = useMemo(() => {
    const total = tasks.length
    const runnable = tasks.filter((t) => !t.skip).length
    const skipped = tasks.filter((t) => t.skip).length
    return { total, runnable, skipped }
  }, [tasks])

  const pickPoolFile = async () => {
    const picked = await window.lovemi?.realRegisterPickEmailPool?.()
    if (!picked?.ok || picked.canceled || !picked.path) return
    await loadPool(picked.path)
  }

  const start = async () => {
    if (!pool?.accounts.length) {
      setToast('邮箱池未就绪')
      return
    }
    if (!proxyRaw.trim()) {
      setToast('请先粘贴 IP 列表')
      return
    }
    const { tasks: workTasks, errors } = buildRealRegisterTasks(proxyRaw, pool.accounts)
    setTasks(workTasks)
    setParseErrors(errors)
    const runnable = workTasks.filter((t) => !t.skip && t.status === 'pending')
    if (!runnable.length) {
      setToast('没有可执行任务')
      return
    }
    setRunning(true)
    const taskMap = new Map(workTasks.map((t) => [t.id, { ...t }]))
    const list = workTasks.map((t) => ({ ...t }))

    const summary = await runRealRegisterQueue(
      list,
      (updated) => {
        taskMap.set(updated.id, updated)
        setTasks(Array.from(taskMap.values()).sort((a, b) => a.index - b.index))
      },
      (p) => setProgress(p),
    )

    setRunning(false)
    await loadPool(poolPath)
    setToast(`完成：成功 ${summary.ok} · 失败 ${summary.fail} · 跳过 ${summary.skipped}`)
  }

  const cancel = () => {
    cancelRealRegisterQueue()
    setRunning(false)
    setToast('已请求取消')
  }

  return (
    <section className="email-page real-register-page">
      <h1 className="page-title">
        真实账号注册 <span className="demo-pill">Demo</span>
      </h1>
      <p className="page-desc">
        只填静态住宅 IP · 经本地 Clash（7897/7890）链式转发 · 邮箱从本地池随机分配 · 注册后自动登录入库 · 并发 2
      </p>

      <div className="real-register-pool-bar">
        <div className="pool-meta">
          <span>
            邮箱池：{poolLoading ? '加载中…' : pool ? `${pool.available} 可用 / 共 ${pool.total}` : '未加载'}
          </span>
          {pool ? <span className="muted">已排除 {pool.excluded}（已用或已入库）</span> : null}
        </div>
        <div className="pool-path muted" title={poolPath}>
          {poolPath || '—'}
        </div>
        <div className="pool-actions">
          <button type="button" className="btn btn-ghost" disabled={running || poolLoading} onClick={() => void loadPool(poolPath)}>
            刷新池
          </button>
          <button type="button" className="btn btn-ghost" disabled={running} onClick={() => void pickPoolFile()}>
            换文件
          </button>
        </div>
      </div>

      <div className="field-block">
        <label className="field-label">静态住宅 IP（每行 host:port:user:pass）</label>
        <textarea
          className="field textarea-tall"
          placeholder={'纽约\n72.13.234.36:1337:user:pass\n...\n洛杉矶\n155.117.162.134:1337:user:pass'}
          value={proxyRaw}
          onChange={(e) => setProxyRaw(e.target.value)}
          disabled={running}
        />
      </div>

      {parseErrors.length ? (
        <div className="notice notice-warn">
          {parseErrors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      ) : null}

      <div className="toolbar">
        <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={running || !pool?.accounts.length}>
          {running ? '注册中…' : '开始注册'}
        </button>
        {running ? (
          <button type="button" className="btn btn-ghost" onClick={cancel}>
            取消
          </button>
        ) : null}
        <div className="stats">
          任务 {stats.total} · 可执行 {stats.runnable} · 跳过 {stats.skipped}
          {progress ? ` · 进度 ${progress.done}/${progress.total}` : ''}
        </div>
      </div>

      {tasks.length ? (
        <div className="table-wrap">
          <table className="email-table">
            <thead>
              <tr>
                <th>#</th>
                <th>地区</th>
                <th>邮箱</th>
                <th>代理</th>
                <th>出口 IP</th>
                <th>状态</th>
                <th>信息</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td>{t.index}</td>
                  <td>{t.region || '—'}</td>
                  <td>{t.email || '—'}</td>
                  <td>{t.proxyHost || '—'}</td>
                  <td>{t.egressIp || '—'}</td>
                  <td>
                    <span className={`chip chip-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                    {t.stage ? <span className="muted"> · {t.stage}</span> : null}
                  </td>
                  <td className="muted">{t.skipReason || t.error || t.parseError || (t.status === 'success' ? '已入库' : '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <strong>粘贴 IP 列表，点「开始注册」</strong>
          邮箱从本地池自动随机分配，进度在下方表格显示。
        </div>
      )}
    </section>
  )
}
