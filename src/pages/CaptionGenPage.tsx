import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Converter } from 'opencc-js'
import { useEmailStore } from '../store/emailStore'
import { useSettingsStore } from '../store/settingsStore'
import { runEmailPageEnter } from '../motion/timelines'

type MediaItem = {
  id: string
  kind: 'image' | 'video'
  previewUrl: string
  fileName: string
  /** 送给中转站的图（视频已抽帧） */
  frames: Array<{ base64: string; mimeType: string }>
}

async function resolveProxyUrl() {
  const settings = useSettingsStore.getState()
  if (!window.lovemi?.resolveMailProxy) {
    return { proxyUrl: '', error: '请在 Electron 中运行' }
  }
  const st = await window.lovemi.resolveMailProxy({
    vlessEnabled: settings.urlProxyEnabled && settings.mailProxyRoute === 'vless',
    subscriptionUrl: settings.urlProxy,
    localEnabled: settings.localProxyEnabled,
    localHost: settings.localProxyHost,
    localPort: settings.localProxyPort,
  })
  return { proxyUrl: st.proxyUrl || '', error: st.error }
}

function fileToBase64(file: Blob): Promise<{ base64: string; mime: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
      if (!m) {
        reject(new Error('读文件失败'))
        return
      }
      resolve({ mime: m[1], base64: m[2] })
    }
    reader.onerror = () => reject(reader.error || new Error('读文件失败'))
    reader.readAsDataURL(file)
  })
}

function characterNameFromFile(fileName?: string): string {
  const raw = String(fileName || '')
    .replace(/\.[^.]+$/i, '')
    .trim()
  if (!raw) return ''
  const head = raw.split(/[_－—\-\s]+/)[0]?.trim() || raw
  if (/^(m-|asset|aset|chr_|slot|槽)/i.test(head)) return ''
  return head.slice(0, 24)
}

/** 从视频抽 1～3 帧 JPEG，供视觉模型看剧情 */
async function extractVideoFrames(blob: Blob, maxFrames = 3): Promise<Array<{ base64: string; mimeType: string }>> {
  const url = URL.createObjectURL(blob)
  try {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.src = url
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve()
      video.onerror = () => reject(new Error('视频无法解码'))
    })
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1
    const times =
      maxFrames <= 1
        ? [Math.min(0.2, duration * 0.1)]
        : Array.from({ length: maxFrames }, (_, i) => (duration * (i + 1)) / (maxFrames + 1))
    const frames: Array<{ base64: string; mimeType: string }> = []
    const canvas = document.createElement('canvas')
    for (const t of times) {
      await new Promise<void>((resolve, reject) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked)
          resolve()
        }
        video.addEventListener('seeked', onSeeked)
        try {
          video.currentTime = Math.min(Math.max(0.05, t), Math.max(0.05, duration - 0.05))
        } catch (e) {
          video.removeEventListener('seeked', onSeeked)
          reject(e)
        }
      })
      const w = video.videoWidth || 720
      const h = video.videoHeight || 1280
      const maxW = 960
      const scale = w > maxW ? maxW / w : 1
      canvas.width = Math.max(1, Math.round(w * scale))
      canvas.height = Math.max(1, Math.round(h * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.86)
      const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
      if (m) frames.push({ mimeType: m[1], base64: m[2] })
    }
    if (!frames.length) throw new Error('未能从视频抽出画面')
    return frames
  } finally {
    URL.revokeObjectURL(url)
  }
}

const MAX_MEDIA = 2

function appendMediaItem(
  prev: MediaItem[],
  next: MediaItem,
): { items: MediaItem[]; dropped?: MediaItem } {
  if (prev.length < MAX_MEDIA) {
    return { items: [...prev, next] }
  }
  // 已满 2 个：挤掉最旧的，保留最新两个
  const dropped = prev[0]
  return { items: [prev[1], next], dropped }
}

export function CaptionGenPage({ active }: { active: boolean }) {
  const pageRef = useRef<HTMLElement>(null)
  const setToast = useEmailStore((s) => s.setToast)
  const [items, setItems] = useState<MediaItem[]>([])
  const [characterName, setCharacterName] = useState('')
  const [userHint, setUserHint] = useState('')
  const [captionStyle, setCaptionStyle] = useState<'standard' | 'twitterComment'>('standard')
  const [caption, setCaption] = useState('')
  const [scriptMode, setScriptMode] = useState<'hans' | 'hant'>('hans')
  /** 生成时的简体底稿；切繁体/切回简体都基于它，避免来回损耗 */
  const captionHansRef = useRef('')
  const [busy, setBusy] = useState(false)
  const [hasApiKey, setHasApiKey] = useState(false)
  const [meta, setMeta] = useState('')

  const [tgBaseUrl, setTgBaseUrl] = useState('http://127.0.0.1:8788')
  const [tgPeer, setTgPeer] = useState('kindredaiav1')
  const [tgSkipPosted, setTgSkipPosted] = useState(true)
  const [tgBatchBusy, setTgBatchBusy] = useState(false)
  const [tgPreview, setTgPreview] = useState('')
  const [tgLog, setTgLog] = useState<string[]>([])
  const [showTgPanel, setShowTgPanel] = useState(false)

  const s2t = useMemo(() => Converter({ from: 'cn', to: 'tw' }), [])
  const t2s = useMemo(() => Converter({ from: 'tw', to: 'cn' }), [])

  useEffect(() => {
    if (!pageRef.current || !active) return
    runEmailPageEnter(pageRef.current)
  }, [active])

  useEffect(() => {
    void (async () => {
      const cfg = await window.lovemi?.createCharConfig?.()
      if (cfg) setHasApiKey(cfg.hasApiKey)
    })()
  }, [active])

  useEffect(() => {
    if (!active || !window.lovemi?.tgautoSettingsGet) return
    const api = window.lovemi
    void (async () => {
      const s = await api.tgautoSettingsGet()
      setTgBaseUrl(s.baseUrl || 'http://127.0.0.1:8788')
      setTgPeer(s.peer || 'kindredaiav1')
      setTgSkipPosted(s.skipPosted !== false)
    })()
  }, [active])

  useEffect(() => {
    if (!active || !window.lovemi?.onTgautoBatchProgress) return
    const api = window.lovemi
    return api.onTgautoBatchProgress((p) => {
      const line = p.message || p.error || p.phase
      if (line) setTgLog((prev) => [...prev.slice(-80), line])
      if (p.phase === 'summary' || p.phase === 'cancelled') {
        setTgBatchBusy(false)
        if (p.message) setToast(p.message)
      }
    })
  }, [active, setToast])

  const refreshTgPreview = useCallback(async () => {
    if (!window.lovemi?.tgautoPreview) return
    const p = await window.lovemi.tgautoPreview()
    setTgPreview(
      `${p.resourceDir} · 共 ${p.total} 组 · 待发 ${p.pending} · 已记录 ${p.posted}` +
        (p.characters.length ? ` · 下一批：${p.characters.slice(0, 8).join('、')}${p.characters.length > 8 ? '…' : ''}` : ''),
    )
  }, [])

  useEffect(() => {
    if (!active || !showTgPanel) return
    void refreshTgPreview()
  }, [active, showTgPanel, refreshTgPreview])

  const onTgautoBatch = async () => {
    const api = window.lovemi
    if (!api?.tgautoBatchStart || !api.tgautoHealth) {
      setToast('请在 Electron 桌面窗口操作')
      return
    }
    if (!hasApiKey) {
      setToast('请先在「创建角色」页保存中转站 API Key')
      return
    }
    setShowTgPanel(true)

    const baseUrl = tgBaseUrl.trim() || 'http://127.0.0.1:8788'
    setTgLog((prev) => [...prev.slice(-80), `正在检测 TGAuto 连接：${baseUrl} …`])
    setToast('正在检测是否已连接 TGAuto…')
    const health = await api.tgautoHealth({ baseUrl })
    if (!health.ok) {
      const reason = health.error || '未知错误'
      setTgLog((prev) => [...prev.slice(-80), `未连接 TGAuto：${reason}`])
      window.alert(
        `未连接到 TGAuto，无法群发。\n\n地址：${health.baseUrl}\n原因：${reason}\n\n请先启动 TGAuto（API :8788）后再试。`,
      )
      setToast('未连接 TGAuto，已取消操作')
      return
    }

    const linked = window.confirm(
      `已检测到 TGAuto 连接正常。\n\n地址：${health.baseUrl}\n目标频道：${tgPeer.trim() || '（未填）'}\n\n是否继续「推特资源一键群发」？\n（分类 → Lovemi 文案 → 相册群发，每个角色只发一遍）`,
    )
    if (!linked) {
      setTgLog((prev) => [...prev.slice(-80), '已取消：用户未确认连接后继续'])
      setToast('已取消群发')
      return
    }

    const outbound = await resolveProxyUrl()
    if (!outbound.proxyUrl) {
      setToast(outbound.error || '无代理')
      return
    }
    await api.tgautoSettingsSave?.({
      baseUrl,
      peer: tgPeer.trim(),
      skipPosted: tgSkipPosted,
    })
    const preview = await api.tgautoPreview?.()
    const pending = preview?.pending ?? 0
    if (!pending) {
      setToast(preview?.total ? '没有待发角色（可能都已发过）' : '推特资源里没有 jpg+mp4 成对角色')
      await refreshTgPreview()
      return
    }
    const ok = window.confirm(
      `即将发送 ${pending} 个角色到 ${tgPeer.trim() || '频道'}。\n每个角色只发一遍（三号轮流）。\n\n确认开始？`,
    )
    if (!ok) return
    setTgBatchBusy(true)
    setTgLog([`TGAuto 已连接 · 开始群发 ${pending} 个角色 → ${tgPeer.trim()}`])
    try {
      const res = await api.tgautoBatchStart({
        proxyUrl: outbound.proxyUrl,
        baseUrl,
        peer: tgPeer.trim(),
        skipPosted: tgSkipPosted,
      })
      if (!res.ok && res.error) setToast(res.error)
      else setToast(`群发结束：成功 ${res.posted} · 失败 ${res.failed} · 跳过 ${res.skipped}`)
      await refreshTgPreview()
    } catch (e) {
      setToast(e instanceof Error ? e.message : '群发异常')
    } finally {
      setTgBatchBusy(false)
    }
  }
  const ingestFile = useCallback(
    async (file: File | Blob, nameHint?: string) => {
      const mime = file.type || ''
      const fileName =
        (file instanceof File && file.name) || nameHint || (mime.startsWith('video/') ? 'video.mp4' : 'image.png')

      const pushItem = (item: MediaItem, toastText: string) => {
        setItems((prev) => {
          const { items: next, dropped } = appendMediaItem(prev, item)
          if (dropped?.previewUrl.startsWith('blob:')) URL.revokeObjectURL(dropped.previewUrl)
          return next
        })
        const guessed = characterNameFromFile(fileName)
        setCharacterName((cur) => cur.trim() || guessed || cur)
        setCaption('')
        setScriptMode('hans')
        captionHansRef.current = ''
        setToast(toastText)
      }

      if (mime.startsWith('image/')) {
        const { base64, mime: m } = await fileToBase64(file)
        const previewUrl = URL.createObjectURL(file)
        pushItem(
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            kind: 'image',
            previewUrl,
            fileName,
            frames: [{ base64, mimeType: m }],
          },
          `已加入图片（最多 ${MAX_MEDIA} 个）· ${fileName}`,
        )
        return
      }
      if (mime.startsWith('video/')) {
        setToast('正在从视频抽帧…')
        // 两素材时每视频少抽帧，避免超中转站图量上限
        const frameCount = 2
        const frames = await extractVideoFrames(file, frameCount)
        const previewUrl = URL.createObjectURL(file)
        pushItem(
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            kind: 'video',
            previewUrl,
            fileName,
            frames,
          },
          `已加入视频 · ${frames.length} 帧（最多 ${MAX_MEDIA} 个）· ${fileName}`,
        )
        return
      }
      setToast('请粘贴图片或视频')
    },
    [setToast],
  )

  const removeItem = useCallback((id: string) => {
    setItems((prev) => {
      const hit = prev.find((p) => p.id === id)
      if (hit?.previewUrl.startsWith('blob:')) URL.revokeObjectURL(hit.previewUrl)
      return prev.filter((p) => p.id !== id)
    })
  }, [])

  useEffect(() => {
    if (!active) return
    const onPaste = (e: ClipboardEvent) => {
      const list: File[] = []
      const clipItems = e.clipboardData?.items
      if (clipItems?.length) {
        for (const it of Array.from(clipItems)) {
          if (it.type.startsWith('image/') || it.type.startsWith('video/')) {
            const f = it.getAsFile()
            if (f) list.push(f)
          }
        }
      }
      if (!list.length && e.clipboardData?.files?.length) {
        for (const f of Array.from(e.clipboardData.files)) {
          if (f.type.startsWith('image/') || f.type.startsWith('video/')) list.push(f)
        }
      }
      if (!list.length) return
      e.preventDefault()
      e.stopPropagation()
      void (async () => {
        for (const f of list.slice(0, MAX_MEDIA)) {
          await ingestFile(f)
        }
      })()
    }
    window.addEventListener('paste', onPaste, true)
    return () => window.removeEventListener('paste', onPaste, true)
  }, [active, ingestFile])

  const onGenerate = async () => {
    if (!items.length) {
      setToast('先 Ctrl+V 粘贴图片或视频')
      return
    }
    if (!window.lovemi?.captionGenerate) {
      setToast('请在 Electron 桌面窗口操作')
      return
    }
    if (!hasApiKey) {
      setToast('请先在「创建角色」页保存中转站 API Key')
      return
    }
    const outbound = await resolveProxyUrl()
    if (!outbound.proxyUrl) {
      setToast(outbound.error || '无代理')
      return
    }
    const images = items.flatMap((it) => it.frames).slice(0, 4)
    const fileName =
      items.map((it) => it.fileName).find((n) => characterNameFromFile(n)) || items[0]?.fileName || ''
    setBusy(true)
    setMeta('')
    try {
      const res = await window.lovemi.captionGenerate({
        proxyUrl: outbound.proxyUrl,
        images,
        fileName,
        characterName: characterName.trim() || undefined,
        userHint: userHint.trim() || undefined,
        style: captionStyle,
      })
      if (!res.ok || !res.caption) {
        setToast(res.error || '文案生成失败')
        if (res.rawPreview) {
          const preview =
            captionStyle === 'twitterComment' ? s2t(res.rawPreview) : res.rawPreview
          setCaption(preview)
          captionHansRef.current = res.rawPreview
          setScriptMode(captionStyle === 'twitterComment' ? 'hant' : 'hans')
        }
        return
      }
      // 推特诱惑默认繁体展示；标准文案默认简体
      captionHansRef.current = res.caption
      if (captionStyle === 'twitterComment') {
        setCaption(s2t(res.caption))
        setScriptMode('hant')
        setToast('推特诱惑文案已生成（繁体）')
      } else {
        setCaption(res.caption)
        setScriptMode('hans')
        setToast('标准文案已生成（保留换行）')
      }
      setMeta(
        [
          captionStyle === 'twitterComment' ? '推特评论·繁体' : '标准文案',
          res.kinkLabel ? `主题 ${res.kinkLabel}` : '',
          res.characterName ? `角色 ${res.characterName}` : '',
          res.ownerName ? `用户 ${res.ownerName}` : '',
          res.model || '',
        ]
          .filter(Boolean)
          .join(' · '),
      )
      if (res.characterName && !characterName.trim()) setCharacterName(res.characterName)
    } catch (e) {
      setToast(e instanceof Error ? e.message : '生成异常')
    } finally {
      setBusy(false)
    }
  }

  const onCopy = async () => {
    if (!caption.trim()) return
    try {
      await navigator.clipboard.writeText(caption)
      setToast(scriptMode === 'hant' ? '已复制繁体全文' : '已复制全文')
    } catch {
      setToast('复制失败，请手动选中复制')
    }
  }

  const toggleScript = () => {
    if (!caption.trim()) return
    if (scriptMode === 'hans') {
      // 若用户手改过简体，以当前文本为底稿
      captionHansRef.current = caption
      setCaption(s2t(caption))
      setScriptMode('hant')
      setToast('已切换为繁体中文')
      return
    }
    // 切回简体：优先底稿，否则 t2s 当前内容
    const hans = captionHansRef.current.trim() ? captionHansRef.current : t2s(caption)
    setCaption(hans)
    setScriptMode('hans')
    setToast('已切回简体中文')
  }

  const clearAll = () => {
    setItems((prev) => {
      for (const p of prev) {
        if (p.previewUrl.startsWith('blob:')) URL.revokeObjectURL(p.previewUrl)
      }
      return []
    })
    setCaption('')
    captionHansRef.current = ''
    setScriptMode('hans')
    setMeta('')
  }

  return (
    <section className="email-page create-char-page" ref={pageRef} style={{ display: active ? undefined : 'none' }}>
      <h1 className="page-title">文案生成</h1>
      <p className="page-desc">
        Ctrl+V 可连续粘贴最多 2 个图片/视频。生成前可选「标准文案」或「推特评论·诱惑」。
        右侧青绿按钮可一键扫描「推特资源」并经 TGAuto 群发。
        {hasApiKey ? ' · API Key 已配置' : ' · 尚未配置 API Key'}
      </p>

      <div className="toolbar" data-motion="toolbar" style={{ flexWrap: 'wrap', gap: 10 }}>
        <label className="chip" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          虚拟女友名
          <input
            className="field"
            style={{ width: 140 }}
            value={characterName}
            onChange={(e) => setCharacterName(e.target.value)}
            placeholder="可从文件名自动填"
          />
        </label>
        <div className="chip" style={{ display: 'flex', alignItems: 'center', gap: 6 }} role="group" aria-label="文案类型">
          <button
            type="button"
            className={`btn ${captionStyle === 'standard' ? 'btn-primary' : 'btn-ghost'}`}
            disabled={busy}
            onClick={() => setCaptionStyle('standard')}
          >
            标准文案
          </button>
          <button
            type="button"
            className={`btn ${captionStyle === 'twitterComment' ? 'btn-primary' : 'btn-ghost'}`}
            disabled={busy}
            onClick={() => setCaptionStyle('twitterComment')}
            title="第一人称浓缩诱惑：舔脚/摸摸我等，无#标签，默认繁体"
          >
            推特评论·诱惑
          </button>
        </div>
        <button type="button" className="btn btn-primary" disabled={busy || !items.length} onClick={() => void onGenerate()}>
          {busy ? '生成中…' : '生成文案'}
        </button>
        <button type="button" className="btn" disabled={!caption} onClick={() => void onCopy()}>
          复制全文
        </button>
        <button type="button" className="btn" disabled={!caption.trim()} onClick={toggleScript}>
          {scriptMode === 'hant' ? '切回简体' : '一键繁体'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={clearAll}>
          清空
        </button>
        <button
          type="button"
          className="btn btn-tgauto"
          disabled={busy || tgBatchBusy}
          title="扫描下载目录「推特资源」→ 按角色分类 → Lovemi 文案 → TGAuto 相册群发"
          onClick={() => {
            setShowTgPanel(true)
            void onTgautoBatch()
          }}
        >
          {tgBatchBusy ? 'TGAuto 群发中…' : '◈ TGAuto · 推特资源一键群发'}
        </button>
        {tgBatchBusy ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setTgLog((prev) => [...prev.slice(-80), '正在取消群发（中断当前请求）…'])
              setToast('正在取消…')
              void window.lovemi?.tgautoBatchCancel?.().then(() => {
                setTgBatchBusy(false)
              })
            }}
          >
            取消群发
          </button>
        ) : null}
      </div>

      {showTgPanel ? (
        <div className="tgauto-batch-panel" data-motion="card">
          <h3>TGAuto 一键群发（与上方「粘贴生成」独立）</h3>
          <p className="settings-hint" style={{ margin: '0 0 10px' }}>
            自动扫描推特资源里每个角色的 jpg+mp4，生成 Lovemi 标准文案，用转发号轮流发相册。发送成功会把文件名加上「_已发送」。
            FLOOD 冷却号会本轮跳过。点「取消群发」会立刻中断当前请求。
          </p>
          <div className="toolbar" style={{ flexWrap: 'wrap', gap: 10, margin: 0 }}>
            <label className="chip" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              TGAuto
              <input
                className="field"
                style={{ width: 200 }}
                value={tgBaseUrl}
                disabled={tgBatchBusy}
                onChange={(e) => setTgBaseUrl(e.target.value)}
                placeholder="http://127.0.0.1:8788"
              />
            </label>
            <label className="chip" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              目标频道
              <input
                className="field"
                style={{ width: 160 }}
                value={tgPeer}
                disabled={tgBatchBusy}
                onChange={(e) => setTgPeer(e.target.value)}
                placeholder="kindredaiav1"
              />
            </label>
            <label className="chip" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={tgSkipPosted}
                disabled={tgBatchBusy}
                onChange={(e) => setTgSkipPosted(e.target.checked)}
              />
              跳过已发
            </label>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={tgBatchBusy}
              onClick={() => void refreshTgPreview()}
            >
              刷新预览
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={tgBatchBusy}
              onClick={() => {
                void (async () => {
                  const api = window.lovemi
                  if (!api?.tgautoHealth) {
                    setToast('请在 Electron 桌面窗口操作')
                    return
                  }
                  const baseUrl = tgBaseUrl.trim() || 'http://127.0.0.1:8788'
                  setToast('正在检测 TGAuto…')
                  const health = await api.tgautoHealth({ baseUrl })
                  if (health.ok) {
                    setTgLog((prev) => [...prev.slice(-80), `TGAuto 已连接：${health.baseUrl}`])
                    window.alert(`已连接到 TGAuto\n\n地址：${health.baseUrl}`)
                    setToast('TGAuto 已连接')
                  } else {
                    const reason = health.error || '未知错误'
                    setTgLog((prev) => [...prev.slice(-80), `未连接 TGAuto：${reason}`])
                    window.alert(`未连接到 TGAuto\n\n地址：${health.baseUrl}\n原因：${reason}`)
                    setToast('未连接 TGAuto')
                  }
                })()
              }}
            >
              检测连接
            </button>
          </div>
          {tgPreview ? <div className="settings-hint" style={{ marginTop: 8 }}>{tgPreview}</div> : null}
          {tgLog.length ? <div className="tgauto-batch-log">{tgLog.join('\n')}</div> : null}
        </div>
      ) : null}

      <div
        className="card-grid"
        style={{ gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12, marginBottom: 12 }}
      >
        <div className="settings-card" data-motion="card">
          <div className="settings-card-head">
            素材（Ctrl+V / 拖拽）· {items.length}/{MAX_MEDIA}
          </div>
          <div
            tabIndex={0}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const files = Array.from(e.dataTransfer.files || []).filter(
                (f) => f.type.startsWith('image/') || f.type.startsWith('video/'),
              )
              void (async () => {
                for (const f of files.slice(0, MAX_MEDIA)) await ingestFile(f)
              })()
            }}
            style={{
              minHeight: 280,
              border: '1px dashed var(--line)',
              borderRadius: 12,
              display: 'grid',
              gridTemplateColumns: items.length > 1 ? '1fr 1fr' : '1fr',
              gap: 10,
              padding: 10,
              background: 'var(--panel-2, transparent)',
              alignItems: 'stretch',
            }}
          >
            {items.length === 0 ? (
              <div className="empty" style={{ textAlign: 'center', padding: 24, gridColumn: '1 / -1' }}>
                可粘贴最多 {MAX_MEDIA} 个图片/视频
                <br />
                例如：立绘 + 动态视频一起生成文案
              </div>
            ) : (
              items.map((it, idx) => (
                <div
                  key={it.id}
                  style={{
                    position: 'relative',
                    borderRadius: 10,
                    overflow: 'hidden',
                    border: '1px solid var(--line)',
                    background: 'var(--panel, #111)',
                    display: 'flex',
                    flexDirection: 'column',
                    minHeight: 200,
                  }}
                >
                  <div className="settings-hint" style={{ padding: '6px 8px' }}>
                    #{idx + 1} · {it.kind === 'video' ? `视频 · ${it.frames.length}帧` : '图片'} ·{' '}
                    {it.fileName.length > 28 ? `${it.fileName.slice(0, 28)}…` : it.fileName}
                  </div>
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {it.kind === 'video' ? (
                      <video
                        src={it.previewUrl}
                        controls
                        style={{ maxWidth: '100%', maxHeight: 280, borderRadius: 6 }}
                      />
                    ) : (
                      <img
                        src={it.previewUrl}
                        alt={`ref-${idx + 1}`}
                        style={{ maxWidth: '100%', maxHeight: 280, borderRadius: 6 }}
                      />
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ margin: 8, alignSelf: 'flex-end' }}
                    onClick={() => removeItem(it.id)}
                  >
                    移除
                  </button>
                </div>
              ))
            )}
          </div>
          {items.length < MAX_MEDIA ? (
            <div className="settings-hint" style={{ marginTop: 8 }}>
              还可再贴 {MAX_MEDIA - items.length} 个素材
            </div>
          ) : (
            <div className="settings-hint" style={{ marginTop: 8 }}>
              已满 {MAX_MEDIA} 个；再粘贴会替换最早的那个
            </div>
          )}
          <label style={{ display: 'block', marginTop: 10 }}>
            <div className="settings-hint" style={{ marginBottom: 6 }}>补充提示（可选）</div>
            <textarea
              className="field"
              rows={3}
              style={{ width: '100%', resize: 'vertical' }}
              value={userHint}
              onChange={(e) => setUserHint(e.target.value)}
              placeholder={
              captionStyle === 'twitterComment'
                ? '例如：更爱SM/束缚、脚趾舔干净、吃脚脚、再短一点…'
                : '例如：兔耳、扑克、红布、点蜡烛、更娇嗔一点…'
            }            />
          </label>
        </div>

        <div className="settings-card" data-motion="card">
          <div className="settings-card-head">
            {captionStyle === 'twitterComment' ? '推特评论·诱惑预览' : '标准文案预览'}
            {meta ? ` · ${meta}` : ''}
            {caption ? ` · ${scriptMode === 'hant' ? '繁体' : '简体'}` : ''}
          </div>
          <textarea
            className="field"
            value={caption}
            onChange={(e) => {
              const v = e.target.value
              setCaption(v)
              if (scriptMode === 'hans') captionHansRef.current = v
            }}
            placeholder={
              captionStyle === 'twitterComment'
                ? '生成後單行（繁體）：寶寶們我是xxx，我特別喜歡被舔腳腳的感覺，有沒有哥哥來聊聊天，我給他吃腳腳'
                : '生成后这里会保留全部换行，可再手改再复制；可一键切繁体'
            }            spellCheck={false}
            style={{
              width: '100%',
              minHeight: 420,
              resize: 'vertical',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 13,
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
            }}
          />
        </div>
      </div>
    </section>
  )
}
