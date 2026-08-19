import { useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { parseAccountLines, maskSecret } from '../lib/parseAccounts'
import { filterAccounts, useEmailStore } from '../store/emailStore'
import { resolveOutboundProxy, useSettingsStore } from '../store/settingsStore'
import { runEmailPageEnter, pulseCodeReveal, prefersReducedMotion } from '../motion/timelines'
import { runAutoProbe } from '../services/autoProbe'
import { reloadAccountsFromDisk } from '../services/reloadAccounts'
import type { AccountStatus, EmailAccount } from '../types/email'

const STATUS_LABEL: Record<AccountStatus, string> = {
  idle: '空闲',
  ready: '可用',
  cooling: '检测中',
  error: '异常',
  disabled: '停用',
}

const AUTH_LABEL = {
  password: '密码',
  oauth_graph: 'Graph OAuth',
  imap: 'IMAP',
} as const

function StatusChip({ status }: { status: AccountStatus }) {
  return (
    <span className="chip">
      <i className={`status-dot ${status}`} />
      {STATUS_LABEL[status]}
    </span>
  )
}

function LovemiRegChip({ account }: { account: EmailAccount }) {
  const registered = Boolean(account.lovemiRegistered || account.lovemiRegStatus === 'registered')
  const failed = account.lovemiRegStatus === 'failed'
  const registering = account.lovemiRegStatus === 'registering'
  const label = registered ? '已注册 Lovemi' : failed ? 'Lovemi 失败' : registering ? 'Lovemi 注册中' : '未注册 Lovemi'
  return (
    <span className={`chip${registered ? ' pink' : ''}`}>
      <i
        className={`status-dot ${registered ? 'ready' : failed ? 'error' : registering ? 'cooling' : 'idle'}`}
      />
      {label}
    </span>
  )
}

function ImportModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const importRows = useEmailStore((s) => s.importRows)
  const setToast = useEmailStore((s) => s.setToast)
  const [raw, setRaw] = useState('')
  const [msg, setMsg] = useState('')

  if (!open) return null

  const onSubmit = () => {
    const { accounts, errors } = parseAccountLines(raw)
    if (!accounts.length) {
      setMsg(errors[0] || '没有可导入的行')
      return
    }
    const { count, ids } = importRows(accounts)
    const text = `已导入 ${count} 个账号${errors.length ? `，跳过 ${errors.length} 行` : ''}，开始探活并自动注册 Lovemi…`
    setMsg(text)
    setToast(text)
    if (count > 0) {
      void runAutoProbe(ids)
      setTimeout(() => {
        onClose()
        setRaw('')
        setMsg('')
      }, 400)
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>导入账号</h2>
        <p>
          每行一条，支持 <code>邮箱:密码</code> 或{' '}
          <code>邮箱:密码:刷新令牌:客户端ID</code>。密钥仅保存在本机加密存储，不会上传。
        </p>
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={'user@example.com:password\nuser2@example.com:pass:refresh_token:client-id'}
          spellCheck={false}
        />
        {msg ? <p>{msg}</p> : null}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={onSubmit}>
            导入
          </button>
        </div>
      </div>
    </div>
  )
}

function DetailDrawer({
  account,
  onClose,
}: {
  account: EmailAccount | null
  onClose: () => void
}) {
  const setStatus = useEmailStore((s) => s.setStatus)
  const remove = useEmailStore((s) => s.remove)
  const codeRef = useRef<HTMLDivElement>(null)
  const [code, setCode] = useState<string | null>(null)

  useEffect(() => {
    if (!account || prefersReducedMotion()) return
    const el = document.querySelector('.drawer') as HTMLElement | null
    if (!el) return
    gsap.fromTo(el, { x: 36, opacity: 0.6 }, { x: 0, opacity: 1, duration: 0.35, ease: 'power3.out' })
  }, [account?.id])

  if (!account) return null

  const simulateCode = () => {
    // 仅 UI 演示：本地随机数，不代表邮箱真实可用，不改健康状态
    const next = String(Math.floor(100000 + Math.random() * 900000))
    setCode(next)
    requestAnimationFrame(() => {
      if (codeRef.current) pulseCodeReveal(codeRef.current)
    })
  }

  return (
    <>
      <div
        className="drawer-mask"
        role="presentation"
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      />
      <aside className="drawer" tabIndex={-1}>
        <h2>{account.email}</h2>
        <div className="meta-row" style={{ marginTop: 8 }}>
          <StatusChip status={account.status} />
          <LovemiRegChip account={account} />
        </div>
        {account.lastError ? (
          <p style={{ color: 'var(--danger)', fontSize: '0.82rem', margin: '8px 0 0', lineHeight: 1.4 }}>
            检测失败：{account.lastError}
          </p>
        ) : null}
        {account.status === 'ready' && account.lastOkAt ? (
          <p style={{ color: 'var(--ok)', fontSize: '0.82rem', margin: '8px 0 0' }}>
            Graph 探活通过
          </p>
        ) : null}

        <div className="section">
          <h3>凭证</h3>
          <dl className="kv">
            <dt>协议</dt>
            <dd>{AUTH_LABEL[account.authMode]}</dd>
            <dt>密码</dt>
            <dd>{maskSecret(account.password)}</dd>
            <dt>刷新令牌</dt>
            <dd>{maskSecret(account.refreshToken)}</dd>
            <dt>客户端 ID</dt>
            <dd>{maskSecret(account.clientId)}</dd>
            <dt>Lovemi Bearer</dt>
            <dd>{maskSecret(account.lovemiSessionToken)}</dd>
          </dl>
        </div>

        <div className="section">
          <h3>验证码</h3>
          <div className="code-box" ref={codeRef}>
            {(code ?? '······').split('').map((d, i) => (
              <span key={`${d}-${i}`} data-digit>
                {d}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={simulateCode}>
              模拟取码（仅演示）
            </button>
            <button
              type="button"
              className="btn"
              disabled={!code}
              onClick={() => code && navigator.clipboard.writeText(code)}
            >
              复制
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void runAutoProbe([account.id])}
            >
              重新检测
            </button>
          </div>
          <p style={{ color: 'var(--muted)', fontSize: '0.82rem', marginTop: 10 }}>
            「可用 / 异常」来自微软 Graph 真实探活。详情里可单号重测；库存同步与空闲探活已自动化。
          </p>
        </div>

        <div className="section" style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn" onClick={() => setStatus(account.id, 'ready')}>
            标为可用
          </button>
          <button type="button" className="btn" onClick={() => setStatus(account.id, 'disabled')}>
            停用
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              remove([account.id])
              onClose()
            }}
          >
            删除
          </button>
        </div>
      </aside>
    </>
  )
}

export function EmailHub() {
  const pageRef = useRef<HTMLElement>(null)
  const [importOpen, setImportOpen] = useState(false)
  const store = useEmailStore()
  const settings = useSettingsStore()
  const outbound = resolveOutboundProxy(settings)
  const list = useMemo(() => filterAccounts(store), [store.accounts, store.query, store.statusFilter])
  const selected = store.accounts.find((a) => a.id === store.selectedId) ?? null

  useEffect(() => {
    if (!pageRef.current) return
    runEmailPageEnter(pageRef.current)
  }, [store.accounts.length, store.view])

  useEffect(() => {
    void reloadAccountsFromDisk({ silent: true })
  }, [])

  return (
    <section className="email-page" ref={pageRef}>
      <h1 className="page-title">邮箱管理</h1>
      <p className="page-desc">
        导入后自动探活并排队注册 · 出站：{outbound.label}
        {store.probing ? ' · 探活中' : ''}
        {store.registering ? ' · 注册队列运行中' : ''}
      </p>

      <div className="toolbar" data-motion="toolbar">
        <input
          className="field"
          placeholder="搜索邮箱 / 标签 / 备注"
          value={store.query}
          onChange={(e) => store.setQuery(e.target.value)}
        />
        <select
          className="select"
          value={store.statusFilter}
          onChange={(e) => store.setStatusFilter(e.target.value as AccountStatus | 'all')}
        >
          <option value="all">全部状态</option>
          {(Object.keys(STATUS_LABEL) as AccountStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          onClick={() => store.setView(store.view === 'cards' ? 'table' : 'cards')}
        >
          {store.view === 'cards' ? '表格视图' : '卡片视图'}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => setImportOpen(true)}>
          导入账号
        </button>
        <div className="stats">
          显示 {list.length} / 共 {store.accounts.length}
        </div>
      </div>

      {store.view === 'cards' ? (
        <div className="card-grid">
          {list.length === 0 ? (
            <div className="empty">
              <strong>还没有账号</strong>
              点击「导入账号」粘贴你自有测试邮箱，导入后会自动探活并串行注册 Lovemi。
            </div>
          ) : (
            list.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`email-card${selected?.id === a.id ? ' selected' : ''}`}
                data-motion="card"
                onClick={() => store.select(a.id)}
              >
                <div className="email-addr">{a.email}</div>
                <div className="meta-row">
                  <StatusChip status={a.status} />
                  <LovemiRegChip account={a} />
                  <span className="chip pink">{AUTH_LABEL[a.authMode]}</span>
                  {a.labels
                    .filter((l) => !/^lovemi(-reg)?$/i.test(l))
                    .map((l) => (
                      <span key={l} className="chip">
                        {l}
                      </span>
                    ))}
                </div>
                {a.lastError ? (
                  <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--muted)', lineHeight: 1.35 }}>
                    {a.lastError.slice(0, 80)}
                  </div>
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="email-table">
            <thead>
              <tr>
                <th>邮箱</th>
                <th>状态</th>
                <th>Lovemi</th>
                <th>协议</th>
                <th>标签</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id} onClick={() => store.select(a.id)}>
                  <td>{a.email}</td>
                  <td>
                    <StatusChip status={a.status} />
                  </td>
                  <td>
                    <LovemiRegChip account={a} />
                  </td>
                  <td>{AUTH_LABEL[a.authMode]}</td>
                  <td>
                    {a.labels.filter((l) => !/^lovemi(-reg)?$/i.test(l)).join(', ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <DetailDrawer account={selected} onClose={() => store.select(null)} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </section>
  )
}
