import { contextBridge, ipcRenderer } from 'electron'

export type ProbeInput = {
  email: string
  authMode: string
  refreshToken?: string
  clientId?: string
  proxyUrl?: string
  forceUrlProxy?: boolean
  fallbackDirect?: boolean
}

export type ProbeResult = {
  ok: boolean
  email: string
  error?: string
  refreshToken?: string
  displayName?: string
  via?: string
}

export type ProxyTestResult = {
  localPortOpen: boolean
  viaProxy: { ok: boolean; error?: string; status?: number }
  direct: { ok: boolean; error?: string; status?: number }
  urlProxyKind: 'vless-subscription' | 'http-proxy' | 'unknown' | 'empty'
  urlProxyHint: string
  recommendation: string
}

export type MailProxyResolve = {
  running: boolean
  proxyUrl?: string
  nodeServer?: string
  error?: string
  source: 'vless' | 'fallback-local' | 'none'
}

export type RegisterInput = {
  email: string
  refreshToken?: string
  clientId?: string
  proxyUrl?: string
  password?: string
  displayName?: string
}

export type RegisterResult = {
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

export type LoginInput = {
  email: string
  password?: string
  refreshToken?: string
  clientId?: string
  proxyUrl?: string
}

export type LoginResult = {
  ok: boolean
  email: string
  error?: string
  sessionToken?: string
  userId?: string
  expiresAt?: string
}

contextBridge.exposeInMainWorld('lovemi', {
  getAppVersion: () => ipcRenderer.invoke('app:getVersion') as Promise<string>,
  loadAccounts: () => ipcRenderer.invoke('accounts:load') as Promise<string | null>,
  saveAccounts: (plaintext: string) =>
    ipcRenderer.invoke('accounts:save', plaintext) as Promise<{ ok: boolean; encrypted: boolean }>,
  probeAccount: (input: ProbeInput) =>
    ipcRenderer.invoke('mail:probe', input) as Promise<ProbeResult>,
  probeBatch: (inputs: ProbeInput[]) =>
    ipcRenderer.invoke('mail:probeBatch', inputs) as Promise<ProbeResult[]>,
  registerLovemi: (input: RegisterInput) =>
    ipcRenderer.invoke('lovemi:register', input) as Promise<RegisterResult>,
  registerLovemiBatch: (inputs: RegisterInput[]) =>
    ipcRenderer.invoke('lovemi:registerBatch', inputs) as Promise<RegisterResult[]>,
  loginLovemi: (input: LoginInput) =>
    ipcRenderer.invoke('lovemi:login', input) as Promise<LoginResult>,
  resetLovemiPassword: (input: {
    email: string
    refreshToken?: string
    clientId?: string
    proxyUrl?: string
    newPassword?: string
  }) =>
    ipcRenderer.invoke('lovemi:resetPassword', input) as Promise<{
      ok: boolean
      email: string
      error?: string
      password?: string
      sessionToken?: string
      userId?: string
    }>,
  lovemiMe: (input: { sessionToken: string; proxyUrl?: string; email?: string }) =>
    ipcRenderer.invoke('lovemi:me', input) as Promise<{
      ok: boolean
      email?: string
      error?: string
      data?: Record<string, unknown>
    }>,
  testProxy: (input: { localProxyUrl?: string; urlProxy?: string }) =>
    ipcRenderer.invoke('proxy:test', input) as Promise<ProxyTestResult>,
  resolveMailProxy: (input: {
    vlessEnabled: boolean
    subscriptionUrl: string
    localEnabled: boolean
    localHost: string
    localPort: number
  }) => ipcRenderer.invoke('proxy:resolveMail', input) as Promise<MailProxyResolve>,
  vlessStatus: () => ipcRenderer.invoke('proxy:vlessStatus') as Promise<MailProxyResolve>,
  consoleEnsureSeed: () =>
    ipcRenderer.invoke('console:ensureSeed') as Promise<{ comments: number; names: number; seeded: boolean }>,
  consoleCopyStats: () => ipcRenderer.invoke('console:copyStats') as Promise<{
    locales: string[]
    labels: Record<string, string>
    byLocale: Record<string, { comments: number; names: number; namesFree: number }>
  }>,
  consoleListComments: (locale?: string) =>
    ipcRenderer.invoke('console:listComments', locale) as Promise<
      Array<{ id: string; locale: string; body: string; enabled: number; use_count: number; created_at: string }>
    >,
  consoleListNames: (input?: { locale?: string; onlyFree?: boolean }) =>
    ipcRenderer.invoke('console:listNames', input) as Promise<
      Array<{
        id: string
        locale: string
        name: string
        normalized: string
        used_by_account_id: string | null
        created_at: string
      }>
    >,
  consoleAddComment: (input: { locale: string; body: string }) =>
    ipcRenderer.invoke('console:addComment', input) as Promise<{ ok: boolean; id?: string; error?: string }>,
  consoleAddName: (input: { locale: string; name: string }) =>
    ipcRenderer.invoke('console:addName', input) as Promise<{ ok: boolean; id?: string; error?: string }>,
  consoleLogs: (limit?: number) =>
    ipcRenderer.invoke('console:logs', limit) as Promise<
      Array<{
        id: number
        ts: string
        level: string
        account_email: string | null
        listing_id: string | null
        action: string
        message: string
      }>
    >,
  consoleClearLogs: () => ipcRenderer.invoke('console:clearLogs') as Promise<{ ok: boolean }>,
  consoleCharacterStats: () =>
    ipcRenderer.invoke('console:characterStats') as Promise<{
      characters: number
      pending: number
      engaged: number
      skipped: number
    }>,
  consolePickLocale: (existing: Array<string | undefined>) =>
    ipcRenderer.invoke('console:pickLocale', existing) as Promise<string>,
  consoleRenameProfile: (input: {
    accountId: string
    email: string
    sessionToken: string
    proxyUrl?: string
    locale: string
  }) =>
    ipcRenderer.invoke('console:renameProfile', input) as Promise<{
      ok: boolean
      error?: string
      displayName?: string
    }>,
  consoleDiscover: (input: {
    sessionToken: string
    proxyUrl?: string
    accountIds: string[]
    pages?: number
    limit?: number
  }) =>
    ipcRenderer.invoke('console:discover', input) as Promise<{
      ok: boolean
      error?: string
      pages: number
      items: number
      inserted: number
      pendingCreated: number
    }>,
  consoleEngageStep: (input: {
    accounts: Array<{ id: string; email: string; sessionToken: string; locale?: string }>
    proxyUrl?: string
    rateMin?: number
    rateMax?: number
  }) =>
    ipcRenderer.invoke('console:engageStep', input) as Promise<{
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
    }>,
  consoleLog: (input: {
    level: 'info' | 'warn' | 'error'
    action: string
    message: string
    accountEmail?: string
    listingId?: string
  }) => ipcRenderer.invoke('console:log', input) as Promise<{ ok: boolean }>,

  createCharConfig: () =>
    ipcRenderer.invoke('createChar:config') as Promise<{
      teamoApiBase: string
      teamoModel: string
      hasApiKey: boolean
      hasAdminToken: boolean
      apiKeyMask: string
      adminTokenMask: string
      adminEmailLocal: string
      adminAccountId: string
      downloadsDir: string
      autoDownloadWatermark: boolean
      featureAspectRatio: string
      featureImageMp: number
      featureAspectOptions: string[]
      featureMpOptions: number[]
    }>,
  createCharStateLoad: () =>
    ipcRenderer.invoke('createChar:stateLoad') as Promise<{
      ok: boolean
      state?: Record<string, unknown>
      images?: Record<number, { imageBase64: string; mimeType: string }>
      updatedAt?: string
    }>,
  createCharStateLoadImage: (slot: 1 | 2 | 3 | 4 | 5) =>
    ipcRenderer.invoke('createChar:stateLoadImage', { slot }) as Promise<{
      ok: boolean
      error?: string
      imageBase64: string | null
      mimeType: string | null
    }>,
  createCharStateSave: (input: {
    state: Record<string, unknown>
    imageUpdates?: Array<{ slot: number; mimeType: string; imageBase64: string | null }>
  }) =>
    ipcRenderer.invoke('createChar:stateSave', input) as Promise<{
      ok: boolean
      error?: string
    }>,
  createCharRuntimeState: () =>
    ipcRenderer.invoke('createChar:runtimeState') as Promise<{
      ok: boolean
      runs: Array<{
        runId: string
        slot: number
        epoch: number
        status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
        stage: string
        [key: string]: unknown
      }>
    }>,
  createCharSaveConfig: (input: {
    teamoApiBase?: string
    teamoApiKey?: string
    teamoModel?: string
    adminSessionToken?: string
    adminEmailLocal?: string
    adminAccountId?: string
    downloadsDir?: string
    autoDownloadWatermark?: boolean
    featureAspectRatio?: string
    featureImageMp?: number
  }) =>
    ipcRenderer.invoke('createChar:saveConfig', input) as Promise<{
      teamoApiBase: string
      teamoModel: string
      hasApiKey: boolean
      hasAdminToken: boolean
      apiKeyMask: string
      adminTokenMask: string
      adminEmailLocal: string
      adminAccountId: string
      downloadsDir: string
      autoDownloadWatermark: boolean
      featureAspectRatio: string
      featureImageMp: number
      featureAspectOptions: string[]
      featureMpOptions: number[]
    }>,
  createCharPickDownloadsDir: () =>
    ipcRenderer.invoke('createChar:pickDownloadsDir') as Promise<{
      ok: boolean
      teamoApiBase: string
      teamoModel: string
      hasApiKey: boolean
      hasAdminToken: boolean
      apiKeyMask: string
      adminTokenMask: string
      adminEmailLocal: string
      adminAccountId: string
      downloadsDir: string
      autoDownloadWatermark: boolean
      featureAspectRatio: string
      featureImageMp: number
      featureAspectOptions: string[]
      featureMpOptions: number[]
      defaultDownloadsDir: string
    }>,
  createCharAnalyze: (input: {
    imageBase64: string
    mimeType?: string
    proxyUrl?: string
    userHint?: string
  }) =>
    ipcRenderer.invoke('createChar:analyze', input) as Promise<{
      ok: boolean
      error?: string
      payload?: Record<string, unknown>
      portraitPrompt?: string
      model?: string
      rawPreview?: string
    }>,
  createCharWaitPortrait: (input: {
    characterId: string
    sessionToken?: string
    proxyUrl?: string
    jobId?: string
    forceRestart?: boolean
  }) =>
    ipcRenderer.invoke('createChar:waitPortrait', input) as Promise<{
      ok: boolean
      error?: string
      cdnUrl?: string
      jobId?: string
      imageDataUrl?: string
      jobStatus?: string
      assetId?: string
    }>,
  createCharRefreshPortrait: (input: {
    characterId: string
    sessionToken?: string
    proxyUrl?: string
  }) =>
    ipcRenderer.invoke('createChar:refreshPortrait', input) as Promise<{
      ok: boolean
      error?: string
      cdnUrl?: string
      assetId?: string
    }>,
  createCharRefreshVideo: (input: {
    characterId: string
    sessionToken?: string
    proxyUrl?: string
  }) =>
    ipcRenderer.invoke('createChar:refreshVideo', input) as Promise<{
      ok: boolean
      error?: string
      videoAssetId?: string
      cdnUrl?: string
    }>,
  createCharCreate: (input: {
    sessionToken?: string
    proxyUrl?: string
    body: Record<string, unknown>
    waitPortrait?: boolean
  }) =>
    ipcRenderer.invoke('createChar:create', input) as Promise<{
      ok: boolean
      error?: string
      status?: number
      data?: Record<string, unknown>
      portrait?: { cdnUrl?: string; jobId?: string; imageDataUrl?: string; assetId?: string }
      createdAs?: string
    }>,
  createCharMotionVideo: (input: {
    characterId: string
    sessionToken?: string
    proxyUrl?: string
    prompt?: string
    inputAssetId?: string
    mode?: 'companion' | 'direct'
  }) =>
    ipcRenderer.invoke('createChar:motionVideo', input) as Promise<{
      ok: boolean
      error?: string
      jobId?: string
      inputAssetId?: string
      outputAssetId?: string
      cdnUrl?: string
      note?: string
      labProjectId?: string
    }>,
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
  }) =>
    ipcRenderer.invoke('createChar:setPreviewPublish', input) as Promise<{
      ok: boolean
      error?: string
      listingId?: string
      draftOk?: boolean
      videoAttachOk?: boolean
      publishOk?: boolean
      data?: Record<string, unknown>
    }>,
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
  }) =>
    ipcRenderer.invoke('createChar:generateMotionOnly', input) as Promise<{
      ok: boolean
      error?: string
      motionPrompt?: string
      coverAssetId?: string
      videoAssetId?: string
      cdnUrl?: string
      labProjectId?: string
    }>,
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
  }) =>
    ipcRenderer.invoke('createChar:autoVideoPublish', input) as Promise<{
      ok: boolean
      error?: string
      motionPrompt?: string
      coverAssetId?: string
      videoAssetId?: string
      cdnUrl?: string
      listingId?: string
      labProjectId?: string
      publishOk?: boolean
    }>,
  createCharEnqueueJob: (input: {
    jobKind: 'create' | 'motion' | 'autoPublish' | 'pullPublish' | 'fullAuto'
    clientRunId: string
    clientSlot: 1 | 2 | 3 | 4 | 5
    clientRunEpoch: number
    proxyUrl?: string
    sessionToken?: string
    imageBase64?: string
    mimeType?: string
    userHint?: string
    body?: Record<string, unknown>
    waitPortrait?: boolean
    characterId?: string
    portraitCdnUrl?: string
    coverAssetId?: string
    characterHint?: string
    appearanceHint?: string
    payload?: Record<string, unknown>
    motionPromptOverride?: string
    title?: string
    description?: string
  }) =>
    ipcRenderer.invoke('createChar:enqueueJob', input) as Promise<{
      ok: boolean
      error?: string
      cancelled?: boolean
      runId?: string
      runStartedAt?: number
      status?: number
      data?: Record<string, unknown>
      portrait?: { cdnUrl?: string; jobId?: string; imageDataUrl?: string; assetId?: string }
      characterId?: string
      payload?: Record<string, unknown>
      portraitPrompt?: string
      motionPrompt?: string
      coverAssetId?: string
      videoAssetId?: string
      cdnUrl?: string
      videoCdnUrl?: string
      listingId?: string
      portraitCdnUrl?: string
      portraitJobId?: string
    }>,
  createCharFullAutoPublish: (input: {
    imageBase64: string
    mimeType?: string
    proxyUrl?: string
    sessionToken?: string
    userHint?: string
    clientSlot?: 1 | 2 | 3 | 4 | 5
    clientRunEpoch?: number
    clientRunId: string
  }) =>
    ipcRenderer.invoke('createChar:fullAutoPublish', input) as Promise<{
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
    }>,
  createCharCancelFullAuto: (input: { runId: string }) =>
    ipcRenderer.invoke('createChar:cancelFullAuto', input) as Promise<{
      ok: boolean
      error?: string
    }>,
  createCharCancelJob: (input: { runId: string }) =>
    ipcRenderer.invoke('createChar:cancelJob', input) as Promise<{
      ok: boolean
      error?: string
    }>,
  onCreateCharProgress: (
    cb: (p: {
      stage: string
      jobKind?: 'create' | 'motion' | 'autoPublish' | 'pullPublish' | 'fullAuto'
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
  ) => {
    const handler = (
      _e: unknown,
      p: {
        stage: string
        jobKind?: 'create' | 'motion' | 'autoPublish' | 'pullPublish' | 'fullAuto'
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
      },
    ) => cb(p)
    ipcRenderer.on('createChar:progress', handler)
    return () => {
      ipcRenderer.removeListener('createChar:progress', handler)
    }
  },
  createCharCacheMedia: (input: {
    cdnUrl: string
    proxyUrl?: string
    displayName?: string
    kind?: 'portrait' | 'video' | 'media'
    characterId?: string
    assetId?: string
    runId?: string
  }) =>
    ipcRenderer.invoke('createChar:cacheMedia', input) as Promise<{
      ok: boolean
      error?: string
      fileName?: string
      localPath?: string
      cacheUrl?: string
      bytes?: number
      twitterPath?: string
    }>,

  featureMaterialEnqueue: (input: {
    runId: string
    userPrompt: string
    proxyUrl?: string
    sessionToken?: string
    aspectRatio?: string
    imageMp?: number
  }) =>
    ipcRenderer.invoke('featureMaterial:enqueue', input) as Promise<{
      ok: boolean
      error?: string
      cancelled?: boolean
      runId: string
      runStartedAt?: number
      title?: string
      prompt?: string
      detail?: string
      model?: string
      jobId?: string
      assetId?: string
      cdnUrl?: string
      cacheUrl?: string
      localPath?: string
      twitterPath?: string
      watermarkApplied?: boolean
      aspectRatio?: string
      imageMp?: number
      width?: number
      height?: number
    }>,
  featureMaterialCancel: (input: { runId: string }) =>
    ipcRenderer.invoke('featureMaterial:cancel', input) as Promise<{
      ok: boolean
      error?: string
      running?: boolean
    }>,
  featureMaterialList: () =>
    ipcRenderer.invoke('featureMaterial:list') as Promise<{
      ok: boolean
      items: Array<{
        runId: string
        userPrompt: string
        stage: string
        title?: string
        prompt?: string
        detail?: string
        jobId?: string
        assetId?: string
        cdnUrl?: string
        cacheUrl?: string
        localPath?: string
        twitterPath?: string
        watermarkApplied?: boolean
        error?: string
        createdAt: number
        updatedAt: number
      }>
    }>,
  featureMaterialDelete: (input: { runId: string }) =>
    ipcRenderer.invoke('featureMaterial:delete', input) as Promise<{
      ok: boolean
      error?: string
    }>,
  onFeatureMaterialProgress: (
    cb: (progress: {
      runId: string
      stage: string
      queuePosition?: number
      runStartedAt?: number
      progress?: number
      title?: string
      prompt?: string
      detail?: string
      jobId?: string
      error?: string
      cdnUrl?: string
      cacheUrl?: string
      twitterPath?: string
      watermarkApplied?: boolean
    }) => void,
  ) => {
    const handler = (_event: unknown, progress: Parameters<typeof cb>[0]) => cb(progress)
    ipcRenderer.on('featureMaterial:progress', handler)
    return () => ipcRenderer.removeListener('featureMaterial:progress', handler)
  },

  captionGenerate: (input: {
    proxyUrl?: string
    images: Array<{ base64: string; mimeType?: string }>
    fileName?: string
    characterName?: string
    userHint?: string
    style?: 'standard' | 'twitterComment'
  }) =>
    ipcRenderer.invoke('caption:generate', input) as Promise<{
      ok: boolean
      error?: string
      caption?: string
      ownerName?: string
      characterName?: string
      model?: string
      style?: 'standard' | 'twitterComment'
      kinkLabel?: string
      rawPreview?: string
    }>,

  tgautoSettingsGet: () =>
    ipcRenderer.invoke('caption:tgautoSettingsGet') as Promise<{
      baseUrl: string
      peer: string
      accountIds: number[]
      skipPosted: boolean
    }>,
  tgautoSettingsSave: (patch: {
    baseUrl?: string
    peer?: string
    accountIds?: number[]
    skipPosted?: boolean
  }) =>
    ipcRenderer.invoke('caption:tgautoSettingsSave', patch) as Promise<{
      baseUrl: string
      peer: string
      accountIds: number[]
      skipPosted: boolean
    }>,
  tgautoHealth: (input?: { baseUrl?: string }) =>
    ipcRenderer.invoke('caption:tgautoHealth', input) as Promise<{
      ok: boolean
      error?: string
      baseUrl: string
    }>,
  tgautoPreview: () =>
    ipcRenderer.invoke('caption:tgautoPreview') as Promise<{
      ok: boolean
      settings: {
        baseUrl: string
        peer: string
        accountIds: number[]
        skipPosted: boolean
      }
      resourceDir: string
      total: number
      pending: number
      posted: number
      characters: string[]
    }>,
  tgautoBatchStart: (input: {
    proxyUrl: string
    baseUrl?: string
    peer?: string
    accountIds?: number[]
    skipPosted?: boolean
  }) =>
    ipcRenderer.invoke('caption:tgautoBatchStart', input) as Promise<{
      ok: boolean
      error?: string
      posted: number
      failed: number
      skipped: number
      total: number
    }>,
  tgautoBatchCancel: () =>
    ipcRenderer.invoke('caption:tgautoBatchCancel') as Promise<{ ok: boolean; running: boolean }>,
  tgautoBatchRunning: () =>
    ipcRenderer.invoke('caption:tgautoBatchRunning') as Promise<{ running: boolean }>,
  onTgautoBatchProgress: (
    cb: (progress: {
      phase: string
      index?: number
      total?: number
      char?: string
      accountId?: number
      message?: string
      ok?: boolean
      error?: string
      posted?: number
      failed?: number
      skipped?: number
    }) => void,
  ) => {
    const handler = (_event: unknown, progress: Parameters<typeof cb>[0]) => cb(progress)
    ipcRenderer.on('caption:tgautoBatchProgress', handler)
    return () => ipcRenderer.removeListener('caption:tgautoBatchProgress', handler)
  },
})
