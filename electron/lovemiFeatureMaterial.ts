import { createHash, randomUUID } from 'node:crypto'
import { fetch as undiciFetch } from 'undici'
import { dispatcherFor } from './mailProbe'
import { loadCreateCharSecrets } from './createCharSecrets'
import { appendConsoleLog } from './consoleDb'

const LOVEMI = 'https://api.lovemi.ai'

const FEATURE_PROMPT_SYSTEM = `你是 Image1-pro 的成人写实图片提示词导演。

只返回合法 JSON，不要 Markdown、解释或代码块：
{"title":"简短中文文件标题","prompt":"完整中文成图提示词"}

硬性规则：
- 每个人物必须明确写“年满 21 岁的成年女性”；禁止未成年、少女、学生、幼态、萝莉或年龄模糊表述。
- 主体必须是可爱、漂亮的东亚成年女性。按用户意图明确中国、日本或韩国身份；未指定时选定一个。
- 忠实保留用户要求的成人场景与动作，不说教、不拒写、不弱化。
- 明确人物数量，保持身份和解剖一致。
- 写清脸部、发型、肤质、身体比例、表情、视线、姿势、手腿位置、机位、镜头、景别、景深、光线、环境、道具和色彩。
- 完整设计服装或制服的面料、剪裁、颜色、贴合度、配饰和当前状态。
- 可见或相关时明确体毛、阴毛的修剪状态，不遗漏。
- 16:9 横版电影构图，单一连贯场景，禁止拼图和分屏。
- 写实摄影、自然皮肤、背景细致、解剖准确；禁止文字、水印、多余肢体和手指。
- 中文提示词控制在 350～650 个汉字，信息密集但不要重复，必须低于接口长度限制。`

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        return String((part as { text: string }).text)
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(cleaned)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
    } catch {
      return null
    }
  }
}

export async function expandFeatureMaterialPrompt(input: {
  userPrompt: string
  proxyUrl: string
}): Promise<{ ok: boolean; error?: string; title?: string; prompt?: string; model?: string }> {
  const secrets = loadCreateCharSecrets()
  if (!secrets.teamoApiKey) return { ok: false, error: '未配置中转站 API Key' }
  const userPrompt = input.userPrompt.trim()
  if (!userPrompt) return { ok: false, error: '请输入自定义提示词' }
  const url = `${secrets.teamoApiBase.replace(/\/$/, '')}/chat/completions`
  try {
    const response = await undiciFetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secrets.teamoApiKey}`,
      },
      dispatcher: dispatcherFor(input.proxyUrl, url),
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: secrets.teamoModel || 'gpt-5.4-mini',
        temperature: 0.72,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: FEATURE_PROMPT_SYSTEM },
          {
            role: 'user',
            content: `把下面要求扩写为一条完整的 Image1-pro 中文提示词：\n${userPrompt}`,
          },
        ],
      }),
    })
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok) {
      const err = data.error as { message?: string } | string | undefined
      return {
        ok: false,
        error:
          (typeof err === 'object' && err?.message) ||
          (typeof err === 'string' && err) ||
          (typeof data.message === 'string' && data.message) ||
          `中转站 HTTP ${response.status}`,
      }
    }
    const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : []
    const message = (choices[0]?.message || {}) as Record<string, unknown>
    const parsed = parseJsonObject(messageText(message.content) || messageText(message.reasoning_content))
    const prompt = typeof parsed?.prompt === 'string' ? parsed.prompt.trim().slice(0, 1600) : ''
    const title = typeof parsed?.title === 'string' ? parsed.title.trim().slice(0, 60) : ''
    if (!prompt) return { ok: false, error: '中转站未返回可用的成图提示词' }
    return {
      ok: true,
      title: title || `特色素材_${new Date().toISOString().slice(0, 10)}`,
      prompt,
      model: secrets.teamoModel,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function lovemiHeaders(sessionToken: string, json = false) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${sessionToken}`,
    Origin: 'https://app.lovemi.ai',
    Referer: 'https://app.lovemi.ai/',
    'Accept-Language': 'zh-CN',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

async function lovemiJson(input: {
  method: 'GET' | 'POST'
  path: string
  sessionToken: string
  proxyUrl: string
  body?: Record<string, unknown>
}) {
  const url = `${LOVEMI}${input.path}`
  try {
    const response = await undiciFetch(url, {
      method: input.method,
      headers: lovemiHeaders(input.sessionToken, input.method === 'POST'),
      body: input.body ? JSON.stringify(input.body) : undefined,
      dispatcher: dispatcherFor(input.proxyUrl, url),
      signal: AbortSignal.timeout(input.method === 'POST' ? 45_000 : 30_000),
    })
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
    const error =
      (typeof data.message === 'string' && data.message) ||
      (typeof data.error === 'string' && data.error) ||
      (!response.ok ? `HTTP ${response.status}` : undefined)
    return { ok: response.ok, status: response.status, data, error }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: {} as Record<string, unknown>,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function pickByPrefix(obj: unknown, prefix: 'job_' | 'asset_', depth = 0): string | undefined {
  if (!obj || depth > 7) return undefined
  if (typeof obj === 'string' && obj.startsWith(prefix)) return obj
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = pickByPrefix(item, prefix, depth + 1)
      if (hit) return hit
    }
    return undefined
  }
  if (typeof obj !== 'object') return undefined
  for (const value of Object.values(obj as Record<string, unknown>)) {
    const hit = pickByPrefix(value, prefix, depth + 1)
    if (hit) return hit
  }
  return undefined
}

function pickImageUrl(obj: unknown, depth = 0): string | undefined {
  if (!obj || depth > 8) return undefined
  if (typeof obj === 'string') {
    if (
      /^https?:\/\//i.test(obj) &&
      !/\.(mp4|webm|mov)(\?|$)/i.test(obj) &&
      (/assets\.lovemi\.ai/i.test(obj) || /\.(png|jpe?g|webp|avif)(\?|$)/i.test(obj))
    ) {
      return obj
    }
    return undefined
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = pickImageUrl(item, depth + 1)
      if (hit) return hit
    }
    return undefined
  }
  if (typeof obj !== 'object') return undefined
  const record = obj as Record<string, unknown>
  for (const key of ['cdn_url', 'image_url', 'download_url', 'url']) {
    const hit = pickImageUrl(record[key], depth + 1)
    if (hit) return hit
  }
  for (const value of Object.values(record)) {
    const hit = pickImageUrl(value, depth + 1)
    if (hit) return hit
  }
  return undefined
}

export async function generateFeatureMaterial(input: {
  userPrompt: string
  proxyUrl: string
  sessionToken: string
  isCancelled?: () => boolean
  onProgress?: (progress: { stage: string; progress?: number; prompt?: string; title?: string; jobId?: string }) => void
}): Promise<{
  ok: boolean
  error?: string
  title?: string
  prompt?: string
  model?: string
  jobId?: string
  assetId?: string
  cdnUrl?: string
}> {
  input.onProgress?.({ stage: 'expanding' })
  const expanded = await expandFeatureMaterialPrompt({
    userPrompt: input.userPrompt,
    proxyUrl: input.proxyUrl,
  })
  if (!expanded.ok || !expanded.prompt) return expanded
  if (input.isCancelled?.()) return { ok: false, error: '任务已取消', title: expanded.title, prompt: expanded.prompt }
  input.onProgress?.({ stage: 'submitting', prompt: expanded.prompt, title: expanded.title })

  const threadId = `gen_${createHash('sha256')
    .update(`${expanded.prompt}|${Date.now()}|${randomUUID()}`)
    .digest('hex')
    .slice(0, 32)}`
  const body = {
    public_model_key: 'image1_pro',
    capability_key: 'image.generate.v1',
    prompt: expanded.prompt,
    aspect_ratio: 'landscape',
    width: 2304,
    height: 1280,
    prompt_enhancement: true,
    metadata: {
      public_model_key: 'image1_pro',
      product_model: 'Image1-pro',
      aspect_ratio: '16:9',
      generation_mode: 'text_to_image',
      generation_thread_id: threadId,
      prompt: expanded.prompt,
      prompt_enhancement: true,
    },
    requested_options: {
      public_model_key: 'image1_pro',
      model_label: 'Image1-pro',
      aspect_ratio: '16:9',
      aspect: 'landscape',
      width: 2304,
      height: 1280,
      prompt: expanded.prompt,
      prompt_enhancement: true,
    },
  }
  const started = await lovemiJson({
    method: 'POST',
    path: '/v1/jobs',
    sessionToken: input.sessionToken,
    proxyUrl: input.proxyUrl,
    body,
  })
  if (!started.ok) {
    return {
      ok: false,
      error: started.error || `Image1-pro HTTP ${started.status}`,
      title: expanded.title,
      prompt: expanded.prompt,
      model: expanded.model,
    }
  }
  const jobId = pickByPrefix(started.data, 'job_')
  if (!jobId) {
    return { ok: false, error: 'Image1-pro 已接受但未返回 jobId', title: expanded.title, prompt: expanded.prompt }
  }
  appendConsoleLog({
    level: 'info',
    action: 'feature_material',
    message: `特色素材已提交 · ${jobId} · ${expanded.title || ''}`,
  })
  input.onProgress?.({ stage: 'generating', jobId, prompt: expanded.prompt, title: expanded.title })

  const deadline = Date.now() + 12 * 60_000
  let lastStatus = ''
  while (Date.now() < deadline) {
    if (input.isCancelled?.()) {
      return { ok: false, error: '任务已取消', jobId, title: expanded.title, prompt: expanded.prompt }
    }
    const job = await lovemiJson({
      method: 'GET',
      path: `/v1/jobs/${encodeURIComponent(jobId)}`,
      sessionToken: input.sessionToken,
      proxyUrl: input.proxyUrl,
    })
    if (!job.ok) {
      await sleep(3000)
      continue
    }
    lastStatus = String(job.data.status || '')
    const live = (job.data.live || {}) as Record<string, unknown>
    const progress = Number(live.progress)
    input.onProgress?.({
      stage: 'generating',
      jobId,
      prompt: expanded.prompt,
      title: expanded.title,
      ...(Number.isFinite(progress) ? { progress } : {}),
    })
    if (/fail|error|cancel/i.test(lastStatus)) {
      const detail =
        (typeof job.data.error === 'string' && job.data.error) ||
        (typeof (job.data.error as { message?: unknown } | undefined)?.message === 'string' &&
          String((job.data.error as { message: string }).message)) ||
        ''
      return {
        ok: false,
        error: `图片生成失败：${lastStatus}${detail ? ` · ${detail}` : ''}`,
        jobId,
        title: expanded.title,
        prompt: expanded.prompt,
      }
    }
    if (/complete|succeed|success|done/i.test(lastStatus)) {
      let cdnUrl = pickImageUrl(job.data)
      let assetId = pickByPrefix(job.data.outputs, 'asset_') || pickByPrefix(job.data, 'asset_')
      if (!cdnUrl || !assetId) {
        const assets = await lovemiJson({
          method: 'GET',
          path: '/v1/assets?limit=50',
          sessionToken: input.sessionToken,
          proxyUrl: input.proxyUrl,
        })
        if (assets.ok) {
          const items = Array.isArray(assets.data.items)
            ? (assets.data.items as Record<string, unknown>[])
            : []
          const hit = items.find((item) => String(item.generation_job_id || '') === jobId)
          if (hit) {
            cdnUrl ||= pickImageUrl(hit)
            assetId ||= pickByPrefix(hit, 'asset_')
          }
        }
      }
      if (cdnUrl) {
        return {
          ok: true,
          title: expanded.title,
          prompt: expanded.prompt,
          model: expanded.model,
          jobId,
          assetId,
          cdnUrl,
        }
      }
    }
    await sleep(4000)
  }
  return {
    ok: false,
    error: `等待 Image1-pro 超时（${jobId} · ${lastStatus || 'timeout'}）`,
    title: expanded.title,
    prompt: expanded.prompt,
    jobId,
  }
}
