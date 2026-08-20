/// <reference types="vite/client" />

interface ProbeInput {
  email: string
  authMode: string
  refreshToken?: string
  clientId?: string
  proxyUrl?: string
  forceUrlProxy?: boolean
  fallbackDirect?: boolean
}

interface ProbeResult {
  ok: boolean
  email: string
  error?: string
  refreshToken?: string
  displayName?: string
  via?: string
}

interface ProxyTestResult {
  localPortOpen: boolean
  viaProxy: { ok: boolean; error?: string; status?: number }
  direct: { ok: boolean; error?: string; status?: number }
  urlProxyKind: 'vless-subscription' | 'http-proxy' | 'unknown' | 'empty'
  urlProxyHint: string
  recommendation: string
}

interface MailProxyResolve {
  running: boolean
  proxyUrl?: string
  nodeServer?: string
  error?: string
  source: 'vless' | 'fallback-local' | 'none'
}

interface RegisterInput {
  email: string
  refreshToken?: string
  clientId?: string
  proxyUrl?: string
  password?: string
  displayName?: string
  /** 已知已注册：跳过注册验证码，直接重置接管 */
  preferReclaim?: boolean
}

interface RegisterResult {
  ok: boolean
  email: string
  error?: string
  challengeId?: string
  otp?: string
  otpSource?: 'dev_otp' | 'graph_mail'
  password?: string
  userId?: string
  sessionToken?: string
  refreshToken?: string
}

interface LoginInput {
  email: string
  password?: string
  refreshToken?: string
  clientId?: string
  proxyUrl?: string
}

interface LoginResult {
  ok: boolean
  email: string
  error?: string
  sessionToken?: string
  userId?: string
  expiresAt?: string
}

interface LovemiBridge {
  loadAccounts: () => Promise<string | null>
  saveAccounts: (plaintext: string) => Promise<{ ok: boolean; encrypted: boolean }>
  probeAccount: (input: ProbeInput) => Promise<ProbeResult>
  probeBatch: (inputs: ProbeInput[]) => Promise<ProbeResult[]>
  registerLovemi: (input: RegisterInput) => Promise<RegisterResult>
  registerLovemiBatch: (inputs: RegisterInput[]) => Promise<RegisterResult[]>
  loginLovemi: (input: LoginInput) => Promise<LoginResult>
  resetLovemiPassword: (input: {
    email: string
    refreshToken?: string
    clientId?: string
    proxyUrl?: string
    newPassword?: string
  }) => Promise<{
    ok: boolean
    email: string
    error?: string
    password?: string
    sessionToken?: string
    userId?: string
  }>
  lovemiMe: (input: {
    sessionToken: string
    proxyUrl?: string
    email?: string
  }) => Promise<{ ok: boolean; email?: string; error?: string; data?: Record<string, unknown> }>
  testProxy: (input: { localProxyUrl?: string; urlProxy?: string }) => Promise<ProxyTestResult>
  resolveMailProxy: (input: {
    vlessEnabled: boolean
    subscriptionUrl: string
    localEnabled: boolean
    localHost: string
    localPort: number
  }) => Promise<MailProxyResolve>
  vlessStatus: () => Promise<MailProxyResolve>
  consoleEnsureSeed: () => Promise<{ comments: number; names: number; seeded: boolean }>
  consoleCopyStats: () => Promise<{
    locales: string[]
    labels: Record<string, string>
    byLocale: Record<string, { comments: number; names: number; namesFree: number }>
  }>
  consoleListComments: (
    locale?: string,
  ) => Promise<Array<{ id: string; locale: string; body: string; enabled: number; use_count: number; created_at: string }>>
  consoleListNames: (input?: {
    locale?: string
    onlyFree?: boolean
  }) => Promise<
    Array<{
      id: string
      locale: string
      name: string
      normalized: string
      used_by_account_id: string | null
      created_at: string
    }>
  >
  consoleAddComment: (input: { locale: string; body: string }) => Promise<{ ok: boolean; id?: string; error?: string }>
  consoleAddName: (input: { locale: string; name: string }) => Promise<{ ok: boolean; id?: string; error?: string }>
  consoleLogs: (limit?: number) => Promise<
    Array<{
      id: number
      ts: string
      level: string
      account_email: string | null
      listing_id: string | null
      action: string
      message: string
    }>
  >
  consoleClearLogs: () => Promise<{ ok: boolean }>
  consoleCharacterStats: () => Promise<{
    characters: number
    pending: number
    engaged: number
    skipped: number
    failed?: number
    today?: { liked: number; commented: number; skipped: number }
  }>
  consolePickLocale: (existing: Array<string | undefined>) => Promise<string>
  consoleRenameProfile: (input: {
    accountId: string
    email: string
    sessionToken: string
    proxyUrl?: string
    locale: string
  }) => Promise<{ ok: boolean; error?: string; displayName?: string }>
  consoleDiscover: (input: {
    sessionToken: string
    proxyUrl?: string
    accountIds: string[]
    pages?: number
    limit?: number
  }) => Promise<{
    ok: boolean
    error?: string
    pages: number
    items: number
    inserted: number
    pendingCreated: number
  }>
  consoleEngageStep: (input: {
    accounts: Array<{ id: string; email: string; sessionToken: string; locale?: string }>
    proxyUrl?: string
    rateMin?: number
    rateMax?: number
  }) => Promise<{
    ok: boolean
    done?: boolean
    action?: string
    rateLimited?: boolean
    accountEmail?: string
    listingId?: string
    title?: string
    message?: string
    error?: string
    engageRate?: number
  }>
  consoleLog: (input: {
    level: 'info' | 'warn' | 'error'
    action: string
    message: string
    accountEmail?: string
    listingId?: string
  }) => Promise<{ ok: boolean }>
  createCharConfig: () => Promise<{
    teamoApiBase: string
    teamoModel: string
    hasApiKey: boolean
    hasAdminToken: boolean
    adminEmailLocal: string
    adminAccountId: string
    downloadsDir: string
  }>
  createCharSaveConfig: (input: {
    teamoApiBase?: string
    teamoApiKey?: string
    teamoModel?: string
    adminSessionToken?: string
    adminEmailLocal?: string
    adminAccountId?: string
    downloadsDir?: string
  }) => Promise<{
    teamoApiBase: string
    teamoModel: string
    hasApiKey: boolean
    hasAdminToken: boolean
    adminEmailLocal: string
    adminAccountId: string
    downloadsDir: string
  }>
  createCharPickDownloadsDir: () => Promise<{
    ok: boolean
    teamoApiBase: string
    teamoModel: string
    hasApiKey: boolean
    hasAdminToken: boolean
    adminEmailLocal: string
    adminAccountId: string
    downloadsDir: string
    defaultDownloadsDir: string
  }>
  createCharAnalyze: (input: {
    imageBase64: string
    mimeType?: string
    proxyUrl?: string
    userHint?: string
  }) => Promise<{
    ok: boolean
    error?: string
    payload?: Record<string, unknown>
    portraitPrompt?: string
    model?: string
    rawPreview?: string
  }>
  createCharWaitPortrait: (input: {
    characterId: string
    sessionToken?: string
    proxyUrl?: string
    jobId?: string
    forceRestart?: boolean
  }) => Promise<{
    ok: boolean
    error?: string
    cdnUrl?: string
    jobId?: string
    imageDataUrl?: string
    jobStatus?: string
    assetId?: string
  }>
  createCharRefreshPortrait: (input: {
    characterId: string
    sessionToken?: string
    proxyUrl?: string
  }) => Promise<{
    ok: boolean
    error?: string
    cdnUrl?: string
    assetId?: string
  }>
  createCharRefreshVideo: (input: {
    characterId: string
    sessionToken?: string
    proxyUrl?: string
  }) => Promise<{
    ok: boolean
    error?: string
    videoAssetId?: string
    cdnUrl?: string
  }>
  createCharCreate: (input: {
    sessionToken?: string
    proxyUrl?: string
    body: Record<string, unknown>
    waitPortrait?: boolean
  }) => Promise<{
    ok: boolean
    error?: string
    status?: number
    data?: Record<string, unknown>
    portrait?: { cdnUrl?: string; jobId?: string; imageDataUrl?: string; assetId?: string }
    createdAs?: string
  }>
  createCharMotionVideo: (input: {
    characterId: string
    sessionToken?: string
    proxyUrl?: string
    prompt?: string
    inputAssetId?: string
    mode?: 'companion' | 'direct'
  }) => Promise<{
    ok: boolean
    error?: string
    jobId?: string
    inputAssetId?: string
    outputAssetId?: string
    cdnUrl?: string
    note?: string
    labProjectId?: string
  }>
  createCharSetPreviewPublish: (input: {
    characterId: string
    sessionToken?: string
    proxyUrl?: string
    coverAssetId: string
    videoAssetId?: string
    title?: string
    description?: string
    publish?: boolean
    listingId?: string
  }) => Promise<{
    ok: boolean
    error?: string
    listingId?: string
    draftOk?: boolean
    videoAttachOk?: boolean
    publishOk?: boolean
    data?: Record<string, unknown>
  }>
  createCharGenerateMotionOnly: (input: {
    characterId: string
    sessionToken?: string
    proxyUrl?: string
    portraitCdnUrl?: string
    imageBase64?: string
    mimeType?: string
    coverAssetId?: string
    characterHint?: string
    appearanceHint?: string
  }) => Promise<{
    ok: boolean
    error?: string
    motionPrompt?: string
    coverAssetId?: string
    videoAssetId?: string
    cdnUrl?: string
    labProjectId?: string
  }>
  createCharAutoVideoPublish: (input: {
    characterId: string
    sessionToken?: string
    proxyUrl?: string
    portraitCdnUrl?: string
    imageBase64?: string
    mimeType?: string
    coverAssetId?: string
    characterHint?: string
    appearanceHint?: string
    payload?: Record<string, unknown>
    motionPromptOverride?: string
  }) => Promise<{
    ok: boolean
    error?: string
    motionPrompt?: string
    coverAssetId?: string
    videoAssetId?: string
    cdnUrl?: string
    listingId?: string
    labProjectId?: string
    publishOk?: boolean
  }>
  createCharFullAutoPublish: (input: {
    imageBase64: string
    mimeType?: string
    proxyUrl?: string
    sessionToken?: string
    userHint?: string
    clientSlot?: 1 | 2 | 3 | 4 | 5
    clientRunEpoch?: number
    clientRunId: string
  }) => Promise<{
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
    runId?: string
    runStartedAt?: number
    cancelled?: boolean
  }>
  createCharCancelFullAuto: (input: { runId: string }) => Promise<{
    ok: boolean
    error?: string
  }>
  onCreateCharProgress: (
    cb: (p: {
      stage: string
      clientSlot?: 1 | 2 | 3 | 4 | 5
      clientRunEpoch?: number
      runId?: string
      runStartedAt?: number
      queuePosition?: number
      error?: string
      characterId?: string
      portraitJobId?: string
      portraitCdnUrl?: string
      coverAssetId?: string
      payload?: Record<string, unknown>
      portraitPrompt?: string
      motionPrompt?: string
      videoAssetId?: string
      videoCdnUrl?: string
      listingId?: string
    }) => void,
  ) => () => void
  createCharCacheMedia: (input: {
    cdnUrl: string
    proxyUrl?: string
    displayName?: string
    kind?: 'portrait' | 'video' | 'media'
    characterId?: string
    assetId?: string
    runId?: string
  }) => Promise<{
    ok: boolean
    error?: string
    fileName?: string
    localPath?: string
    cacheUrl?: string
    bytes?: number
    twitterPath?: string
  }>
  captionGenerate: (input: {
    proxyUrl?: string
    images: Array<{ base64: string; mimeType?: string }>
    fileName?: string
    characterName?: string
    userHint?: string
    style?: 'standard' | 'twitterComment'
  }) => Promise<{
    ok: boolean
    error?: string
    caption?: string
    ownerName?: string
    characterName?: string
    model?: string
    style?: 'standard' | 'twitterComment'
    kinkLabel?: string
    rawPreview?: string
  }>
}

interface Window {
  lovemi?: LovemiBridge
}
