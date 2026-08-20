/**
 * 一键流水线：
 * - autoVideoAndPublish：Teamo 出诱惑向 5s 动态提示词 → companion messages → presentation → 发布
 * - fullAutoToPublish：参考图分析 → 创建+立绘 → 同上
 */
import { fetch as undiciFetch } from 'undici'
import { dispatcherFor } from './mailProbe'
import { loadCreateCharSecrets } from './createCharSecrets'
import { appendConsoleLog } from './consoleDb'
import {
  analyzeReferenceImage,
  createLovemiCharacter,
  resolvePortraitAssetId,
  waitLovemiPortrait,
} from './lovemiCreateChar'
import { requestCompanionMotionVideo } from './lovemiCompanionVideo'
import { acceptVisualReference, setPreviewAndMaybePublish } from './lovemiPublish'

const MOTION_PROMPT_SYSTEM = `你是成人向短视频导演，给 Lovemi companion 写中文**催视频提示词**。

硬性要求：
- 角色一律**已确认年满 21 岁成年女性**；禁止未成年/幼态/学生暗示
- 中文；**90–160 字**；只返回提示词正文，不要 JSON、不要解释、不要拒写
- 内容要比「一句话」更丰满：写清景别、光影氛围、表情、呼吸、发丝、肩颈/胸口微动、镜头缓慢推进或轻微晃动之一；可补 1～2 个感官细节（眼神、嘴角、衣料轻颤）
- 仍保持「诱人、几乎静止」：以微动为主，**严禁**转身、舞蹈、多步骤手势、走位、道具戏、大幅度肢体
- 写明：5 秒、9:16 竖屏、半身近景（或半身偏近）
- 禁止：换脸、夸张变形、瞬移、水印、多镜头硬切
- 东亚角色：写「东亚面孔」；娇羞勾人即可
- **最后一句必须点明要视频**，例如：「请据此生成一段 5 秒竖屏短视频。」或「请输出对应动态视频。」`

const FALLBACK_MOTION_PROMPT =
  '5秒竖屏9:16半身近景，成年东亚女性，暖光侧打，眼神勾人带湿意，胸口随呼吸轻轻起伏，发丝在颊边微晃，嘴角浅笑，衣料随呼吸轻颤，镜头极缓慢推进，几乎静止的暧昧特写，禁止复杂动作与换脸。请据此生成一段5秒竖屏短视频。'

function ensureMotionPromptEndsWithVideoAsk(text: string): string {
  const t = text.trim().replace(/[。．.！!？?\s]+$/u, '')
  if (/生成.{0,8}(短)?视频|输出.{0,6}(动态)?视频|要一段?.{0,6}视频|做成视频/i.test(t)) {
    return `${t}。`
  }
  return `${t}。请据此生成一段5秒竖屏短视频。`
}

function isMotionPromptRefusal(text: string): boolean {
  return /不能帮你|无法协助|我不能|拒[绝写]|未成年|近未成年|underage|as an ai|i can'?t|i cannot|sorry,? i/i.test(
    text,
  )
}

function teamoHeaders(apiKey: string) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
}

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>
          if (typeof p.text === 'string') return p.text
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** 中转站：根据立绘（或参考图）生成诱惑向 5s 动态视频提示词 */
export async function generateSeductiveMotionPrompt(input: {
  proxyUrl: string
  imageBase64?: string
  mimeType?: string
  imageDataUrl?: string
  characterHint?: string
  appearanceHint?: string
}): Promise<{ ok: boolean; error?: string; prompt?: string; model?: string }> {
  const secrets = loadCreateCharSecrets()
  if (!secrets.teamoApiKey) return { ok: false, error: '未配置中转站 API Key' }
  if (!input.proxyUrl) return { ok: false, error: '未配置出站代理' }

  let dataUrl = input.imageDataUrl || ''
  if (!dataUrl && input.imageBase64) {
    dataUrl = `data:${input.mimeType || 'image/png'};base64,${input.imageBase64}`
  }
  // 无图也可纯文案催视频（有外观摘要/角色提示时），避免卡死整条流水线

  const url = `${secrets.teamoApiBase.replace(/\/$/, '')}/chat/completions`
  const userText = [
    dataUrl
      ? '根据这张立绘，写催视频提示词：诱人、几乎静止，但细节比极简版更丰满（光影/表情/呼吸/发丝/镜头微动）。'
      : '根据文字描述，写催视频提示词：诱人、几乎静止，但细节更丰满（光影/表情/呼吸/发丝/镜头微动）。',
    input.characterHint ? `角色：${input.characterHint}` : '',
    input.appearanceHint
      ? `已核验外观锁（视频必须保持同一角色、朝向、发型、服装与表情）：${input.appearanceHint.slice(0, 600)}`
      : '',
    /东亚|中日韩|华裔|日系|韩系|萌妹|east.?asian/i.test(
      `${input.characterHint || ''} ${input.appearanceHint || ''}`,
    )
      ? '锁东亚面孔。'
      : '',
    '以微动为主（呼吸/眨眼/发丝/浅笑/肩颈轻颤/镜头缓推 可组合 2～3 项）。禁止转身、舞蹈、多步骤。90–160字。',
    '最后一句必须写：请据此生成一段5秒竖屏短视频。',
  ]
    .filter(Boolean)
    .join('\n')

  if (!dataUrl && !input.characterHint && !input.appearanceHint) {
    return { ok: false, error: '缺少立绘/参考图与角色描述（无法向中转站要动态提示词）' }
  }

  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: teamoHeaders(secrets.teamoApiKey),
      dispatcher: dispatcherFor(input.proxyUrl, url),
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: secrets.teamoModel || 'gpt-5.4-mini',
        temperature: 0.55,
        messages: [
          { role: 'system', content: MOTION_PROMPT_SYSTEM },
          dataUrl
            ? {
                role: 'user',
                content: [
                  { type: 'text', text: userText },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              }
            : { role: 'user', content: userText },
        ],
      }),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const errObj = data.error as { message?: string } | string | undefined
      const msg =
        (typeof errObj === 'object' && errObj?.message) ||
        (typeof errObj === 'string' && errObj) ||
        (typeof data.message === 'string' && data.message) ||
        `中转站 HTTP ${res.status}`
      return { ok: false, error: msg, model: secrets.teamoModel }
    }
    const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : []
    const msg0 = (choices[0]?.message || {}) as Record<string, unknown>
    let text = messageContentToText(msg0.content).trim()
    if (!text) text = messageContentToText(msg0.reasoning_content).trim()
    text = text.replace(/^["「]|["」]$/g, '').trim()
    if (!text) return { ok: false, error: '中转站未返回动态提示词', model: secrets.teamoModel }
    if (isMotionPromptRefusal(text)) {
      appendConsoleLog({
        level: 'warn',
        action: 'create_char',
        message: `Teamo 拒写动态提示词，改用兜底文案 · ${text.slice(0, 48)}…`,
      })
      return { ok: true, prompt: FALLBACK_MOTION_PROMPT, model: secrets.teamoModel }
    }
    text = ensureMotionPromptEndsWithVideoAsk(text)
    appendConsoleLog({
      level: 'info',
      action: 'create_char',
      message: `Teamo 动态提示词已生成 · ${text.slice(0, 40)}…`,
    })
    return { ok: true, prompt: text, model: secrets.teamoModel }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function fetchImageAsDataUrl(input: {
  cdnUrl: string
  proxyUrl: string
}): Promise<string | undefined> {
  try {
    const res = await undiciFetch(input.cdnUrl, {
      dispatcher: dispatcherFor(input.proxyUrl, input.cdnUrl),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) return undefined
    const buf = Buffer.from(await res.arrayBuffer())
    const ct = res.headers.get('content-type') || 'image/jpeg'
    return `data:${ct.split(';')[0]};base64,${buf.toString('base64')}`
  } catch {
    return undefined
  }
}

function buildPublishMeta(payload?: Record<string, unknown>, fallbackHint?: string) {
  let title = '未命名角色'
  let description = fallbackHint || ''
  if (payload) {
    if (typeof payload.display_name === 'string' && payload.display_name.trim()) {
      title = payload.display_name.trim()
      const age =
        typeof payload.age_statement === 'string'
          ? payload.age_statement.replace(/[^\d]/g, '')
          : ''
      if (age) title = `${title} · ${age}`
    }
    const profile = typeof payload.profile_text === 'string' ? payload.profile_text : ''
    const personality = Array.isArray(payload.personality_tags)
      ? payload.personality_tags.map(String).join('；')
      : ''
    description = [profile, personality].filter(Boolean).join('\n') || description || title
  }
  return { title, description }
}

/**
 * 已有角色+立绘：Teamo 提示词 → companion 视频（仅生成，不发布）
 */
export async function generateMotionVideoOnly(input: {
  characterId: string
  proxyUrl: string
  sessionToken?: string
  portraitCdnUrl?: string
  imageBase64?: string
  mimeType?: string
  imageDataUrl?: string
  coverAssetId?: string
  characterHint?: string
  appearanceHint?: string
}): Promise<{
  ok: boolean
  error?: string
  motionPrompt?: string
  coverAssetId?: string
  videoAssetId?: string
  cdnUrl?: string
  labProjectId?: string
}> {
  const secrets = loadCreateCharSecrets()
  const token = secrets.adminSessionToken || input.sessionToken || ''
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }

  let coverId = input.coverAssetId
  let portraitDataUrl: string | undefined = input.imageDataUrl
  if (!portraitDataUrl && input.imageBase64) {
    portraitDataUrl = `data:${input.mimeType || 'image/png'};base64,${input.imageBase64}`
  }
  if (!coverId || !portraitDataUrl) {
    const resolved = await resolvePortraitAssetId({
      characterId: input.characterId,
      sessionToken: token,
      proxyUrl: input.proxyUrl,
      retries: 5,
    })
    if (resolved.ok && resolved.assetId) coverId = coverId || resolved.assetId
    if (!portraitDataUrl && resolved.cdnUrl) {
      portraitDataUrl = await fetchImageAsDataUrl({
        cdnUrl: resolved.cdnUrl,
        proxyUrl: input.proxyUrl,
      })
    }
  }
  if (!portraitDataUrl && input.portraitCdnUrl) {
    portraitDataUrl = await fetchImageAsDataUrl({
      cdnUrl: input.portraitCdnUrl,
      proxyUrl: input.proxyUrl,
    })
  }
  if (!coverId) return { ok: false, error: '找不到立绘 asset_id（请先生成立绘）' }

  const gen = await generateSeductiveMotionPrompt({
    proxyUrl: input.proxyUrl,
    imageDataUrl: portraitDataUrl,
    characterHint: input.characterHint,
    appearanceHint: input.appearanceHint,
  })
  if (!gen.ok || !gen.prompt) {
    return { ok: false, error: gen.error || 'Teamo 动态提示词失败', coverAssetId: coverId }
  }

  const video = await requestCompanionMotionVideo({
    characterId: input.characterId,
    sessionToken: token,
    proxyUrl: input.proxyUrl,
    prompt: gen.prompt,
    title: input.characterHint || 'companion',
    coverAssetId: coverId,
    timeoutMs: 600_000,
  })
  if (!video.ok || !video.videoAssetId) {
    return {
      ok: false,
      error: video.error || 'companion 视频失败',
      motionPrompt: gen.prompt,
      coverAssetId: coverId,
      labProjectId: video.labProjectId,
    }
  }

  return {
    ok: true,
    motionPrompt: gen.prompt,
    coverAssetId: coverId,
    videoAssetId: video.videoAssetId,
    cdnUrl: video.cdnUrl,
    labProjectId: video.labProjectId,
  }
}

/**
 * 已有角色+立绘：Teamo 提示词 → companion 视频 → accept+presentation → 发布
 */
export async function autoVideoAndPublish(input: {
  characterId: string
  proxyUrl: string
  sessionToken?: string
  /** 立绘 CDN 或参考图 data URL / base64 */
  portraitCdnUrl?: string
  imageBase64?: string
  mimeType?: string
  imageDataUrl?: string
  coverAssetId?: string
  characterHint?: string
  appearanceHint?: string
  payload?: Record<string, unknown>
  motionPromptOverride?: string
  runStartedAt?: number
  isCancelled?: () => boolean
}): Promise<{
  ok: boolean
  error?: string
  motionPrompt?: string
  coverAssetId?: string
  videoAssetId?: string
  cdnUrl?: string
  listingId?: string
  labProjectId?: string
  publishOk?: boolean
}> {
  const secrets = loadCreateCharSecrets()
  const token = secrets.adminSessionToken || input.sessionToken || ''
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }
  if (input.isCancelled?.()) return { ok: false, error: '任务已取消' }

  // cover asset：优先立绘 CDN；有现成 motion 提示词时可跳过下图
  let coverId = input.coverAssetId
  let portraitCdn = input.portraitCdnUrl
  let portraitDataUrl: string | undefined = input.imageDataUrl
  if (!coverId || (!portraitCdn && !portraitDataUrl)) {
    const resolved = await resolvePortraitAssetId({
      characterId: input.characterId,
      sessionToken: token,
      proxyUrl: input.proxyUrl,
      retries: 8,
    })
    if (resolved.ok && resolved.assetId) coverId = coverId || resolved.assetId
    if (!portraitCdn && resolved.cdnUrl) portraitCdn = resolved.cdnUrl
  }
  if (!coverId) return { ok: false, error: '找不到立绘 asset_id（请先生成立绘）' }
  if (input.isCancelled?.()) return { ok: false, error: '任务已取消', coverAssetId: coverId }

  // 1) Teamo motion prompt
  let motionPrompt = (input.motionPromptOverride || '').trim()
  if (!motionPrompt) {
    if (!portraitDataUrl && portraitCdn) {
      portraitDataUrl = await fetchImageAsDataUrl({
        cdnUrl: portraitCdn,
        proxyUrl: input.proxyUrl,
      })
    }
    if (!portraitDataUrl && input.imageBase64) {
      portraitDataUrl = `data:${input.mimeType || 'image/png'};base64,${input.imageBase64}`
    }
    const gen = await generateSeductiveMotionPrompt({
      proxyUrl: input.proxyUrl,
      imageDataUrl: portraitDataUrl,
      characterHint: input.characterHint,
      appearanceHint: input.appearanceHint,
    })
    if (!gen.ok || !gen.prompt) {
      return { ok: false, error: gen.error || 'Teamo 动态提示词失败', coverAssetId: coverId }
    }
    motionPrompt = gen.prompt
  }

  // 2) companion messages → character-bound video
  const video = await requestCompanionMotionVideo({
    characterId: input.characterId,
    sessionToken: token,
    proxyUrl: input.proxyUrl,
    prompt: motionPrompt,
    title: String(input.payload?.display_name || 'companion'),
    coverAssetId: coverId,
    runStartedAt: input.runStartedAt,
    shouldCancel: input.isCancelled,
  })
  if (input.isCancelled?.()) {
    return { ok: false, error: '任务已取消', motionPrompt, coverAssetId: coverId }
  }
  let videoAssetId = video.videoAssetId
  let videoCdn = video.cdnUrl
  if (!video.ok || !videoAssetId) {
    return {
      ok: false,
      error: video.error || 'companion 视频失败（未找到可确认属于本次运行的新视频）',
      motionPrompt,
      coverAssetId: coverId,
      labProjectId: video.labProjectId,
    }
  }

  // 3) accept + presentation + draft + publish
  if (input.isCancelled?.()) {
    return { ok: false, error: '任务已取消', motionPrompt, coverAssetId: coverId, videoAssetId }
  }
  await acceptVisualReference({
    characterId: input.characterId,
    assetId: coverId,
    proxyUrl: input.proxyUrl,
    sessionToken: token,
  })
  const { title, description } = buildPublishMeta(input.payload, input.characterHint)
  const pub = await setPreviewAndMaybePublish({
    characterId: input.characterId,
    proxyUrl: input.proxyUrl,
    sessionToken: token,
    coverAssetId: coverId,
    videoAssetId,
    title,
    description,
    publish: true,
  })
  if (!pub.ok) {
    return {
      ok: false,
      error: pub.error || '设预览/发布失败',
      motionPrompt,
      coverAssetId: coverId,
      videoAssetId,
      cdnUrl: videoCdn,
      listingId: pub.listingId,
      labProjectId: video.labProjectId,
      publishOk: false,
    }
  }

  appendConsoleLog({
    level: 'info',
    action: 'create_char',
    message: `自动视频并发布完成 · ${input.characterId.slice(0, 18)} · ${pub.listingId || ''}`,
  })
  return {
    ok: true,
    motionPrompt,
    coverAssetId: coverId,
    videoAssetId,
    cdnUrl: videoCdn,
    listingId: pub.listingId,
    labProjectId: video.labProjectId,
    publishOk: true,
  }
}

/** 全自动流水线：多轮等立绘（job failed 时主进程内已自动重触发，这里再补外层轮次） */
async function waitPortraitForFullAuto(input: {
  characterId: string
  sessionToken: string
  proxyUrl: string
  runStartedAt: number
  shouldCancel?: () => boolean
}): Promise<{
  ok: boolean
  error?: string
  portraitCdnUrl?: string
  coverAssetId?: string
  portraitJobId?: string
}> {
  const shouldFailFast = (msg: string | undefined) =>
    Boolean(
      msg &&
        /不可重试|PROMPT_COMPILATION_FAILED|INVALID_PROMPT|CONTENT_POLICY|MODERATION|SAFETY|终态无输出/i.test(
          msg,
        ),
    )
  const rounds = [
    { timeoutMs: 720_000, forceRestart: false },
    { timeoutMs: 480_000, forceRestart: true },
    { timeoutMs: 480_000, forceRestart: true },
  ]
  let lastError = ''
  let portraitCdnUrl: string | undefined
  let coverAssetId: string | undefined
  let portraitJobId: string | undefined

  for (let round = 0; round < rounds.length; round++) {
    if (input.shouldCancel?.()) return { ok: false, error: '任务已取消', portraitJobId }
    const { timeoutMs, forceRestart } = rounds[round]
    if (round > 0) {
      appendConsoleLog({
        level: 'warn',
        action: 'create_char',
        message: `全自动立绘补拉第 ${round + 1}/${rounds.length} 轮 · ${input.characterId.slice(0, 18)}`,
      })
    }
    const waited = await waitLovemiPortrait({
      characterId: input.characterId,
      sessionToken: input.sessionToken,
      proxyUrl: input.proxyUrl,
      timeoutMs,
      forceRestart,
      shouldCancel: input.shouldCancel,
    })
    if (input.shouldCancel?.()) return { ok: false, error: '任务已取消', portraitJobId: waited.jobId }
    lastError = waited.error || lastError
    if (waited.jobId) portraitJobId = waited.jobId
    if (!waited.ok && shouldFailFast(waited.error)) {
      appendConsoleLog({
        level: 'warn',
        action: 'create_char',
        message: `立绘快速失败终止 · ${input.characterId.slice(0, 18)} · ${waited.error || 'unknown'}`,
      })
      return {
        ok: false,
        error: waited.error || '立绘任务失败（快速终止）',
        portraitJobId,
      }
    }
    // wait 返回值只表示“看到图片”；最终必须按 job.outputs → 当前角色资产双重核验。
    // 绝不直接信任 wait 从 job 根对象深挖出的 URL/asset，那里可能是输入图或其它旧资产。
    const resolved = await resolvePortraitAssetId({
      characterId: input.characterId,
      sessionToken: input.sessionToken,
      proxyUrl: input.proxyUrl,
      jobId: waited.jobId,
      minCreatedAt: input.runStartedAt,
      retries: 20,
    })
    if (resolved.assetId && resolved.cdnUrl) {
      coverAssetId = resolved.assetId
      portraitCdnUrl = resolved.cdnUrl
      appendConsoleLog({
        level: 'info',
        action: 'create_char',
        message: `立绘归属校验通过 · ${input.characterId} · ${portraitJobId || 'no-job'} · ${coverAssetId} · ${portraitCdnUrl.slice(-48)}`,
      })
      return { ok: true, portraitCdnUrl, coverAssetId, portraitJobId }
    }
    lastError = resolved.error || lastError || '立绘输出尚未通过角色归属校验'
    if (round < rounds.length - 1) continue
  }

  if (portraitCdnUrl) {
    return {
      ok: false,
      error: lastError || '立绘已出但找不到 asset_id',
      portraitCdnUrl,
      coverAssetId,
      portraitJobId,
    }
  }
  return {
    ok: false,
    error: lastError || '立绘未就绪',
    portraitCdnUrl,
    coverAssetId,
    portraitJobId,
  }
}

/** 参考图 → 分析 JSON → 创建+立绘 → 视频+发布 */
export async function fullAutoToPublish(input: {
  imageBase64: string
  mimeType?: string
  proxyUrl: string
  sessionToken?: string
  userHint?: string
  runId: string
  runStartedAt: number
  isCancelled?: () => boolean
  onProgress?: (p: {
    stage: string
    characterId?: string
    portraitCdnUrl?: string
    coverAssetId?: string
    payload?: Record<string, unknown>
    portraitPrompt?: string
    motionPrompt?: string
    videoAssetId?: string
    videoCdnUrl?: string
    listingId?: string
    portraitJobId?: string
  }) => void
}): Promise<{
  ok: boolean
  error?: string
  characterId?: string
  payload?: Record<string, unknown>
  portraitPrompt?: string
  motionPrompt?: string
  coverAssetId?: string
  videoAssetId?: string
  videoCdnUrl?: string
  listingId?: string
  portraitCdnUrl?: string
  portraitJobId?: string
}> {
  const secrets = loadCreateCharSecrets()
  const token = secrets.adminSessionToken || input.sessionToken || ''
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }
  const progress = input.onProgress || (() => {})
  const cancelled = () => input.isCancelled?.() === true
  if (cancelled()) return { ok: false, error: '任务已取消' }

  progress({ stage: 'analyze' })
  const analyzed = await analyzeReferenceImage({
    imageBase64: input.imageBase64,
    mimeType: input.mimeType,
    proxyUrl: input.proxyUrl,
    userHint: input.userHint,
  })
  if (cancelled()) return { ok: false, error: '任务已取消' }
  if (!analyzed.ok || !analyzed.payload) {
    return { ok: false, error: analyzed.error || '分析失败' }
  }
  progress({
    stage: 'analyzed',
    payload: analyzed.payload,
    portraitPrompt: analyzed.portraitPrompt,
  })

  progress({ stage: 'create' })
  if (cancelled()) return { ok: false, error: '任务已取消', payload: analyzed.payload }
  const created = await createLovemiCharacter({
    sessionToken: token,
    proxyUrl: input.proxyUrl,
    body: analyzed.payload,
    waitPortrait: false,
  })
  const characterId =
    (created.data &&
      (typeof created.data.character_id === 'string'
        ? created.data.character_id
        : typeof created.data.id === 'string'
          ? created.data.id
          : undefined)) ||
    undefined
  if (!created.ok || !characterId) {
    return {
      ok: false,
      error: created.error || '创建角色失败',
      payload: analyzed.payload,
      portraitPrompt: analyzed.portraitPrompt,
      characterId,
    }
  }
  if (cancelled()) {
    return {
      ok: false,
      error: '任务已取消（角色已创建，但未继续生成/发布）',
      characterId,
      payload: analyzed.payload,
      portraitPrompt: analyzed.portraitPrompt,
    }
  }

  // 立刻回填角色 ID，前端可并行刷立绘（不必干等主进程）
  progress({
    stage: 'create',
    characterId,
    payload: analyzed.payload,
    portraitPrompt: analyzed.portraitPrompt,
  })

  const portrait = await waitPortraitForFullAuto({
    characterId,
    sessionToken: token,
    proxyUrl: input.proxyUrl,
    runStartedAt: input.runStartedAt,
    shouldCancel: input.isCancelled,
  })
  if (cancelled()) {
    return {
      ok: false,
      error: '任务已取消',
      characterId,
      payload: analyzed.payload,
      portraitPrompt: analyzed.portraitPrompt,
    }
  }

  const portraitCdnUrl = portrait.portraitCdnUrl
  const coverAssetId = portrait.coverAssetId
  if (!portrait.ok || !portraitCdnUrl || !coverAssetId) {
    return {
      ok: false,
      error: portrait.error || '立绘未就绪',
      characterId,
      payload: analyzed.payload,
      portraitPrompt: analyzed.portraitPrompt,
      portraitCdnUrl,
      coverAssetId,
      portraitJobId: portrait.portraitJobId,
    }
  }
  progress({
    stage: 'portrait',
    characterId,
    portraitCdnUrl,
    coverAssetId,
    portraitJobId: portrait.portraitJobId,
    payload: analyzed.payload,
    portraitPrompt: analyzed.portraitPrompt,
  })

  const appearanceHint = Array.isArray(analyzed.payload.appearance_tags)
    ? analyzed.payload.appearance_tags
        .map(String)
        .filter((tag) =>
          /^(人种|五官|发型|发质|发色|瞳色|朝向|惯用手|服装|配饰|姿势|表情|气质|脚):/.test(
            tag,
          ),
        )
        .slice(0, 18)
        .join('；')
    : ''

  progress({ stage: 'video', characterId, portraitCdnUrl, coverAssetId })
  // 只用立绘 CDN 做动态提示词；绝不用参考图 base64 顶替（否则视频像「另一张图」且易失败）
  const rest = await autoVideoAndPublish({
    characterId,
    proxyUrl: input.proxyUrl,
    sessionToken: token,
    portraitCdnUrl,
    coverAssetId,
    characterHint: input.userHint || String(analyzed.payload.display_name || ''),
    appearanceHint,
    payload: analyzed.payload,
    runStartedAt: input.runStartedAt,
    isCancelled: input.isCancelled,
  })

  progress({
    stage: rest.ok ? 'published' : 'video_failed',
    characterId,
    portraitCdnUrl,
    coverAssetId: rest.coverAssetId || coverAssetId,
    portraitJobId: portrait.portraitJobId,
    motionPrompt: rest.motionPrompt,
    videoAssetId: rest.videoAssetId,
    videoCdnUrl: rest.cdnUrl,
    listingId: rest.listingId,
    payload: analyzed.payload,
    portraitPrompt: analyzed.portraitPrompt,
  })

  return {
    ok: rest.ok,
    error: rest.error,
    characterId,
    payload: analyzed.payload,
    portraitPrompt: analyzed.portraitPrompt,
    motionPrompt: rest.motionPrompt,
    coverAssetId: rest.coverAssetId || coverAssetId,
    videoAssetId: rest.videoAssetId,
    videoCdnUrl: rest.cdnUrl,
    listingId: rest.listingId,
    portraitCdnUrl,
    portraitJobId: portrait.portraitJobId,
  }
}
