import { useEffect, useRef, useState } from 'react'
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

export function FeatureMaterialPage({ active }: { active: boolean }) {
  const pageRef = useRef<HTMLElement>(null)
  const [userPrompt, setUserPrompt] = useState('')
  const [tasks, setTasks] = useState<FeatureTask[]>([])
  const [notice, setNotice] = useState('')
  const [lightbox, setLightbox] = useState('')
  const [config, setConfig] = useState({
    hasApiKey: false,
    hasAdminToken: false,
    autoDownloadWatermark: true,
    downloadsDir: '',
  })

  useEffect(() => {
    if (active && pageRef.current) runEmailPageEnter(pageRef.current)
  }, [active])

  useEffect(() => {
    void window.lovemi?.createCharConfig?.().then((value) => {
      if (!value) return
      setConfig({
        hasApiKey: value.hasApiKey,
        hasAdminToken: value.hasAdminToken,
        autoDownloadWatermark: value.autoDownloadWatermark !== false,
        downloadsDir: value.downloadsDir || '',
      })
    })
    void window.lovemi?.featureMaterialList?.().then((res) => {
      if (!res?.ok || !Array.isArray(res.items)) return
      setTasks(res.items.map(recordToTask))
    })
  }, [])

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

  const setWatermark = (next: boolean) => {
    setConfig((c) => ({ ...c, autoDownloadWatermark: next }))
    void window.lovemi?.createCharSaveConfig?.({ autoDownloadWatermark: next }).then((cfg) => {
      if (!cfg) return
      setConfig((c) => ({
        ...c,
        autoDownloadWatermark: cfg.autoDownloadWatermark !== false,
        downloadsDir: cfg.downloadsDir || c.downloadsDir,
      }))
    })
    setNotice(next ? '已开启：下载时敲粉色水印' : '已关闭敲水印：将直接下载原图到推特资源')
  }

  const submit = async () => {
    const prompt = userPrompt.trim()
    if (!prompt) {
      setNotice('先输入想要的特色素材场景')
      return
    }
    if (!config.hasApiKey || !config.hasAdminToken) {
      setNotice('请先到「创建角色」保存中转站 API Key 和管理员 Bearer')
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
    setNotice('已加入特色素材独立队列')
    const result = await window.lovemi.featureMaterialEnqueue({
      runId,
      userPrompt: prompt,
      proxyUrl: outbound.proxyUrl,
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
          ? '图片已完成，已下载到推特资源（含水印）'
          : '图片已完成，已下载原图到推特资源（未敲水印）'
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

  return (
    <section className="email-page feature-material-page" ref={pageRef}>
      <h1 className="page-title">创建特色素材</h1>
      <p className="page-desc">
        输入场景意图后，GPT 会扩写成超详细【真人写实摄影】中文提示词（毛孔少磨皮、拒 AI 塑料脸、禁二次元/3D；多人逐人差异、足部等），再按官网
        Image1-pro body（16:9 · 2304×1280）提交。生图完成后自动下载；敲水印可单独开关。
      </p>

      <div className="settings-card" data-motion="card" style={{ marginBottom: 12 }}>
        <div className="settings-card-head">自定义场景</div>
        <textarea
          className="field"
          value={userPrompt}
          onChange={(event) => setUserPrompt(event.target.value)}
          placeholder="例如：10 个日本成年美女在高级酒店套房各自自慰，每人发型/表情/阴毛/足部都不同，萌可爱写实 16:9……"
          rows={5}
          style={{ width: '100%', resize: 'vertical', fontSize: 14, lineHeight: 1.6 }}
        />
        <div className="toolbar" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" onClick={() => void submit()}>
            加入图片生成队列
          </button>
          <span className="chip">Image1-pro · 2304×1280 · 16:9</span>
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
          {config.hasApiKey ? 'GPT 配置正常' : '缺中转站 API Key'}
          {' · '}
          {config.hasAdminToken ? 'Lovemi Bearer 正常' : '缺管理员 Bearer'}
          {' · 下载到 '}
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
                    gridTemplateColumns: task.imageUrl ? 'minmax(220px, 0.8fr) minmax(280px, 1.2fr)' : '1fr',
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
                    {task.jobId ? <div className="settings-hint" style={{ marginTop: 8 }}>{task.jobId}</div> : null}
                    {task.twitterPath ? (
                      <div className="settings-hint" style={{ marginTop: 8 }}>
                        已下载{task.watermarkApplied === false ? '原图' : '（含水印）'}：{task.twitterPath}
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
