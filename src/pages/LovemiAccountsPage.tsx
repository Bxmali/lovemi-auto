import { useMemo, useRef, useEffect, useState, memo } from 'react'
import { useEmailStore } from '../store/emailStore'
import { resolveOutboundProxy, useSettingsStore } from '../store/settingsStore'
import { enqueueLovemiRegister, getRegisterQueueLength } from '../services/lovemiRegister'
import { enqueueLovemiLogin, enqueueLoginMissingTokens } from '../services/lovemiLogin'
import { enqueueLovemiPasswordReset, enqueueResetMissingPasswords } from '../services/lovemiPasswordReset'
import { assignLocalesAndRename } from '../services/profileLocale'
import { runEmailPageEnter } from '../motion/timelines'
import type { EmailAccount, LovemiRegStatus } from '../types/email'
import { maskSecret } from '../lib/parseAccounts'
import { localeLabel } from '../lib/locales'
import { VirtualAccountGrid } from '../components/VirtualAccountGrid'

const REG_LABEL: Record<LovemiRegStatus, string> = {
  none: '未注册',
  registering: '注册中',
  registered: '已注册',
  failed: '失败',
}

function LovemiChip({ account }: { account: EmailAccount }) {
  const status: LovemiRegStatus =
    account.lovemiRegStatus || (account.lovemiRegistered ? 'registered' : 'none')
  return (
    <span className={`chip${status === 'registered' ? ' pink' : ''}`}>
      <i
        className={`status-dot ${status === 'registered' ? 'ready' : status === 'failed' ? 'error' : status === 'registering' ? 'cooling' : 'idle'}`}
      />
      Lovemi · {REG_LABEL[status]}
    </span>
  )
}

function BearerChip({ account }: { account: EmailAccount }) {
  const has = Boolean(account.lovemiSessionToken)
  return (
    <span className={`chip${has ? ' pink' : ''}`}>
      <i className={`status-dot ${has ? 'ready' : 'idle'}`} />
      {has ? '已获取 Bearer' : '未获取 Bearer'}
    </span>
  )
}

/** 语言标签（独立） */
function LocaleChip({ account }: { account: EmailAccount }) {
  const has = Boolean(account.lovemiLocale)
  return (
    <span className={`chip${has ? ' pink' : ''}`}>
      <i className={`status-dot ${has ? 'ready' : 'idle'}`} />
      {has ? localeLabel(account.lovemiLocale) : '未分配语言'}
    </span>
  )
}

/** 已创建 / 未创建用户名 */
function DisplayNameChip({ account }: { account: EmailAccount }) {
  const ready =
    Boolean(account.lovemiProfileReady && account.lovemiDisplayName) &&
    !/\d/.test(account.lovemiDisplayName || '')
  return (
    <span className={`chip${ready ? ' pink' : ''}`}>
      <i className={`status-dot ${ready ? 'ready' : 'idle'}`} />
      {ready ? `已创建用户名 · ${account.lovemiDisplayName}` : '未创建用户名'}
    </span>
  )
}

const LovemiCard = memo(function LovemiCard({
  account,
  selected,
  onSelect,
}: {
  account: EmailAccount
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      className={`email-card${selected ? ' selected' : ''}`}
      onClick={() => onSelect(account.id)}
    >
      <div className="email-addr">{account.email}</div>
      <div className="meta-row">
        <LovemiChip account={account} />
        <BearerChip account={account} />
        <LocaleChip account={account} />
        <DisplayNameChip account={account} />
      </div>
      {account.lovemiRegError ? (
        <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--danger)', lineHeight: 1.35 }}>
          {account.lovemiRegError.slice(0, 120)}
        </div>
      ) : null}
    </button>
  )
})

export function LovemiAccountsPage() {
  const pageRef = useRef<HTMLElement>(null)
  const accounts = useEmailStore((s) => s.accounts)
  const selectedId = useEmailStore((s) => s.selectedId)
  const select = useEmailStore((s) => s.select)
  const registering = useEmailStore((s) => s.registering)
  const setLovemiStatus = useEmailStore((s) => s.setLovemiStatus)
  const settings = useSettingsStore()
  const outbound = resolveOutboundProxy(settings)
  const [view, setView] = useState<'cards' | 'table'>('cards')

  const list = useMemo(
    () => accounts.filter((a) => !a.id.startsWith('demo-') && !a.email.endsWith('@example.com')),
    [accounts],
  )
  const selected = selectedId ? (list.find((a) => a.id === selectedId) ?? null) : null
  const unregistered = useMemo(() => list.filter((a) => !a.lovemiRegistered).length, [list])
  const registered = useMemo(() => list.filter((a) => a.lovemiRegistered).length, [list])
  const queued = getRegisterQueueLength()
  const named = useMemo(
    () =>
      list.filter(
        (a) => a.lovemiProfileReady && a.lovemiDisplayName && !/\d/.test(a.lovemiDisplayName),
      ).length,
    [list],
  )
  const bearerN = useMemo(() => list.filter((a) => a.lovemiSessionToken).length, [list])

  useEffect(() => {
    if (!pageRef.current) return
    runEmailPageEnter(pageRef.current)
  }, [])

  return (
    <section className="email-page" ref={pageRef}>
      <h1 className="page-title">Lovemi 账号管理</h1>
      <p className="page-desc">
        串行注册队列（限流自动等待）· {outbound.label} · 未注册 {unregistered} / 已注册 {registered}
        {registering || queued > 0 ? ` · 队列 ${queued}` : ''}
      </p>

      <div className="toolbar" data-motion="toolbar">
        <button
          type="button"
          className="btn btn-primary"
          disabled={registering}
          onClick={() => enqueueResetMissingPasswords()}
        >
          重置站内密码
        </button>
        <button
          type="button"
          className="btn"
          disabled={registering}
          onClick={() => enqueueLoginMissingTokens()}
        >
          登录取 Bearer
        </button>
        <button
          type="button"
          className="btn"
          disabled={registering}
          onClick={() => void assignLocalesAndRename({ onlyMissing: true })}
        >
          补齐语言改名
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setView((v) => (v === 'cards' ? 'table' : 'cards'))}
        >
          {view === 'cards' ? '表格视图' : '卡片视图'}
        </button>
        <div className="stats">
          Bearer {bearerN}/{registered} · 已创建用户名 {named}/{bearerN}
        </div>
      </div>

      {view === 'cards' ? (
        list.length === 0 ? (
          <div className="empty">
            <strong>还没有真实邮箱</strong>
            请先在「邮箱管理」导入，系统会自动探活并排队注册。
          </div>
        ) : (
          <VirtualAccountGrid
            items={list}
            estimateSize={120}
            renderItem={(a) => (
              <LovemiCard account={a} selected={a.id === selectedId} onSelect={select} />
            )}
          />
        )
      ) : (
        <div className="table-wrap">
          <table className="email-table">
            <thead>
              <tr>
                <th>邮箱</th>
                <th>Lovemi</th>
                <th>Bearer</th>
                <th>语言</th>
                <th>用户名</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id} onClick={() => select(a.id)}>
                  <td>{a.email}</td>
                  <td>
                    <LovemiChip account={a} />
                  </td>
                  <td>
                    <BearerChip account={a} />
                  </td>
                  <td>
                    <LocaleChip account={a} />
                  </td>
                  <td>
                    <DisplayNameChip account={a} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected ? (
        <>
          <div className="drawer-mask" role="presentation" onClick={() => select(null)} />
          <aside className="drawer" tabIndex={-1}>
            <h2>{selected.email}</h2>
            <div className="meta-row" style={{ marginBottom: 12 }}>
              <LovemiChip account={selected} />
              <BearerChip account={selected} />
              <LocaleChip account={selected} />
              <DisplayNameChip account={selected} />
            </div>
            <div className="section">
              <h3>Lovemi 凭证</h3>
              <dl className="kv">
                <dt>站内密码</dt>
                <dd>{maskSecret(selected.lovemiPassword)}</dd>
                <dt>Bearer</dt>
                <dd>{maskSecret(selected.lovemiSessionToken)}</dd>
                <dt>语言</dt>
                <dd>{localeLabel(selected.lovemiLocale)}</dd>
                <dt>显示名</dt>
                <dd>{selected.lovemiDisplayName || '未创建'}</dd>
                <dt>注册时间</dt>
                <dd>
                  {selected.lovemiRegisteredAt
                    ? new Date(selected.lovemiRegisteredAt).toLocaleString()
                    : '—'}
                </dd>
              </dl>
            </div>
            <div className="section" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!(selected.refreshToken && selected.clientId)}
                onClick={() => enqueueLovemiPasswordReset([selected.id])}
              >
                {selected.lovemiPassword ? '重置站内密码' : '找回站内密码'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={!selected.lovemiPassword && !(selected.refreshToken && selected.clientId)}
                onClick={() => enqueueLovemiLogin([selected.id])}
              >
                {selected.lovemiSessionToken ? '刷新 Bearer' : '登录取 Bearer'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={!selected.lovemiSessionToken}
                onClick={() =>
                  void assignLocalesAndRename({ onlyMissing: false, accountIds: [selected.id] })
                }
              >
                强制重改名
              </button>
              <button
                type="button"
                className="btn"
                disabled={registering || selected.lovemiRegistered}
                onClick={() => enqueueLovemiRegister([selected.id])}
              >
                加入注册队列
              </button>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setLovemiStatus(selected.id, 'registered', {
                    lovemiRegistered: true,
                    lovemiRegisteredAt: new Date().toISOString(),
                    lovemiRegError: undefined,
                  })
                }
              >
                手动标已注册
              </button>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setLovemiStatus(selected.id, 'none', {
                    lovemiRegistered: false,
                    lovemiRegisteredAt: undefined,
                    lovemiRegError: undefined,
                  })
                }
              >
                清除注册标记
              </button>
            </div>
          </aside>
        </>
      ) : null}
    </section>
  )
}
