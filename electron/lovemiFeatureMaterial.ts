import { fetch as undiciFetch } from 'undici'
import { dispatcherFor } from './mailProbe'
import { loadCreateCharSecrets } from './createCharSecrets'
import { appendConsoleLog } from './consoleDb'

const LOVEMI = 'https://api.lovemi.ai'
/** 官网 body 实测中文约 1000 字仍可 202；软上限留余量 */
const FEATURE_PROMPT_SOFT_MAX_CHARS = 900

const REALISM_LOCK =
  '写实锁死：必须像真人写真/cosplay实拍照片，自然光影与镜头景深，皮肤毛孔与细纹阴影可见，少磨皮，拒绝AI塑料脸与磨皮美颜，禁止二次元动画感、禁止3D渲染游戏CG、禁止卡通大眼。'

const FEATURE_PROMPT_SYSTEM = `你是 Image1-pro 成人【真人写实摄影】横版（16:9）提示词导演。第一优先级是「像相机拍出来的真人照片」，不是插画、不是二次元、不是3D角色渲染。

只返回合法 JSON，不要 Markdown、解释或代码块：
{"title":"简短中文文件标题（≤20字）","prompt":"完整中文成图提示词"}

硬性规则：
1) 每个人物必须明确年满 21 岁的成年女性；禁止未成年、少女、学生、幼态、萝莉或年龄模糊。
2) 主体是可爱漂亮的【真人东亚成年女性】（Chinese / Japanese / Korean 按用户意图；未指定则写死日本成年女性）。「萌可爱」= 真人可爱气质，绝不是二次元萌系画风。
3) 忠实保留用户成人场景与动作，不说教、不拒写、不弱化。用户没要求时：禁止擅自加人、禁止浮空岛/赛博幻想/太空云海等奇幻背景，优先真实室内外场景（酒店/卧室/浴室等）。
4) prompt 是提交给 Image1-pro 的中文正文，目标 650～900 汉字；信息密、可拍摄，不要散文，不要英文密种子。
5) 若用户提到多人（如 10 人），必须逐人编号写清差异，禁止「几个人差不多」：
   - 每人：脸型五官差异、发型发色、表情、身材、服装材质、姿势、手部、足部（脚趾/脚背/鞋袜或光脚）、阴毛浓密度与修剪（每人不同）、真实肤色与皮肤瑕疵层次。
6) 【写实去AI味 — 必须贯穿全文并在结尾再钉一次】必须出现并可执行：
   - 写实摄影 / 真人写真 / 实拍感 / 自然光影 / 镜头景深
   - 皮肤毛孔可见、少磨皮、自然阴影、禁止塑料脸
   - 明确禁止：二次元、动画、漫画、3D渲染、游戏CG、过度美颜、空气感磨皮、统一模板脸
7) 强提示词：足部可见或足部特写（按场景）、服装真实材质褶皱、环境真实道具；16:9 横构图、单一连贯场景。
8) 结构：总览（人数+真实场景+构图）→ 逐人细节 → 机位光效材质 → 用写实锁收束。
9) title 只做本地文件名，不要出现敏感长句。`

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function softClipChinese(text: string, maxChars: number) {
  const normalized = text.trim().replace(/\s+/g, ' ')
  const chars = [...normalized]
  if (chars.length <= maxChars) return normalized
  return chars.slice(0, maxChars).join('').replace(/[，,。.!！？\s]+$/u, '')
}

/** 强制钉写实锁，避免 GPT 漏写导致二次元/塑料脸 */
function ensureFeatureRealismLock(prompt: string) {
  let next = prompt.trim().replace(/\s+/g, ' ')
  next = next
    .replace(/二次元风格|动画风格|漫画风格|3D角色渲染|游戏CG风/g, '写实摄影')
    .replace(/空气感磨皮|过度美颜|塑料感皮肤/g, '少磨皮毛孔可见')
  if (!/写实锁死|毛孔|少磨皮|真人写真|写实摄影/.test(next)) {
    next = `${REALISM_LOCK}${next}`
  }
  if (!/禁止二次元|拒绝AI塑料|塑料脸|3D渲染/.test(next)) {
    next = `${next}${REALISM_LOCK}`
  }
  return softClipChinese(next, FEATURE_PROMPT_SOFT_MAX_CHARS)
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
}): Promise<{
  ok: boolean
  error?: string
  title?: string
  prompt?: string
  detail?: string
  model?: string
}> {
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
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model: secrets.teamoModel || 'gpt-5.4-mini',
        temperature: 0.85,
        max_tokens: 3500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: FEATURE_PROMPT_SYSTEM },
          {
            role: 'user',
            content: `把下面要求扩写成超详细【真人写实摄影】中文成图提示词（650～900字）。必须锁死：毛孔少磨皮、拒绝AI塑料脸、禁止二次元/动画/3D渲染。多人时逐人写清发型/表情/阴毛/足部/服装差异；可爱=真人可爱，不是二次元。用户没说多人/奇幻就不要擅自加：\n${userPrompt}`,
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
    const rawPrompt = typeof parsed?.prompt === 'string' ? parsed.prompt.trim() : ''
    const title = typeof parsed?.title === 'string' ? parsed.title.trim().slice(0, 60) : ''
    const prompt = ensureFeatureRealismLock(rawPrompt || userPrompt)
    if (!prompt) return { ok: false, error: '中转站未返回可用的成图提示词' }
    return {
      ok: true,
      title: title || `特色素材_${new Date().toISOString().slice(0, 10)}`,
      prompt,
      detail: prompt,
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

/** 官网 intimacy_lab 文生图 body（16:9 · 2304×1280） */
export function buildFeatureMaterialJobBody(prompt: string) {
  return {
    public_model_key: 'image1_pro',
    capability_key: 'image.generate.v1',
    prompt,
    aspect_ratio: '16:9',
    width: 2304,
    height: 1280,
    prompt_enhancement: true,
    metadata: {
      lab_app_key: 'intimacy_lab',
      generation_mode: 'text_to_image',
    },
    requested_options: {
      aspect_ratio: '16:9',
      width: 2304,
      height: 1280,
      aspect: '16:9',
    },
  }
}

export async function generateFeatureMaterial(input: {
  userPrompt: string
  proxyUrl: string
  sessionToken: string
  isCancelled?: () => boolean
  onProgress?: (progress: {
    stage: string
    progress?: number
    prompt?: string
    detail?: string
    title?: string
    jobId?: string
  }) => void
}): Promise<{
  ok: boolean
  error?: string
  title?: string
  prompt?: string
  detail?: string
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
  if (input.isCancelled?.()) {
    return {
      ok: false,
      error: '任务已取消',
      title: expanded.title,
      prompt: expanded.prompt,
      detail: expanded.detail,
    }
  }
  input.onProgress?.({
    stage: 'submitting',
    prompt: expanded.prompt,
    detail: expanded.detail,
    title: expanded.title,
  })

  const body = buildFeatureMaterialJobBody(expanded.prompt)
  const started = await lovemiJson({
    method: 'POST',
    path: '/v1/jobs',
    sessionToken: input.sessionToken,
    proxyUrl: input.proxyUrl,
    body,
  })
  if (!started.ok) {
    const detailErr =
      (typeof started.data.detail === 'string' && started.data.detail) ||
      started.error ||
      `Image1-pro HTTP ${started.status}`
    return {
      ok: false,
      error: detailErr,
      title: expanded.title,
      prompt: expanded.prompt,
      detail: expanded.detail,
      model: expanded.model,
    }
  }
  const jobId = pickByPrefix(started.data, 'job_')
  if (!jobId) {
    return {
      ok: false,
      error: 'Image1-pro 已接受但未返回 jobId',
      title: expanded.title,
      prompt: expanded.prompt,
      detail: expanded.detail,
    }
  }
  appendConsoleLog({
    level: 'info',
    action: 'feature_material',
    message: `特色素材已提交 · ${jobId} · ${expanded.title || ''} · prompt ${[...expanded.prompt].length}字`,
  })
  input.onProgress?.({
    stage: 'generating',
    jobId,
    prompt: expanded.prompt,
    detail: expanded.detail,
    title: expanded.title,
  })

  const deadline = Date.now() + 12 * 60_000
  let lastStatus = ''
  while (Date.now() < deadline) {
    if (input.isCancelled?.()) {
      return {
        ok: false,
        error: '任务已取消',
        jobId,
        title: expanded.title,
        prompt: expanded.prompt,
        detail: expanded.detail,
      }
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
      detail: expanded.detail,
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
        detail: expanded.detail,
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
          detail: expanded.detail,
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
    detail: expanded.detail,
    jobId,
  }
}
