export type VlessNode = {
  uuid: string
  server: string
  port: number
  flow?: string
  security?: string
  encryption?: string
  network?: string
  sni?: string
  fp?: string
  pbk?: string
  sid?: string
  spx?: string
  type?: string
  path?: string
  host?: string
  raw: string
}

/** 解析 vless://uuid@host:port?query */
export function parseVlessUri(uri: string): VlessNode {
  const trimmed = uri.trim()
  if (!trimmed.toLowerCase().startsWith('vless://')) {
    throw new Error('不是 vless:// 链接')
  }
  const withoutScheme = trimmed.slice('vless://'.length)
  const at = withoutScheme.indexOf('@')
  if (at < 0) throw new Error('vless URI 缺少 @')
  const uuid = decodeURIComponent(withoutScheme.slice(0, at))
  const rest = withoutScheme.slice(at + 1)
  const qIndex = rest.indexOf('?')
  const hostPort = qIndex >= 0 ? rest.slice(0, qIndex) : rest
  const query = qIndex >= 0 ? rest.slice(qIndex + 1) : ''
  const colon = hostPort.lastIndexOf(':')
  if (colon < 0) throw new Error('vless URI 缺少端口')
  const server = hostPort.slice(0, colon)
  const port = Number(hostPort.slice(colon + 1))
  if (!server || !port) throw new Error('vless 主机/端口无效')

  const params = new URLSearchParams(query.split('#')[0])
  return {
    uuid,
    server,
    port,
    flow: params.get('flow') || undefined,
    security: params.get('security') || undefined,
    encryption: params.get('encryption') || undefined,
    network: params.get('type') || params.get('network') || 'tcp',
    sni: params.get('sni') || undefined,
    fp: params.get('fp') || undefined,
    pbk: params.get('pbk') || undefined,
    sid: params.get('sid') || undefined,
    spx: params.get('spx') || undefined,
    type: params.get('type') || undefined,
    path: params.get('path') || undefined,
    host: params.get('host') || undefined,
    raw: trimmed,
  }
}

/** 订阅正文：纯 base64 或明文多行 → 全部 vless:// */
export function extractAllVlessUris(body: string): string[] {
  const text = body.trim()
  let decoded = text
  if (!/^vless:\/\//i.test(text)) {
    try {
      decoded = Buffer.from(text, 'base64').toString('utf8').trim()
    } catch {
      /* keep */
    }
  }
  const lines = decoded
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^vless:\/\//i.test(l))
  return [...new Set(lines)]
}

/** 订阅正文：纯 base64 或明文多行 */
export function extractVlessFromSubscriptionBody(body: string): VlessNode {
  const lines = extractAllVlessUris(body)
  if (!lines.length) throw new Error('订阅内容中未找到 vless:// 节点')
  return parseVlessUri(lines[0])
}

export function buildSingBoxConfig(node: VlessNode, listenPort: number) {
  const outbound: Record<string, unknown> = {
    type: 'vless',
    tag: 'vless-out',
    server: node.server,
    server_port: node.port,
    uuid: node.uuid,
    packet_encoding: 'xudp',
  }
  if (node.flow) outbound.flow = node.flow

  if (node.security === 'reality' || node.pbk) {
    outbound.tls = {
      enabled: true,
      server_name: node.sni || node.server,
      utls: node.fp ? { enabled: true, fingerprint: node.fp } : { enabled: true, fingerprint: 'chrome' },
      reality: {
        enabled: true,
        public_key: node.pbk,
        short_id: node.sid || '',
      },
    }
  } else if (node.security === 'tls') {
    outbound.tls = {
      enabled: true,
      server_name: node.sni || node.server,
      utls: node.fp ? { enabled: true, fingerprint: node.fp } : undefined,
    }
  }

  if (node.network && node.network !== 'tcp') {
    outbound.transport = {
      type: node.network,
      path: node.path,
      headers: node.host ? { Host: node.host } : undefined,
    }
  }

  return {
    log: { level: 'warn', timestamp: true },
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: listenPort,
      },
    ],
    outbounds: [
      outbound,
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
    ],
    route: {
      final: 'vless-out',
    },
  }
}
