import { useEffect, useMemo, useRef, useState } from 'react'
import { runEmailPageEnter } from '../motion/timelines'
import { useEmailStore } from '../store/emailStore'

const LOCALES = ['zh', 'en', 'ja', 'ko', 'vi', 'th', 'es', 'ru', 'fil', 'fr'] as const

type Tab = 'comments' | 'names'

export function CopyLibraryPage() {
  const pageRef = useRef<HTMLElement>(null)
  const setToast = useEmailStore((s) => s.setToast)
  const [tab, setTab] = useState<Tab>('comments')
  const [locale, setLocale] = useState<string>('zh')
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [stats, setStats] = useState<
    Record<string, { comments: number; names: number; namesFree: number }>
  >({})
  const [comments, setComments] = useState<Array<{ id: string; body: string; use_count: number }>>([])
  const [names, setNames] = useState<
    Array<{ id: string; name: string; used_by_account_id: string | null }>
  >([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!pageRef.current) return
    runEmailPageEnter(pageRef.current)
  }, [tab, locale])

  const refresh = async () => {
    setLoading(true)
    try {
      await window.lovemi?.consoleEnsureSeed?.()
      const st = await window.lovemi?.consoleCopyStats?.()
      if (st) {
        setLabels(st.labels || {})
        setStats(st.byLocale || {})
      }
      if (tab === 'comments') {
        const rows = (await window.lovemi?.consoleListComments?.(locale)) || []
        setComments(rows.map((r) => ({ id: r.id, body: r.body, use_count: r.use_count })))
      } else {
        const rows = (await window.lovemi?.consoleListNames?.({ locale })) || []
        setNames(
          rows.map((r) => ({
            id: r.id,
            name: r.name,
            used_by_account_id: r.used_by_account_id,
          })),
        )
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, locale])

  const localeStat = stats[locale]
  const summary = useMemo(() => {
    const totalC = Object.values(stats).reduce((s, v) => s + (v?.comments || 0), 0)
    const totalN = Object.values(stats).reduce((s, v) => s + (v?.names || 0), 0)
    return { totalC, totalN }
  }, [stats])

  const onAdd = async () => {
    if (!draft.trim()) return
    if (tab === 'comments') {
      const r = await window.lovemi?.consoleAddComment?.({ locale, body: draft.trim() })
      if (!r?.ok) {
        setToast(r?.error || '添加失败')
        return
      }
    } else {
      const r = await window.lovemi?.consoleAddName?.({ locale, name: draft.trim() })
      if (!r?.ok) {
        setToast(r?.error || '用户名重复或失败')
        return
      }
    }
    setDraft('')
    setToast('已添加')
    void refresh()
  }

  return (
    <section className="email-page" ref={pageRef}>
      <h1 className="page-title">文案库</h1>
      <p className="page-desc">
        10 语评论 + 网名各约 100 条 · 总计评论 {summary.totalC} · 用户名 {summary.totalN} ·
        带欲望感夸奖口语 · 用户名全局去重
      </p>

      <div className="toolbar" data-motion="toolbar">
        <button
          type="button"
          className={`btn ${tab === 'comments' ? 'btn-primary' : ''}`}
          onClick={() => setTab('comments')}
        >
          评论库
        </button>
        <button
          type="button"
          className={`btn ${tab === 'names' ? 'btn-primary' : ''}`}
          onClick={() => setTab('names')}
        >
          用户名库
        </button>
        <select className="select" value={locale} onChange={(e) => setLocale(e.target.value)}>
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {labels[l] || l}
              {stats[l] ? ` (${tab === 'comments' ? stats[l].comments : stats[l].names})` : ''}
            </option>
          ))}
        </select>
        <button type="button" className="btn" disabled={loading} onClick={() => void refresh()}>
          刷新
        </button>
        <div className="stats">
          {localeStat
            ? `${labels[locale] || locale} · 评论 ${localeStat.comments} · 名 ${localeStat.names}（空闲 ${localeStat.namesFree}）`
            : '—'}
        </div>
      </div>

      <div className="security-compose" data-motion="toolbar">
        <textarea
          className="security-textarea"
          rows={2}
          placeholder={tab === 'comments' ? '追加一条夸奖评论…' : '追加一个网名…'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="security-compose-row">
          <button type="button" className="btn btn-primary" onClick={() => void onAdd()}>
            添加到 {labels[locale] || locale}
          </button>
        </div>
      </div>

      <div className="security-list" data-motion="card">
        {tab === 'comments'
          ? comments.map((c) => (
              <div key={c.id} className="security-card">
                <div className="security-card-head">
                  <span className="chip">用过 {c.use_count}</span>
                </div>
                <div>{c.body}</div>
              </div>
            ))
          : names.map((n) => (
              <div key={n.id} className="security-card">
                <div className="security-card-head">
                  <strong>{n.name}</strong>
                  <span className={`chip${n.used_by_account_id ? ' pink' : ''}`}>
                    {n.used_by_account_id ? '已占用' : '空闲'}
                  </span>
                </div>
              </div>
            ))}
        {!loading && (tab === 'comments' ? comments : names).length === 0 ? (
          <div className="empty">该语言暂无条目</div>
        ) : null}
      </div>
    </section>
  )
}
