import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { MediaLightbox } from '../components/MediaLightbox'
import { runEmailPageEnter } from '../motion/timelines'
import { useSettingsStore } from '../store/settingsStore'

type FeatureTask = {
  runId: string
  userPrompt: string
  stage: string
  queuePosition: number
  progress?: number
  title?: string
  prompt?: string
  detail?: string
  jobId?: string
  error?: string
  imageUrl?: string
  localPath?: string
  twitterPath?: string
  watermarkApplied?: boolean
  createdAt: number
}

type FeatureConfig = {
  hasApiKey: boolean
  hasAdminToken: boolean
  apiKeyMask: string
  adminTokenMask: string
  autoDownloadWatermark: boolean
  downloadsDir: string
  featureAspectRatio: string
  featureImageMp: number
  featureAspectOptions: string[]
  featureMpOptions: number[]
  teamoApiBase: string
  teamoModel: string
}

const STAGE_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '准备中',
  expanding: 'GPT 正在写超详细提示词',
  submitting: '正在提交 Image1-pro',
  generating: 'Image1-pro 生成中',
  completed: '已完成并下载',
  failed: '生成失败',
  cancelled: '已取消',
}

const DEFAULT_ASPECTS = ['4:5', '5:4', '9:16', '16:9', '1:1']
const DEFAULT_MPS = [1, 1.5, 2, 2.5, 3]

async function resolveProxyUrl() {
  const settings = useSettingsStore.getState()
  if (!window.lovemi?.resolveMailProxy) {
    return { proxyUrl: undefined as string | undefined, error: '请在 Electron 中运行' }
  }
  const result = await window.lovemi.resolveMailProxy({
    vlessEnabled: settings.urlProxyEnabled && settings.mailProxyRoute === 'vless',
    subscriptionUrl: settings.urlProxy,
    localEnabled: settings.localProxyEnabled,
    localHost: settings.localProxyHost,
    localPort: settings.localProxyPort,
  })
  return { proxyUrl: result.proxyUrl, error: result.error }
}

function recordToTask(item: {
  runId: string
  userPrompt: string
  stage: string
  title?: string
  prompt?: string
  detail?: string
  jobId?: string
  error?: string
  cacheUrl?: string
  cdnUrl?: string
  localPath?: string
  twitterPath?: string
  watermarkApplied?: boolean
  createdAt: number
}): FeatureTask {
  return {
    runId: item.runId,
    userPrompt: item.userPrompt,
    stage: item.stage || 'completed',
    queuePosition: 0,
    title: item.title,
    prompt: item.prompt,
    detail: item.detail,
    jobId: item.jobId,
    error: item.error,
    imageUrl: item.cacheUrl || item.cdnUrl,
    localPath: item.localPath,
    twitterPath: item.twitterPath,
    watermarkApplied: item.watermarkApplied,
    createdAt: item.createdAt || Date.now(),
  }
}

function applyPublicConfig(
  value: Awaited<ReturnType<NonNullable<typeof window.lovemi>['createCharConfig']>>,
): FeatureConfig {
  return {
    hasApiKey: value.hasApiKey,
    hasAdminToken: value.hasAdminToken,
    apiKeyMask: value.apiKeyMask || '',
    adminTokenMask: value.adminTokenMask || '',
    autoDownloadWatermark: value.autoDownloadWatermark !== false,
    downloadsDir: value.downloadsDir || '',
    featureAspectRatio: value.featureAspectRatio || '16:9',
    featureImageMp: Number(value.featureImageMp) || 3,
    featureAspectOptions: value.featureAspectOptions?.length
      ? value.featureAspectOptions
      : DEFAULT_ASPECTS,
    featureMpOptions: value.featureMpOptions?.length ? value.featureMpOptions : DEFAULT_MPS,
    teamoApiBase: value.teamoApiBase || 'https://api.teamorouter.com/v1',
    teamoModel: value.teamoModel || 'gpt-5.4-mini',
  }
}

/** 预估分辨率（与主进程 featureImageSize 一致，用于 UI 提示） */
function estimateSize(aspect: string, mp: number) {
  const known: Record<string, { w: number; h: number }> = {
    '16:9@3': { w: 2304, h: 1280 },
    '9:16@2': { w: 1088, h: 1920 },
    '1:1@2': { w: 1408, h: 1408 },
    '4:5@2': { w: 1280, h: 1600 },
    '5:4@2': { w: 1600, h: 1280 },
  }
  const hit = known[`${aspect}@${mp}`]
  if (hit) return hit
  const [aw, ah] = aspect.split(':').map(Number)
  if (!aw || !ah) return { w: 0, h: 0 }
  const round64 = (n: number) => Math.max(64, Math.round(n / 64) * 64)
  let w = round64(Math.sqrt(mp * 1_000_000 * (aw / ah)))
  let h = round64((w * ah) / aw)
  if (aw < ah) {
    h = round64(Math.sqrt(mp * 1_000_000 * (ah / aw)))
    w = round64((h * aw) / ah)
  }
  return { w, h }
}

export function FeatureMaterialPage({ active }: { active: boolean }) {
  const pageRef = useRef<HTMLElement>(null)
  const [userPrompt, setUserPrompt] = useState('')
  const [tasks, setTasks] = useState<FeatureTask[]>([])
  const [notice, setNotice] = useState('')
  const [lightbox, setLightbox] = useState('')
  const [adminTokenInput, setAdminTokenInput] = useState('')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [config, setConfig] = useState<FeatureConfig>({
    hasApiKey: false,
    hasAdminToken: false,
    apiKeyMask: '',
    adminTokenMask: '',
    autoDownloadWatermark: true,
    downloadsDir: '',
    featureAspectRatio: '16:9',
    featureImageMp: 3,
    featureAspectOptions: DEFAULT_ASPECTS,
    featureMpOptions: DEFAULT_MPS,
    teamoApiBase: 'https://api.teamorouter.com/v1',
    teamoModel: 'gpt-5.4-mini',
  })

  const sizeHint = useMemo(
    () => estimateSize(config.featureAspectRatio, config.featureImageMp),
    [config.featureAspectRatio, config.featureImageMp],
  )

  const refreshConfig = async () => {
    const value = await window.lovemi?.createCharConfig?.()
    if (!value) return
    setConfig(applyPublicConfig(value))
  }

  useEffect(() => {
    if (active && pageRef.current) runEmailPageEnter(pageRef.current)
  }, [active])

  useEffect(() => {
    if (!active) return
    void refreshConfig()
    void window.lovemi?.featureMaterialList?.().then((res) => {
      if (!res?.ok || !Array.isArray(res.items)) return
      setTasks(res.items.map(recordToTask))
    })
  }, [active])

  useEffect(() => {
    if (!window.lovemi?.onFeatureMaterialProgress) return
    return window.lovemi.onFeatureMaterialProgress((progress) => {
      setTasks((current) => {
        const exists = current.some((task) => task.runId === progress.runId)
        if (!exists) {
          return [
            {
              runId: progress.runId,
              userPrompt: '',
              stage: progress.stage || 'running',
              queuePosition: progress.queuePosition || 0,
              progress: progress.progress,
              title: progress.title,
              prompt: progress.prompt,
              detail: progress.detail,
              jobId: progress.jobId,
              error: progress.error,
              imageUrl: progress.cacheUrl || progress.cdnUrl,
              twitterPath: progress.twitterPath,
              watermarkApplied: progress.watermarkApplied,
              createdAt: progress.runStartedAt || Date.now(),
            },
            ...current,
          ].slice(0, 80)
        }
        return current.map((task) =>
          task.runId === progress.runId
            ? {
                ...task,
                stage: progress.stage || task.stage,
                queuePosition:
                  typeof progress.queuePosition === 'number'
                    ? progress.queuePosition
                    : task.queuePosition,
                progress:
                  typeof progress.progress === 'number' ? progress.progress : task.progress,
                title: progress.title || task.title,
                prompt: progress.prompt || task.prompt,
                detail: progress.detail || task.detail,
                jobId: progress.jobId || task.jobId,
                error: progress.error || task.error,
                imageUrl: progress.cacheUrl || progress.cdnUrl || task.imageUrl,
                twitterPath: progress.twitterPath || task.twitterPath,
                watermarkApplied:
                  typeof progress.watermarkApplied === 'boolean'
                    ? progress.watermarkApplied
                    : task.watermarkApplied,
              }
            : task,
        )
      })
    })
  }, [])

  const persistConfig = async (
    patch: Parameters<NonNullable<typeof window.lovemi>['createCharSaveConfig']>[0],
    okMessage?: string,
  ) => {
    const cfg = await window.lovemi?.createCharSaveConfig?.(patch)
    if (!cfg) {
      setNotice('自动保存失败：请在 Electron 桌面窗口操作')
      return null
    }
    setConfig(applyPublicConfig(cfg))
    if (okMessage) setNotice(okMessage)
    return cfg
  }

  const autoSaveSecrets = async () => {
    const patch: {
      teamoApiKey?: string
      adminSessionToken?: string
      teamoApiBase?: string
      teamoModel?: string
    } = {
      teamoApiBase: config.teamoApiBase,
      teamoModel: config.teamoModel,
    }
    if (apiKeyInput.trim()) patch.teamoApiKey = apiKeyInput.trim()
    if (adminTokenInput.trim()) patch.adminSessionToken = adminTokenInput.trim()
    if (!patch.teamoApiKey && !patch.adminSessionToken) return
    const cfg = await persistConfig(patch)
    if (!cfg) return
    setApiKeyInput('')
    setAdminTokenInput('')
    const parts = [
      cfg.hasApiKey ? `API Key ${cfg.apiKeyMask || '已保存'}` : '缺 API Key',
      cfg.hasAdminToken ? `Bearer ${cfg.adminTokenMask || '已保存'}` : '缺 Bearer',
    ]
    setNotice(`已自动保存 · ${parts.join(' · ')}`)
  }

  const setAspect = (aspect: string) => {
    setConfig((c) => ({ ...c, featureAspectRatio: aspect }))
    void persistConfig(
      { featureAspectRatio: aspect },
      `已自动保存宽高比 ${aspect}`,
    )
  }

  const setMp = (mp: number) => {
    setConfig((c) => ({ ...c, featureImageMp: mp }))
    void persistConfig({ featureImageMp: mp }, `已自动保存画质 ${mp} MP`)
  }

  const setWatermark = (next: boolean) => {
    setConfig((c) => ({ ...c, autoDownloadWatermark: next }))
    void persistConfig(
      { autoDownloadWatermark: next },
      next ? '已开启：下载时敲粉色水印' : '已关闭敲水印：将直接下载原图到推特资源',
    )
  }

  const submit = async () => {
    const prompt = userPrompt.trim()
    if (!prompt) {
      setNotice('先输入想要的特色素材场景')
      return
    }
    // 提交前若输入框有新密钥，先自动保存
    if (apiKeyInput.trim() || adminTokenInput.trim()) {
      await autoSaveSecrets()
    }
    const latest = await window.lovemi?.createCharConfig?.()
    if (latest) setConfig(applyPublicConfig(latest))
    if (!latest?.hasApiKey || !latest?.hasAdminToken) {
      setNotice('请先填写并保存中转站 API Key 和管理员 Bearer（粘贴后失焦即自动保存）')
      return
    }
    if (!window.lovemi?.featureMaterialEnqueue) {
      setNotice('请在 Electron 桌面窗口操作')
      return
    }
    const outbound = await resolveProxyUrl()
    if (!outbound.proxyUrl) {
      setNotice(outbound.error || '没有可用代理')
      return
    }
    const runId = crypto.randomUUID()
    const task: FeatureTask = {
      runId,
      userPrompt: prompt,
      stage: 'queued',
      queuePosition: 1,
      createdAt: Date.now(),
    }
    setTasks((current) => [task, ...current].slice(0, 80))
    setUserPrompt('')
    setNotice(
      `已加入队列 · ${config.featureAspectRatio} · ${config.featureImageMp}MP · ${sizeHint.w}×${sizeHint.h}`,
    )
    const result = await window.lovemi.featureMaterialEnqueue({
      runId,
      userPrompt: prompt,
      proxyUrl: outbound.proxyUrl,
      aspectRatio: config.featureAspectRatio,
      imageMp: config.featureImageMp,
    })
    setTasks((current) =>
      current.map((item) =>
        item.runId === runId
          ? {
              ...item,
              stage: result.ok ? 'completed' : result.cancelled ? 'cancelled' : 'failed',
              queuePosition: 0,
              title: result.title || item.title,
              prompt: result.prompt || item.prompt,
              detail: result.detail || item.detail,
              jobId: result.jobId || item.jobId,
              error: result.error,
              imageUrl: result.cacheUrl || result.cdnUrl || item.imageUrl,
              localPath: result.localPath || item.localPath,
              twitterPath: result.twitterPath || item.twitterPath,
              watermarkApplied:
                typeof result.watermarkApplied === 'boolean'
                  ? result.watermarkApplied
                  : item.watermarkApplied,
            }
          : item,
      ),
    )
    setNotice(
      result.ok
        ? config.autoDownloadWatermark
          ? `图片已完成（${result.width || sizeHint.w}×${result.height || sizeHint.h}），已下载含水印`
          : `图片已完成（${result.width || sizeHint.w}×${result.height || sizeHint.h}），已下载原图`
        : result.cancelled
          ? '任务已取消'
          : `生成失败：${result.error || '未知错误'}`,
    )
  }

  const cancel = async (runId: string) => {
    await window.lovemi?.featureMaterialCancel?.({ runId })
    setTasks((current) =>
      current.map((task) =>
        task.runId === runId ? { ...task, stage: 'cancelled', queuePosition: 0 } : task,
      ),
    )
  }

  const remove = async (runId: string) => {
    const res = await window.lovemi?.featureMaterialDelete?.({ runId })
    if (!res?.ok) {
      setNotice(res?.error || '删除失败')
      return
    }
    setTasks((current) => current.filter((task) => task.runId !== runId))
    setNotice('已从本地数据库删除（含预览缓存与推特资源文件）')
  }

  const selectBtn = (activeBtn: boolean): CSSProperties => ({
    minWidth: 64,
    padding: '8px 12px',
    borderRadius: 10,
    border: activeBtn ? '1px solid rgba(255,255,255,.55)' : '1px solid var(--line)',
    background: activeBtn ? 'rgba(255,255,255,.12)' : 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 13,
  })

  return (
    <section className="email-page feature-material-page" ref={pageRef}>
      <h1 className="page-title">创建特色素材</h1>
      <p className="page-desc">
        可选官网宽高比与画质；GPT 扩写最长约 2000 字【高颜值软萌真人写真】提示词（美脸清晰、柔光水光肌、露骨动作不弱化）。多人只细写前景美脸。密钥失焦自动保存。
      </p>

      <div className="settings-card" data-motion="card" style={{ marginBottom: 12 }}>
        <div className="settings-card-head">密钥（本机自动保存）</div>
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 10 }}>
          <label className="chip" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            Bearer
            <input
              className="field"
              style={{ minWidth: 260 }}
              type="password"
              autoComplete="off"
              placeholder={
                config.hasAdminToken
                  ? `已保存 ${config.adminTokenMask || '****'} · 可粘贴替换`
                  : '粘贴管理员 Bearer'
              }
              value={adminTokenInput}
              onChange={(e) => setAdminTokenInput(e.target.value)}
              onBlur={() => void autoSaveSecrets()}
            />
          </label>
          <label className="chip" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            API Key
            <input
              className="field"
              style={{ minWidth: 220 }}
              type="password"
              autoComplete="off"
              placeholder={
                config.hasApiKey
                  ? `已保存 ${config.apiKeyMask || '****'} · 可粘贴替换`
                  : '粘贴中转站 API Key'
              }
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              onBlur={() => void autoSaveSecrets()}
            />
          </label>
        </div>
        <div className="settings-hint" style={{ marginTop: 8 }}>
          {config.hasApiKey
            ? `API Key 正常 · ${config.apiKeyMask || '已保存'}`
            : '缺中转站 API Key'}
          {' · '}
          {config.hasAdminToken
            ? `Bearer 正常 · ${config.adminTokenMask || '已保存'}`
            : '缺管理员 Bearer'}
          {' · 换机后需重新粘贴一次（加密密钥不能跨机器解密）'}
        </div>
      </div>

      <div className="settings-card" data-motion="card" style={{ marginBottom: 12 }}>
        <div className="settings-card-head">自定义场景</div>
        <textarea
          className="field"
          value={userPrompt}
          onChange={(event) => setUserPrompt(event.target.value)}
          placeholder="例如：10 个日本成年美女在高级酒店套房各自自慰，每人发型/表情/阴毛/足部都不同，萌可爱写实……"
          rows={5}
          style={{ width: '100%', resize: 'vertical', fontSize: 14, lineHeight: 1.6 }}
        />

        <div style={{ marginTop: 12 }}>
          <div className="settings-hint" style={{ marginBottom: 8 }}>
            宽高比
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {config.featureAspectOptions.map((aspect) => (
              <button
                key={aspect}
                type="button"
                style={selectBtn(config.featureAspectRatio === aspect)}
                onClick={() => setAspect(aspect)}
              >
                {aspect}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <div className="settings-hint" style={{ marginBottom: 8 }}>
            图片画质
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {config.featureMpOptions.map((mp) => (
              <button
                key={mp}
                type="button"
                style={selectBtn(config.featureImageMp === mp)}
                onClick={() => setMp(mp)}
              >
                {mp} MP
              </button>
            ))}
          </div>
          <div className="settings-hint" style={{ marginTop: 8 }}>
            每次生成 1 张 · 按所选画质计价 · 预计 {sizeHint.w}×{sizeHint.h}
          </div>
        </div>

        <div className="toolbar" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" onClick={() => void submit()}>
            加入图片生成队列
          </button>
          <span className="chip">
            Image1-pro · {config.featureAspectRatio} · {config.featureImageMp}MP · {sizeHint.w}×
            {sizeHint.h}
          </span>
          <span className="chip">自动下载：开</span>
          <label className="chip" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={config.autoDownloadWatermark}
              onChange={(e) => setWatermark(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            敲水印
          </label>
        </div>
        <div className="settings-hint" style={{ marginTop: 8 }}>
          下载到{' '}
          {config.downloadsDir ? `${config.downloadsDir}/推特资源` : '系统 Downloads/推特资源'}
          {' · '}
          {config.autoDownloadWatermark ? '导出时敲粉色水印' : '导出原图（不敲水印）'}
        </div>
        {notice ? <div className="settings-hint" style={{ marginTop: 8 }}>{notice}</div> : null}
      </div>

      <div className="settings-card" data-motion="card">
        <div className="settings-card-head">素材队列与结果</div>
        {tasks.length ? (
          <div style={{ display: 'grid', gap: 12 }}>
            {tasks.map((task) => {
              const live = !['completed', 'failed', 'cancelled'].includes(task.stage)
              return (
                <article
                  key={task.runId}
                  style={{
                    border: '1px solid var(--line)',
                    borderRadius: 12,
                    padding: 12,
                    display: 'grid',
                    gridTemplateColumns: task.imageUrl
                      ? 'minmax(220px, 0.8fr) minmax(280px, 1.2fr)'
                      : '1fr',
                    gap: 14,
                  }}
                >
                  {task.imageUrl ? (
                    <img
                      src={task.imageUrl}
                      alt={task.title || '特色素材'}
                      onClick={() => setLightbox(task.imageUrl!)}
                      style={{
                        width: '100%',
                        maxHeight: 320,
                        objectFit: 'contain',
                        borderRadius: 10,
                        cursor: 'zoom-in',
                        background: 'rgba(0,0,0,.18)',
                      }}
                    />
                  ) : null}
                  <div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                      <strong>{task.title || task.userPrompt.slice(0, 42) || '特色素材'}</strong>
                      <span className="chip">
                        {STAGE_LABELS[task.stage] || task.stage}
                        {task.stage === 'queued' ? ` · 第 ${task.queuePosition || 1} 位` : ''}
                        {typeof task.progress === 'number' ? ` · ${task.progress}%` : ''}
                      </span>
                      {live ? (
                        <button
                          type="button"
                          className="btn ghost"
                          style={{ fontSize: 12, padding: '4px 10px' }}
                          onClick={() => void cancel(task.runId)}
                        >
                          取消
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn ghost"
                          style={{ fontSize: 12, padding: '4px 10px' }}
                          onClick={() => void remove(task.runId)}
                        >
                          删除
                        </button>
                      )}
                    </div>
                    {task.userPrompt ? (
                      <div className="settings-hint" style={{ marginTop: 8 }}>
                        原始：{task.userPrompt}
                      </div>
                    ) : null}
                    {task.prompt ? (
                      <details style={{ marginTop: 8 }} open={live}>
                        <summary className="settings-hint" style={{ cursor: 'pointer' }}>
                          查看 GPT 提交提示词（{[...task.prompt].length} 字）
                        </summary>
                        <div
                          className="settings-hint"
                          style={{ marginTop: 8, whiteSpace: 'pre-wrap', lineHeight: 1.55 }}
                        >
                          {task.prompt}
                        </div>
                      </details>
                    ) : null}
                    {task.jobId ? (
                      <div className="settings-hint" style={{ marginTop: 8 }}>
                        {task.jobId}
                      </div>
                    ) : null}
                    {task.twitterPath ? (
                      <div className="settings-hint" style={{ marginTop: 8 }}>
                        已下载{task.watermarkApplied === false ? '原图' : '（含水印）'}：
                        {task.twitterPath}
                      </div>
                    ) : null}
                    {task.error ? (
                      <div style={{ marginTop: 8, color: 'var(--danger, #ff7895)' }}>{task.error}</div>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>
        ) : (
          <div className="empty">还没有特色素材任务</div>
        )}
      </div>
      {lightbox ? <MediaLightbox src={lightbox} onClose={() => setLightbox('')} /> : null}
    </section>
  )
}
