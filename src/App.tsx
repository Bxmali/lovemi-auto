import { useEffect, useRef, useState } from 'react'
import { EmailHub } from './pages/EmailHub'
import { SettingsPage } from './pages/SettingsPage'
import { LovemiAccountsPage } from './pages/LovemiAccountsPage'
import { SecurityLogPage } from './pages/SecurityLogPage'
import { ConsolePage } from './pages/ConsolePage'
import { CopyLibraryPage } from './pages/CopyLibraryPage'
import { CreateCharacterPage } from './pages/CreateCharacterPage'
import { CaptionGenPage } from './pages/CaptionGenPage'
import { FeatureMaterialPage } from './pages/FeatureMaterialPage'
import { RealRegisterPage } from './pages/RealRegisterPage'
import { useEmailStore } from './store/emailStore'
import type { EmailAccount } from './types/email'
import { runEnterShell, runNavSpotlight, pauseNavSpotlight } from './motion/timelines'
import { probeIdleAccounts } from './services/autoProbe'
import { registerAllUnregisteredReady } from './services/lovemiRegister'
import { reloadAccountsFromDisk } from './services/reloadAccounts'
import { hydrateSettings } from './store/settingsStore'
import { useSecurityLogStore } from './store/securityLogStore'
import {
  DEMO_CLICK_WINDOW_MS,
  DEMO_CLICKS,
  clearLegacyDemoUnlockFlag,
  verifyDemoPassword,
} from './lib/demoUnlock'
import './styles/theme.css'

type NavId =
  | 'email'
  | 'realRegister'
  | 'lovemi'
  | 'console'
  | 'createChar'
  | 'featureMaterial'
  | 'captionGen'
  | 'copy'
  | 'security'
  | 'tasks'
  | 'settings'

const NAV: { id: NavId; label: string; ready: boolean; spotlight?: boolean; demo?: boolean }[] = [
  { id: 'email', label: '邮箱管理', ready: true },
  { id: 'lovemi', label: 'Lovemi账号管理', ready: true },
  { id: 'console', label: '控制台', ready: true },
  { id: 'createChar', label: '创建角色', ready: true, spotlight: true },
  { id: 'featureMaterial', label: '创建特色素材', ready: true, spotlight: true },
  { id: 'captionGen', label: '文案生成', ready: true, spotlight: true },
  { id: 'copy', label: '文案库', ready: true },
  { id: 'security', label: '安全日志', ready: true },
  { id: 'tasks', label: '任务中心', ready: false },
  { id: 'settings', label: '系统设置', ready: true },
]

export default function App() {
  const rootRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const [nav, setNav] = useState<NavId>('email')
  const [appVersion, setAppVersion] = useState('0.0.0')
  const replaceAccounts = useEmailStore((s) => s.replaceAccounts)
  const hydrated = useEmailStore((s) => s.hydrated)
  const accountCount = useEmailStore((s) => s.accounts.length)
  const toast = useEmailStore((s) => s.toast)
  const toastUntil = useEmailStore((s) => s.toastUntil)
  const setToast = useEmailStore((s) => s.setToast)
  const savingRef = useRef(false)
  const idleProbedRef = useRef(false)
  const persistGen = useRef(0)
  const lastSavedCount = useRef(0)
  const [demoNavOpen, setDemoNavOpen] = useState(false)
  const [unlockModalOpen, setUnlockModalOpen] = useState(false)
  const [unlockPassword, setUnlockPassword] = useState('')
  const [unlockBusy, setUnlockBusy] = useState(false)
  const brandClickRef = useRef({ count: 0, lastAt: 0 })

  const navItems = demoNavOpen
    ? [
        NAV[0]!,
        { id: 'realRegister' as const, label: '真实账号注册', ready: true, demo: true },
        ...NAV.slice(1),
      ]
    : NAV

  const openDemoNav = () => {
    setDemoNavOpen(true)
    setNav('realRegister')
  }

  const prevNavRef = useRef(nav)
  useEffect(() => {
    const prev = prevNavRef.current
    if (prev === 'realRegister' && nav !== 'realRegister') {
      setDemoNavOpen(false)
    }
    prevNavRef.current = nav
  }, [nav])

  const submitUnlockPassword = () => {
    if (unlockBusy) return
    setUnlockBusy(true)
    void verifyDemoPassword(unlockPassword).then((ok) => {
      setUnlockBusy(false)
      if (!ok) {
        setToast('密码错误')
        return
      }
      setUnlockModalOpen(false)
      setUnlockPassword('')
      openDemoNav()
    })
  }

  const onBrandActivate = (e: React.MouseEvent | React.PointerEvent) => {
    if (demoNavOpen) return
    e.preventDefault()
    e.stopPropagation()
    const now = Date.now()
    if (brandClickRef.current.lastAt && now - brandClickRef.current.lastAt > DEMO_CLICK_WINDOW_MS) {
      brandClickRef.current = { count: 1, lastAt: now }
      return
    }
    brandClickRef.current.count += 1
    brandClickRef.current.lastAt = now
    if (brandClickRef.current.count < DEMO_CLICKS) return
    brandClickRef.current = { count: 0, lastAt: 0 }
    setUnlockPassword('')
    setUnlockModalOpen(true)
  }

  useEffect(() => {
    clearLegacyDemoUnlockFlag()
    if (rootRef.current) runEnterShell(rootRef.current)
    hydrateSettings()
    useSecurityLogStore.getState().hydrate()
    void window.lovemi
      ?.getAppVersion()
      .then((version) => setAppVersion(version || '0.0.0'))
      .catch(() => setAppVersion('0.0.0'))
  }, [])

  useEffect(() => {
    const navRoot = navRef.current
    if (!navRoot) return
    const buttons = Array.from(
      navRoot.querySelectorAll<HTMLElement>('[data-nav-spotlight="1"]'),
    )
    runNavSpotlight(buttons)
    return () => {
      buttons.forEach((el) => pauseNavSpotlight(el, true))
    }
  }, [])

  useEffect(() => {
    const navRoot = navRef.current
    if (!navRoot) return
    const buttons = Array.from(
      navRoot.querySelectorAll<HTMLElement>('[data-nav-spotlight="1"]'),
    )
    buttons.forEach((el) => {
      const id = el.dataset.navId as NavId | undefined
      pauseNavSpotlight(el, id === nav)
    })
  }, [nav])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const raw = await window.lovemi?.loadAccounts()
        if (cancelled) return
        if (!raw) {
          if (useEmailStore.getState().accounts.length > 0) {
            setToast('本机库存读取为空，已保留当前列表（未落盘）')
            return
          }
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
        if (!real.length && useEmailStore.getState().accounts.length > 0) {
          setToast('磁盘读出 0 条，已拒绝用空列表覆盖内存')
          return
        }
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
      } catch (e) {
        if (!cancelled) {
          setToast(`库存读取失败：${e instanceof Error ? e.message : String(e)}（未清空列表）`)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [replaceAccounts])

  // 界面被清空但磁盘仍有号时，自动从本机库存拉回
  useEffect(() => {
    if (!hydrated || accountCount > 0 || !window.lovemi?.loadAccounts) return
    const t = window.setTimeout(() => {
      if (useEmailStore.getState().accounts.length === 0) {
        void reloadAccountsFromDisk({ silent: false })
      }
    }, 400)
    return () => window.clearTimeout(t)
  }, [hydrated, accountCount])

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
  // 用 subscribe 而不是订阅 accounts，避免 255 条每次变更都重绘整棵 App（含创建角色页）
  useEffect(() => {
    let t: number | undefined
    const persistNow = () => {
      if (!window.lovemi || savingRef.current) return
      const st = useEmailStore.getState()
      if (!st.hydrated || st.probing || st.registering || st.suspendPersist) return
      const payload = st.persistable()
      if (payload.length === 0) {
        if (lastSavedCount.current > 0) {
          setToast(`已拦截空库存落盘（原有约 ${lastSavedCount.current} 条）`)
          void reloadAccountsFromDisk({ silent: false })
        }
        return
      }
      if (
        lastSavedCount.current >= 5 &&
        payload.length < Math.max(2, Math.floor(lastSavedCount.current * 0.4))
      ) {
        setToast(`已拦截异常缩水落盘（内存 ${payload.length} / 磁盘约 ${lastSavedCount.current}），正在同步磁盘`)
        void reloadAccountsFromDisk({ silent: false })
        return
      }
      const gen = ++persistGen.current
      savingRef.current = true
      void window.lovemi
        .saveAccounts(JSON.stringify(payload))
        .then((res) => {
          if (gen !== persistGen.current) return
          if (res && 'ok' in res && res.ok === false) {
            setToast(res.error || '落盘被拒绝')
            return
          }
          lastSavedCount.current = payload.length
        })
        .finally(() => {
          savingRef.current = false
        })
    }
    const unsub = useEmailStore.subscribe((s, prev) => {
      if (s.accounts === prev.accounts) return
      window.clearTimeout(t)
      t = window.setTimeout(persistNow, 2500)
    })
    return () => {
      unsub()
      window.clearTimeout(t)
    }
  }, [setToast])

  useEffect(() => {
    if (!toast) return
    const remain = toastUntil ? Math.max(500, toastUntil - Date.now()) : 2400
    const t = window.setTimeout(() => setToast(null), remain)
    return () => window.clearTimeout(t)
  }, [toast, toastUntil, setToast])

  return (
    <div className="app-shell" ref={rootRef}>
      <aside className="sidebar" data-motion="sidebar">
        <button
          type="button"
          className="brand brand-unlock"
          onPointerDown={onBrandActivate}
          aria-label="Lovemi Auto"
        >
          <div className="brand-mark">
            Lovemi <span>Auto</span>
          </div>
          <div className="brand-sub">专属自动化平台</div>
        </button>
        <nav className="nav" ref={navRef}>
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              data-nav-id={item.id}
              data-nav-spotlight={item.spotlight ? '1' : undefined}
              className={`nav-item${nav === item.id ? ' active' : ''}${item.ready ? '' : ' placeholder'}${
                item.spotlight ? ' nav-item-spotlight' : ''
              }${item.demo ? ' nav-item-demo' : ''}`}
              disabled={!item.ready}
              onClick={() => setNav(item.id)}
            >
              {item.spotlight ? <span className="nav-spotlight-glow" aria-hidden /> : null}
              <span className="nav-item-label">{item.label}</span>
              {item.spotlight ? <span className="nav-spotlight-badge">重点功能</span> : null}
              {item.demo ? <span className="nav-demo-badge">Demo</span> : null}
              {!item.ready ? ' · 即将推出' : ''}
            </button>
          ))}
        </nav>
        <div className="sidebar-version" title="当前安装版本">
          v{appVersion}
        </div>
      </aside>
      <main className="main" data-motion="main">
        {nav === 'email' ? <EmailHub /> : null}
        {nav === 'realRegister' ? <RealRegisterPage /> : null}
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
            display: nav === 'featureMaterial' ? 'flex' : 'none',
            flex: 1,
            minHeight: 0,
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <FeatureMaterialPage active={nav === 'featureMaterial'} />
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
      {unlockModalOpen ? (
        <div
          className="modal-backdrop"
          onPointerDown={() => {
            setUnlockModalOpen(false)
            setUnlockPassword('')
          }}
        >
          <div
            className="modal-panel"
            onPointerDown={(e) => e.stopPropagation()}
            role="dialog"
            aria-labelledby="unlock-title"
          >
            <h2 id="unlock-title" className="modal-title">
              Demo 功能解锁
            </h2>
            <p className="modal-desc">输入二级密码以显示「真实账号注册」</p>
            <input
              className="field"
              type="password"
              autoFocus
              placeholder="二级密码"
              value={unlockPassword}
              onChange={(e) => setUnlockPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitUnlockPassword()
                if (e.key === 'Escape') {
                  setUnlockModalOpen(false)
                  setUnlockPassword('')
                }
              }}
            />
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setUnlockModalOpen(false)
                  setUnlockPassword('')
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={unlockBusy || !unlockPassword.trim()}
                onClick={submitUnlockPassword}
              >
                {unlockBusy ? '验证中…' : '解锁'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
