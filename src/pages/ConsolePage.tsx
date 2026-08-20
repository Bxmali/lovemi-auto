import { useEffect, useRef, useState, memo, useMemo } from 'react'
import { useConsoleStore, type ConsoleLogRow } from '../store/consoleStore'
import { useEmailStore } from '../store/emailStore'
import { assignLocalesAndRename } from '../services/profileLocale'
import { runDiscoverPass } from '../services/discovery'
import { kickEngageLoop, engageOneStep } from '../services/engage'
import { runEmailPageEnter } from '../motion/timelines'

const LogRow = memo(function LogRow({ row }: { row: ConsoleLogRow }) {
  const who = row.account_email
    ? row.account_email.includes('@')
      ? row.account_email.split('@')[0]
      : row.account_email
    : ''
  return (
    <div
      style={{
        padding: '6px 8px',
        borderBottom: '1px solid var(--line)',
        color:
          row.level === 'error' ? 'var(--danger)' : row.level === 'warn' ? 'var(--warn)' : 'var(--text)',
      }}
    >
      <span style={{ color: 'var(--muted)' }}>{new Date(row.ts).toLocaleTimeString()}</span>
      {' · '}
      <span className="chip" style={{ display: 'inline' }}>
        {row.action}
      </span>
      {who ? ` · ${who}` : ''}
      {' — '}
      {row.message}
    </div>
  )
})

export function ConsolePage() {
  const pageRef = useRef<HTMLElement>(null)
  const bearerReady = useEmailStore((s) => {
    let bearer = 0
    let ready = 0
    for (const a of s.accounts) {
      if (a.id.startsWith('demo-') || a.email.endsWith('@example.com') || !a.lovemiSessionToken) continue
      bearer++
      if (a.lovemiProfileReady) ready++
    }
    return `${bearer}:${ready}`
  })
  const [withBearer, profileReady] = bearerReady.split(':').map(Number)
  const setToast = useEmailStore((s) => s.setToast)
  const autoEngage = useConsoleStore((s) => s.autoEngage)
  const setAutoEngage = useConsoleStore((s) => s.setAutoEngage)
  const discovering = useConsoleStore((s) => s.discovering)
  const setDiscovering = useConsoleStore((s) => s.setDiscovering)
  const engaging = useConsoleStore((s) => s.engaging)
  const renaming = useConsoleStore((s) => s.renaming)
  const setRenaming = useConsoleStore((s) => s.setRenaming)
  const allLogs = useConsoleStore((s) => s.logs)
  // 拉人/互动控制台只显示互动相关日志；创建角色有自己的三槽步骤日志。
  const logs = useMemo(
    () => allLogs.filter((row) => row.action !== 'create_char').slice(0, 20),
    [allLogs],
  )
  const stats = useConsoleStore((s) => s.stats)
  const failStreak = useConsoleStore((s) => s.failStreak)
  const gapMinMs = useConsoleStore((s) => s.gapMinMs)
  const gapMaxMs = useConsoleStore((s) => s.gapMaxMs)
  const engageConcurrency = useConsoleStore((s) => s.engageConcurrency)
  const discoverEveryMs = useConsoleStore((s) => s.discoverEveryMs)
  const refreshLogs = useConsoleStore((s) => s.refreshLogs)
  const refreshStats = useConsoleStore((s) => s.refreshStats)
  const clearLogs = useConsoleStore((s) => s.clearLogs)
  const [stepBusy, setStepBusy] = useState(false)

  useEffect(() => {
    if (!pageRef.current) return
    runEmailPageEnter(pageRef.current)
  }, [])

  useEffect(() => {
    void refreshLogs()
    void refreshStats()
    // 日志 8s、统计 15s；互动循环另有 2s 节流刷新
    const logTimer = window.setInterval(() => void refreshLogs(), 8_000)
    const statsTimer = window.setInterval(() => void refreshStats(), 15_000)
    return () => {
      window.clearInterval(logTimer)
      window.clearInterval(statsTimer)
    }
  }, [refreshLogs, refreshStats])

  useEffect(() => {
    if (!autoEngage) return
    let cancelled = false
    const discoverTick = async () => {
      if (cancelled || useConsoleStore.getState().discovering) return
      setDiscovering(true)
      try {
        const pass = runDiscoverPass({ pages: 10 })
        const timed = Promise.race([
          pass,
          new Promise<null>((resolve) => {
            window.setTimeout(() => resolve(null), 120_000)
          }),
        ])
        const res = await timed
        if (res === null) {
          setToast('发现超时（代理可能挂了），已解除卡住')
          await window.lovemi?.consoleLog?.({
            level: 'error',
            action: 'discover',
            message: '发现超时 120s · 请检查本地兜底端口',
          })
          useConsoleStore.getState().bumpFailStreak()
        } else if (res && !res.ok) {
          useConsoleStore.getState().bumpFailStreak()
        } else if (res?.ok) {
          useConsoleStore.getState().resetFailStreak()
        }
        await refreshLogs()
        await refreshStats()
      } catch (e) {
        setToast(`发现异常：${e instanceof Error ? e.message : String(e)}`)
        useConsoleStore.getState().bumpFailStreak()
      } finally {
        setDiscovering(false)
      }
    }
    void discoverTick()
    kickEngageLoop()
    const t = window.setInterval(() => void discoverTick(), discoverEveryMs)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [autoEngage, setDiscovering, refreshLogs, refreshStats, discoverEveryMs, setToast])

  useEffect(() => {
    if (autoEngage) kickEngageLoop()
  }, [autoEngage])

  const onRename = async () => {
    setRenaming(true)
    try {
      await assignLocalesAndRename({ onlyMissing: true })
      await refreshLogs()
    } finally {
      setRenaming(false)
    }
  }

  const onDiscover = async () => {
    setDiscovering(true)
    try {
      await runDiscoverPass({ pages: 10 })
      await refreshLogs()
      await refreshStats()
    } finally {
      setDiscovering(false)
    }
  }

  const onOneStep = async () => {
    setStepBusy(true)
    try {
      await engageOneStep()
      await refreshLogs()
      await refreshStats()
    } finally {
      setStepBusy(false)
    }
  }

  const today = stats?.today

  return (
    <section className="email-page" ref={pageRef}>
      <h1 className="page-title">控制台</h1>
      <p className="page-desc">
        发现并行多页 → 新发布赞~80%/评~55% · 热门赞~55%/评~36%（带噪声）→{' '}
        <strong>J哥 / Big D 赞 100% · 评 ~70%</strong> → 点赞后{' '}
        <strong>评论强制随机换号</strong> · <strong>{engageConcurrency} 路并发</strong> · 间隔{' '}
        {Math.round(gapMinMs / 100) / 10}–{Math.round(gapMaxMs / 100) / 10}s · 发现每{' '}
        {Math.round(discoverEveryMs / 60000)} 分钟 · 退出即停 ·
        Bearer {withBearer} · 已改名 {profileReady}
        {engaging ? ' · 互动中' : ''}
        {failStreak > 0 ? ` · 连续失败 ${failStreak}` : ''}
      </p>

      <div className="toolbar" data-motion="toolbar">
        <button
          type="button"
          className={`btn ${autoEngage ? 'btn-primary' : ''}`}
          onClick={() => {
            const next = !autoEngage
            setAutoEngage(next)
            if (next) {
              void window.lovemi?.consoleLog?.({
                level: 'info',
                action: 'auto',
                message: '自动互动已开启',
              })
            }
          }}
        >
          自动互动 {autoEngage ? 'ON' : 'OFF'}
        </button>
        <button type="button" className="btn" disabled={renaming} onClick={() => void onRename()}>
          {renaming ? '改名中…' : '语言均分 + 改名'}
        </button>
        <button type="button" className="btn" disabled={discovering} onClick={() => void onDiscover()}>
          {discovering ? '发现中…' : '立即发现（角色+Explore 各10页）'}
        </button>
        <button type="button" className="btn" disabled={stepBusy || engaging} onClick={() => void onOneStep()}>
          {stepBusy ? '执行中…' : '手动互动 1 步'}
        </button>
        <button type="button" className="btn" onClick={() => void clearLogs()}>
          清空日志
        </button>
      </div>

      <div
        className="card-grid"
        data-motion="toolbar"
        style={{ marginTop: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}
      >
        <div className="settings-card">
          <div className="settings-hint">角色</div>
          <strong style={{ fontSize: '1.25rem' }}>{stats?.characters ?? '—'}</strong>
        </div>
        <div className="settings-card">
          <div className="settings-hint">pending</div>
          <strong style={{ fontSize: '1.25rem' }}>{stats?.pending ?? '—'}</strong>
        </div>
        <div className="settings-card">
          <div className="settings-hint">已互动</div>
          <strong style={{ fontSize: '1.25rem' }}>{stats?.engaged ?? '—'}</strong>
        </div>
        <div className="settings-card">
          <div className="settings-hint">跳过</div>
          <strong style={{ fontSize: '1.25rem' }}>{stats?.skipped ?? '—'}</strong>
        </div>
        <div className="settings-card">
          <div className="settings-hint">今日赞</div>
          <strong style={{ fontSize: '1.25rem' }}>{today?.liked ?? '—'}</strong>
        </div>
        <div className="settings-card">
          <div className="settings-hint">今日评</div>
          <strong style={{ fontSize: '1.25rem' }}>{today?.commented ?? '—'}</strong>
        </div>
        <div className="settings-card">
          <div className="settings-hint">今日跳过</div>
          <strong style={{ fontSize: '1.25rem' }}>{today?.skipped ?? '—'}</strong>
        </div>
        <div className="settings-card">
          <div className="settings-hint">失败/放弃</div>
          <strong style={{ fontSize: '1.25rem' }}>{stats?.failed ?? '—'}</strong>
        </div>
      </div>

      <div className="settings-card" style={{ marginTop: 12 }}>
        <div className="settings-card-head">实时日志（最新 {logs.length} 条）</div>
        <div
          className="console-log"
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: '0.75rem',
            lineHeight: 1.45,
          }}
        >
          {logs.length === 0 ? (
            <div className="empty" style={{ padding: 24 }}>
              暂无日志 · 开启自动互动或点「立即发现 / 手动互动 1 步」
            </div>
          ) : (
            logs.map((row) => <LogRow key={row.id} row={row} />)
          )}
        </div>
      </div>
    </section>
  )
}
