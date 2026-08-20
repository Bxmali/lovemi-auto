import { useEffect, useRef, useState } from 'react'
import { EmailHub } from './pages/EmailHub'
import { SettingsPage } from './pages/SettingsPage'
import { LovemiAccountsPage } from './pages/LovemiAccountsPage'
import { SecurityLogPage } from './pages/SecurityLogPage'
import { ConsolePage } from './pages/ConsolePage'
import { CopyLibraryPage } from './pages/CopyLibraryPage'
import { CreateCharacterPage } from './pages/CreateCharacterPage'
import { CaptionGenPage } from './pages/CaptionGenPage'
import { useEmailStore } from './store/emailStore'
import type { EmailAccount } from './types/email'
import { runEnterShell } from './motion/timelines'
import { probeIdleAccounts } from './services/autoProbe'
import { registerAllUnregisteredReady } from './services/lovemiRegister'
import { reloadAccountsFromDisk } from './services/reloadAccounts'
import { hydrateSettings } from './store/settingsStore'
import { useSecurityLogStore } from './store/securityLogStore'
import './styles/theme.css'

type NavId = 'email' | 'lovemi' | 'console' | 'createChar' | 'captionGen' | 'copy' | 'security' | 'tasks' | 'settings'

const NAV: { id: NavId; label: string; ready: boolean }[] = [
  { id: 'email', label: '邮箱管理', ready: true },
  { id: 'lovemi', label: 'Lovemi账号管理', ready: true },
  { id: 'console', label: '控制台', ready: true },
  { id: 'createChar', label: '创建角色', ready: true },
  { id: 'captionGen', label: '文案生成', ready: true },
  { id: 'copy', label: '文案库', ready: true },
  { id: 'security', label: '安全日志', ready: true },
  { id: 'tasks', label: '任务中心', ready: false },
  { id: 'settings', label: '系统设置', ready: true },
]

export default function App() {
  const rootRef = useRef<HTMLDivElement>(null)
  const [nav, setNav] = useState<NavId>('email')
  const replaceAccounts = useEmailStore((s) => s.replaceAccounts)
  const hydrated = useEmailStore((s) => s.hydrated)
  const accounts = useEmailStore((s) => s.accounts)
  const toast = useEmailStore((s) => s.toast)
  const toastUntil = useEmailStore((s) => s.toastUntil)
  const setToast = useEmailStore((s) => s.setToast)
  const persistable = useEmailStore((s) => s.persistable)
  const probing = useEmailStore((s) => s.probing)
  const registering = useEmailStore((s) => s.registering)
  const suspendPersist = useEmailStore((s) => s.suspendPersist)
  const savingRef = useRef(false)
  const idleProbedRef = useRef(false)
  const persistGen = useRef(0)
  const lastSavedCount = useRef(0)

  useEffect(() => {
    if (rootRef.current) runEnterShell(rootRef.current)
    hydrateSettings()
    useSecurityLogStore.getState().hydrate()
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const raw = await window.lovemi?.loadAccounts()
        if (cancelled) return
        if (!raw) {
          replaceAccounts([])
          return
        }
        const parsed = JSON.parse(raw) as EmailAccount[]
        const real = Array.isArray(parsed)
          ? parsed
              .filter((a) => a && !String(a.id || '').startsWith('demo-') && !String(a.email || '').endsWith('@example.com'))
              .map((a) => ({
                ...a,
                labels: (a.labels || []).filter((l) => !/^lovemi(-reg)?$/i.test(String(l))),
              }))
          : []
        // 强制用磁盘覆盖，避免旧内存只剩 1 条把库存写坏
        replaceAccounts(real)
        lastSavedCount.current = real.length
        const { enqueueLoginMissingTokens } = await import('./services/lovemiLogin')
        window.setTimeout(() => enqueueLoginMissingTokens(), 1200)
        // Bearer 齐了之后自动均分语言 + 创建无数字男性网名
        window.setTimeout(() => {
          void import('./services/profileLocale').then(({ assignLocalesAndRename }) =>
            assignLocalesAndRename({ onlyMissing: true, silent: true }),
          )
        }, 4500)
      } catch {
        if (!cancelled) replaceAccounts([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [replaceAccounts])

  // 库存加载完成后：空闲探活 → 可用未注册入串行队列
  useEffect(() => {
    if (!hydrated || idleProbedRef.current) return
    idleProbedRef.current = true
    const t = window.setTimeout(() => {
      void (async () => {
        await probeIdleAccounts()
        await registerAllUnregisteredReady()
      })()
    }, 600)
    return () => window.clearTimeout(t)
  }, [hydrated])

  // 窗口聚焦时静默同步磁盘（外部脚本写盘后自动对齐）
  useEffect(() => {
    const onFocus = () => {
      const st = useEmailStore.getState()
      if (st.probing || st.registering || st.suspendPersist) return
      void reloadAccountsFromDisk({ silent: true })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // 仅在 hydrate 完成后持久化；探活/注册中 / 暂停落盘时不写
  // 防缩水：若内存条数远少于上次落盘，拒绝覆盖（避免只剩 1 条写坏库存）
  useEffect(() => {
    if (!window.lovemi || !hydrated || savingRef.current || probing || registering || suspendPersist) return
    const payload = persistable()
    // 禁止把非空库存写成空数组
    if (lastSavedCount.current > 0 && payload.length === 0) {
      setToast(`已拦截空库存落盘（原有约 ${lastSavedCount.current} 条）`)
      void reloadAccountsFromDisk({ silent: false })
      return
    }
    if (
      lastSavedCount.current >= 5 &&
      payload.length > 0 &&
      payload.length < Math.max(2, Math.floor(lastSavedCount.current * 0.4))
    ) {
      setToast(`已拦截异常缩水落盘（内存 ${payload.length} / 磁盘约 ${lastSavedCount.current}），正在同步磁盘`)
      void reloadAccountsFromDisk({ silent: false })
      return
    }
    const gen = ++persistGen.current
    const t = window.setTimeout(() => {
      if (gen !== persistGen.current) return
      if (
        useEmailStore.getState().probing ||
        useEmailStore.getState().registering ||
        useEmailStore.getState().suspendPersist
      )
        return
      savingRef.current = true
      void window.lovemi
        ?.saveAccounts(JSON.stringify(payload))
        .then(() => {
          lastSavedCount.current = payload.length
        })
        .finally(() => {
          savingRef.current = false
        })
    }, 800)
    return () => window.clearTimeout(t)
  }, [accounts, hydrated, persistable, probing, registering, suspendPersist, setToast])

  useEffect(() => {
    if (!toast) return
    const remain = toastUntil ? Math.max(500, toastUntil - Date.now()) : 2400
    const t = window.setTimeout(() => setToast(null), remain)
    return () => window.clearTimeout(t)
  }, [toast, toastUntil, setToast])

  return (
    <div className="app-shell" ref={rootRef}>
      <aside className="sidebar" data-motion="sidebar">
        <div className="brand">
          <div className="brand-mark">
            Lovemi <span>Auto</span>
          </div>
          <div className="brand-sub">专属自动化平台</div>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item${nav === item.id ? ' active' : ''}${item.ready ? '' : ' placeholder'}`}
              disabled={!item.ready}
              onClick={() => setNav(item.id)}
            >
              {item.label}
              {!item.ready ? ' · 即将推出' : ''}
            </button>
          ))}
        </nav>
      </aside>
      <main className="main" data-motion="main">
        {nav === 'email' ? <EmailHub /> : null}
        {nav === 'lovemi' ? <LovemiAccountsPage /> : null}
        {nav === 'console' ? <ConsolePage /> : null}
        {/* 保持挂载：切侧栏不丢创建角色草稿 / 等待中的立绘 */}
        <div
          className="main-panel-keep"
          style={{
            display: nav === 'createChar' ? 'flex' : 'none',
            flex: 1,
            minHeight: 0,
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <CreateCharacterPage active={nav === 'createChar'} />
        </div>
        <div
          className="main-panel-keep"
          style={{
            display: nav === 'captionGen' ? 'flex' : 'none',
            flex: 1,
            minHeight: 0,
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <CaptionGenPage active={nav === 'captionGen'} />
        </div>
        {nav === 'copy' ? <CopyLibraryPage /> : null}
        {nav === 'security' ? <SecurityLogPage /> : null}
        {nav === 'settings' ? <SettingsPage /> : null}
      </main>
      {toast &&
      !(
        nav === 'console' &&
        /^(槽\d|【槽\d)|全自动|立绘|生图|创建角色|角色已/.test(toast)
      ) ? (
        <div className="toast">{toast}</div>
      ) : null}
    </div>
  )
}
