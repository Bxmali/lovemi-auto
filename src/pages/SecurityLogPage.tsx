import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useSecurityLogStore,
  type LogSeverity,
} from '../store/securityLogStore'
import { runEmailPageEnter } from '../motion/timelines'

const SEVERITY_LABEL: Record<LogSeverity, string> = {
  info: '提示',
  low: '低',
  medium: '中',
  high: '高',
}

export function SecurityLogPage() {
  const pageRef = useRef<HTMLElement>(null)
  const hydrate = useSecurityLogStore((s) => s.hydrate)
  const entries = useSecurityLogStore((s) => s.entries)
  const addHuman = useSecurityLogStore((s) => s.addHuman)
  const remove = useSecurityLogStore((s) => s.remove)
  const resetAiSeed = useSecurityLogStore((s) => s.resetAiSeed)

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [severity, setSeverity] = useState<LogSeverity>('medium')
  const [tags, setTags] = useState('')
  const [filter, setFilter] = useState<'all' | 'ai' | 'human'>('all')

  useEffect(() => {
    hydrate()
  }, [hydrate])

  useEffect(() => {
    if (!pageRef.current) return
    runEmailPageEnter(pageRef.current)
  }, [entries.length])

  const list = useMemo(() => {
    if (filter === 'all') return entries
    return entries.filter((e) => e.source === filter)
  }, [entries, filter])

  const onAdd = () => {
    if (!title.trim() || !body.trim()) return
    addHuman({
      title,
      body,
      severity,
      tags: tags
        .split(/[,，\s]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    })
    setTitle('')
    setBody('')
    setTags('')
  }

  return (
    <section className="email-page" ref={pageRef}>
      <h1 className="page-title">安全日志</h1>
      <p className="page-desc">
        整理自动化注册/探活中的风险点 · AI 预置可重置 · 人工可追加
      </p>

      <div className="toolbar" data-motion="toolbar">
        <select
          className="select"
          value={filter}
          onChange={(e) => setFilter(e.target.value as 'all' | 'ai' | 'human')}
        >
          <option value="all">全部来源</option>
          <option value="ai">仅 AI</option>
          <option value="human">仅人工</option>
        </select>
        <button type="button" className="btn" onClick={() => resetAiSeed()}>
          重置 AI 条目
        </button>
        <div className="stats">共 {list.length} 条</div>
      </div>

      <div className="security-compose" data-motion="toolbar">
        <h3>人工追加</h3>
        <input
          className="field"
          placeholder="标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="security-textarea"
          placeholder="风险说明、复现条件、缓解建议…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
        />
        <div className="security-compose-row">
          <select
            className="select"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as LogSeverity)}
          >
            {(Object.keys(SEVERITY_LABEL) as LogSeverity[]).map((s) => (
              <option key={s} value={s}>
                严重度 · {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
          <input
            className="field"
            placeholder="标签，逗号分隔"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
          <button type="button" className="btn btn-primary" onClick={onAdd}>
            添加
          </button>
        </div>
      </div>

      <div className="security-list">
        {list.length === 0 ? (
          <div className="empty">
            <strong>暂无日志</strong>
            可重置 AI 条目，或在上方人工追加。
          </div>
        ) : (
          list.map((e) => (
            <article key={e.id} className="security-card" data-motion="card">
              <header className="security-card-head">
                <div className="meta-row">
                  <span className={`chip severity-${e.severity}`}>
                    {SEVERITY_LABEL[e.severity]}
                  </span>
                  <span className={`chip${e.source === 'ai' ? ' pink' : ''}`}>
                    {e.source === 'ai' ? 'AI' : '人工'}
                  </span>
                  {e.tags.map((t) => (
                    <span key={t} className="chip">
                      {t}
                    </span>
                  ))}
                </div>
                <button type="button" className="btn btn-ghost" onClick={() => remove(e.id)}>
                  删除
                </button>
              </header>
              <h2>{e.title}</h2>
              <p>{e.body}</p>
              <time>{new Date(e.createdAt).toLocaleString()}</time>
            </article>
          ))
        )}
      </div>
    </section>
  )
}
