import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import {
  DEFAULT_URL_PROXY,
  resolveOutboundProxy,
  useSettingsStore,
  type MailProxyRoute,
} from '../store/settingsStore'
import { prefersReducedMotion } from '../motion/timelines'
import { useEmailStore } from '../store/emailStore'

export function SettingsPage() {
  const rootRef = useRef<HTMLElement>(null)
  const settings = useSettingsStore()
  const setToast = useEmailStore((s) => s.setToast)
  const effective = resolveOutboundProxy(settings)
  const [testing, setTesting] = useState(false)
  const [bridging, setBridging] = useState(false)
  const [testReport, setTestReport] = useState<string | null>(null)
  const saveHint = useRef<number | null>(null)

  useEffect(() => {
    if (!rootRef.current || prefersReducedMotion()) return
    gsap.fromTo(
      rootRef.current.querySelectorAll('[data-motion="block"]'),
      { opacity: 0, y: 14 },
      { opacity: 1, y: 0, stagger: 0.06, duration: 0.4, ease: 'power3.out' },
    )
  }, [])

  const autoSave = (patch: Parameters<typeof settings.update>[0]) => {
    settings.update(patch)
    if (saveHint.current) window.clearTimeout(saveHint.current)
    saveHint.current = window.setTimeout(() => setToast('设置已自动保存'), 400)
  }

  const ensureVless = async () => {
    if (!window.lovemi?.resolveMailProxy) {
      setToast('请在 Electron 窗口中操作')
      return
    }
    setBridging(true)
    try {
      const st = await window.lovemi.resolveMailProxy({
        vlessEnabled: true,
        subscriptionUrl: settings.urlProxy,
        localEnabled: settings.localProxyEnabled,
        localHost: settings.localProxyHost,
        localPort: settings.localProxyPort,
      })
      if (st.source === 'vless' && st.proxyUrl) {
        setToast(`VLESS 已就绪 · ${st.nodeServer}`)
        setTestReport(`VLESS 主通道已拉起\n节点：${st.nodeServer}\n本地入站：${st.proxyUrl}`)
      } else if (st.source === 'fallback-local') {
        setToast(`VLESS 失败，已落到本地兜底 ${settings.localProxyPort}`)
        setTestReport(`VLESS 失败：${st.error || '未知'}\n已使用本地兜底：${st.proxyUrl}`)
      } else {
        setToast(st.error || '出站不可用')
        setTestReport(st.error || '出站不可用')
      }
    } finally {
      setBridging(false)
    }
  }

  const runProxyTest = async () => {
    if (!window.lovemi?.testProxy) {
      setToast('请在 Electron 窗口中测试代理')
      return
    }
    setTesting(true)
    try {
      await ensureVless()
      const local = settings.localProxyEnabled
        ? `http://${settings.localProxyHost}:${settings.localProxyPort}`
        : undefined
      const r = await window.lovemi.testProxy({
        localProxyUrl: local,
        urlProxy: settings.urlProxyEnabled ? settings.urlProxy : undefined,
      })
      const st = await window.lovemi.vlessStatus?.()
      const lines = [
        `VLESS 入站：${st?.running ? `运行中 ${st.proxyUrl} · ${st.nodeServer}` : `未运行（${st?.error || '—'}）`}`,
        `本地 ${settings.localProxyPort}：${r.localPortOpen ? '已监听' : '未开'}`,
        `经本地兜底访问微软：${r.viaProxy.ok ? '成功' : `失败（${r.viaProxy.error || '未知'}）`}`,
        `订阅识别：${r.urlProxyHint}`,
        `策略：VLESS 可选 → 本地 ${settings.localProxyPort} 兜底 → 禁止直连`,
      ]
      setTestReport(lines.join('\n'))
    } catch (e) {
      setTestReport(e instanceof Error ? e.message : String(e))
    } finally {
      setTesting(false)
    }
  }

  return (
    <section className="email-page settings-page" ref={rootRef}>
      <h1 className="page-title">系统设置</h1>
      <p className="page-desc">自动保存 · 当前推荐本地兜底 :7897 · VLESS 可选 · 禁止直连 · {effective.label}</p>

      <div className="settings-stack">
        <div className="settings-card" data-motion="block">
          <div className="settings-card-head">
            <h2>VLESS 订阅（主通道）</h2>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.urlProxyEnabled}
                onChange={(e) => autoSave({ urlProxyEnabled: e.target.checked })}
              />
              <span>启用</span>
            </label>
          </div>
          <p className="settings-hint">
            订阅 URL 拉取后由内置 <strong>sing-box</strong> 拉起节点，应用流量走{' '}
            <code>127.0.0.1:17891</code>。拉取订阅失败时再用本地兜底端口。
          </p>
          <label className="settings-full">
            订阅 URL
            <input
              className="field"
              value={settings.urlProxy}
              onChange={(e) => autoSave({ urlProxy: e.target.value })}
              spellCheck={false}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" disabled={bridging} onClick={() => void ensureVless()}>
              {bridging ? '拉起中…' : '拉起 / 刷新 VLESS'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => autoSave({ urlProxy: DEFAULT_URL_PROXY })}>
              恢复默认 URL
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void navigator.clipboard.writeText(settings.urlProxy)
                setToast('订阅链接已复制')
              }}
            >
              复制链接
            </button>
          </div>
        </div>

        <div className="settings-card" data-motion="block">
          <div className="settings-card-head">
            <h2>本地代理（兜底）</h2>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.localProxyEnabled}
                onChange={(e) => autoSave({ localProxyEnabled: e.target.checked })}
              />
              <span>启用</span>
            </label>
          </div>
          <p className="settings-hint">仅当 VLESS 拉起失败时使用。不是主通道。</p>
          <div className="settings-row">
            <label>
              主机
              <input
                className="field"
                value={settings.localProxyHost}
                onChange={(e) => autoSave({ localProxyHost: e.target.value })}
                placeholder="127.0.0.1"
              />
            </label>
            <label>
              端口
              <input
                className="field"
                type="number"
                min={1}
                max={65535}
                value={settings.localProxyPort}
                onChange={(e) => autoSave({ localProxyPort: Number(e.target.value) || 7897 })}
              />
            </label>
          </div>
          <div className="settings-preview">
            http://{settings.localProxyHost || '127.0.0.1'}:{settings.localProxyPort || 7897}
          </div>
        </div>

        <div className="settings-card" data-motion="block">
          <h2>邮箱检测路由</h2>
          <div className="route-options">
            {(
              [
                {
                  id: 'vless' as MailProxyRoute,
                  title: 'VLESS 优先',
                  desc: '订阅主通道，失败才用本地兜底',
                },
                {
                  id: 'local' as MailProxyRoute,
                  title: '仅本地兜底',
                  desc: '跳过 VLESS，只用本地端口（现 7897）',
                },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`route-card${settings.mailProxyRoute === opt.id ? ' active' : ''}`}
                onClick={() => autoSave({ mailProxyRoute: opt.id })}
              >
                <strong>{opt.title}</strong>
                <span>{opt.desc}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="settings-card" data-motion="block">
          <h2>连通性</h2>
          <button type="button" className="btn btn-primary" disabled={testing} onClick={() => void runProxyTest()}>
            {testing ? '检测中…' : '测试 VLESS / 兜底'}
          </button>
          {testReport ? <pre className="settings-report">{testReport}</pre> : null}
        </div>

        <div className="settings-actions" data-motion="block">
          <span className="settings-autosave">更改已自动保存</span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              settings.resetProxyDefaults()
              setToast('已恢复默认')
            }}
          >
            恢复默认
          </button>
        </div>
      </div>
    </section>
  )
}
