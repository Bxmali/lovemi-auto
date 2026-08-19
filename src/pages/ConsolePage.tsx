import { useEffect, useRef, useState, memo, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
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
  const parentRef = useRef<HTMLDivElement>(null)
  const accounts = useEmailStore((s) => s.accounts)
  const setToast = useEmailStore((s) => s.setToast)
  const autoEngage = useConsoleStore((s) => s.autoEngage)
  const setAutoEngage = useConsoleStore((s) => s.setAutoEngage)
  const discovering = useConsoleStore((s) => s.discovering)
  const setDiscovering = useConsoleStore((s) => s.setDiscovering)
  const engaging = useConsoleStore((s) => s.engaging)
  const renaming = useConsoleStore((s) => s.renaming)
  const setRenaming = useConsoleStore((s) => s.setRenaming)
  const logs = useConsoleStore((s) => s.logs)
  const stats = useConsoleStore((s) => s.stats)
  const failStreak = useConsoleStore((s) => s.failStreak)
  const gapMinMs = useConsoleStore((s) => s.gapMinMs)
  const gapMaxMs = useConsoleStore((s) => s.gapMaxMs)
  const engageConcurrency = useConsoleStore((s) => s.engageConcurrency)
  const discoverEveryMs = useConsoleStore((s) => s.discoverEveryMs)
  const refreshLogs = useConsoleStore((s) => s.refreshLogs)
  const refreshStats = useConsoleStore((s) => s.refreshStats)
  const clearLogs = useConsoleStore((s) => s.clearLogs)
  const [followTail, setFollowTail] = useState(true)
  const [stepBusy, setStepBusy] = useState(false)

  const withBearer = accounts.filter(
    (a) => !a.id.startsWith('demo-') && !a.email.endsWith('@example.com') && a.lovemiSessionToken,
  )
  const profileReady = withBearer.filter((a) => a.lovemiProfileReady).length

  const virtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 12,
  })

  useEffect(() => {
    if (!pageRef.current) return
    runEmailPageEnter(pageRef.current)
  }, [])

  useEffect(() => {
    void refreshLogs()
    void refreshStats()
    // 日志 5s、统计 12s，减轻 IPC + 重绘
    const logTimer = window.setInterval(() => void refreshLogs(), 5_000)
    const statsTimer = window.setInterval(() => void refreshStats(), 12_000)
    return () => {
      window.clearInterval(logTimer)
      window.clearInterval(statsTimer)
    }
  }, [refreshLogs, refreshStats])

  useEffect(() => {
    if (!followTail || !logs.length) return
    const el = parentRef.current
    if (!el) return
    // 仅贴底，不用 smooth（高频日志会卡）
    el.scrollTop = 0
  }, [logs[0]?.id, followTail, logs.length])

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

  const onScroll = useCallback(() => {
    const el = parentRef.current
    if (!el) return
    // 列表最新在顶：离开顶部则取消跟随
    if (el.scrollTop > 48 && followTail) setFollowTail(false)
  }, [followTail])

  const today = stats?.today

  return (
    <section className="email-page" ref={pageRef}>
      <h1 className="page-title">控制台</h1>
      <p className="page-desc">
        发现并行多页 → 50–80% 抽样（<strong>J哥 / Big D 70–80%</strong>）→ 点赞 →{' '}
        <strong>评论强制随机换号</strong> · <strong>{engageConcurrency} 路并发</strong> · 间隔{' '}
        {Math.round(gapMinMs / 100) / 10}–{Math.round(gapMaxMs / 100) / 10}s · 发现每{' '}
        {Math.round(discoverEveryMs / 60000)} 分钟 · 退出即停 ·
        Bearer {withBearer.length} · 已改名 {profileReady}
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
        <label className="chip" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={followTail}
            onChange={(e) => setFollowTail(e.target.checked)}
            style={{ marginRight: 6 }}
          />
          跟随最新
        </label>
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

      <div className="settings-card" data-motion="card" style={{ marginTop: 12 }}>
        <div className="settings-card-head">实时日志（虚拟列表 · 最近 {logs.length} 条）</div>
        <div
          ref={parentRef}
          className="console-log"
          onScroll={onScroll}
          style={{
            maxHeight: 420,
            overflow: 'auto',
            fontFamily: 'ui-monospace, monospace',
            fontSize: '0.75rem',
            lineHeight: 1.45,
            position: 'relative',
          }}
        >
          {logs.length === 0 ? (
            <div className="empty" style={{ padding: 24 }}>
              暂无日志 · 开启自动互动或点「立即发现 / 手动互动 1 步」
            </div>
          ) : (
            <div
              style={{
                height: virtualizer.getTotalSize(),
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((vRow) => {
                const row = logs[vRow.index]
                if (!row) return null
                return (
                  <div
                    key={row.id}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vRow.start}px)`,
                    }}
                  >
                    <LogRow row={row} />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
