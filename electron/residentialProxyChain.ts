import net from 'node:net'
import { Server as ProxyChainServer } from 'proxy-chain'
import { HttpsProxyAgent } from 'https-proxy-agent'

const DEFAULT_LOCAL_PORTS = [7897, 7890]

export type LocalUpstreamOptions = {
  host?: string
  ports?: number[]
}

export type ResidentialChainHandle = {
  /** 本机链式代理，供 undici ProxyAgent 使用 */
  proxyUrl: string
  /** 实际连上的本地 Clash mixed-port */
  localUpstreamUrl: string
  close: () => Promise<void>
}

async function isPortOpen(host: string, port: number, timeoutMs = 900): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (ok: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(timeoutMs, () => done(false))
  })
}

/** 探测本地 Clash mixed-port（优先设置里的端口，再试 7897 / 7890） */
export async function resolveLocalUpstreamProxy(opts?: LocalUpstreamOptions): Promise<string | null> {
  const host = (opts?.host || '127.0.0.1').trim() || '127.0.0.1'
  const ports = (opts?.ports?.length ? opts.ports : DEFAULT_LOCAL_PORTS).filter((p) => p > 0)
  const seen = new Set<number>()
  for (const port of ports) {
    if (seen.has(port)) continue
    seen.add(port)
    if (await isPortOpen(host, port)) return `http://${host}:${port}`
  }
  return null
}

function listenChainServer(server: ProxyChainServer): Promise<void> {
  return server.listen()
}

function closeChainServer(server: ProxyChainServer): Promise<void> {
  return server.close(true)
}

/**
 * 本地 Clash → 静态住宅 HTTP 代理 → 目标站
 * 返回本机临时代理 URL，任务结束后需 close()
 */
export async function openResidentialProxyChain(
  residentialProxyUrl: string,
  localUpstreamUrl: string,
): Promise<ResidentialChainHandle> {
  const upstreamAgent = new HttpsProxyAgent(localUpstreamUrl)

  const server = new ProxyChainServer({
    port: 0,
    host: '127.0.0.1',
    prepareRequestFunction: () => ({
      upstreamProxyUrl: residentialProxyUrl,
      httpAgent: upstreamAgent,
      httpsAgent: upstreamAgent,
    }),
  })

  await listenChainServer(server)
  const port = server.port
  if (!port) {
    await closeChainServer(server)
    throw new Error('链式代理启动失败')
  }

  return {
    proxyUrl: `http://127.0.0.1:${port}`,
    localUpstreamUrl,
    close: () => closeChainServer(server),
  }
}

export async function withResidentialProxyChain<T>(
  residentialProxyUrl: string,
  localOpts: LocalUpstreamOptions | undefined,
  fn: (ctx: { proxyUrl: string; localUpstreamUrl: string }) => Promise<T>,
): Promise<T> {
  const localUpstreamUrl = await resolveLocalUpstreamProxy(localOpts)
  if (!localUpstreamUrl) {
    const ports = (localOpts?.ports?.length ? localOpts.ports : DEFAULT_LOCAL_PORTS).join('、')
    throw new Error(`本地代理未监听（已尝试 ${ports}）`)
  }

  const chain = await openResidentialProxyChain(residentialProxyUrl, localUpstreamUrl)
  try {
    return await fn({ proxyUrl: chain.proxyUrl, localUpstreamUrl: chain.localUpstreamUrl })
  } finally {
    await chain.close()
  }
}
