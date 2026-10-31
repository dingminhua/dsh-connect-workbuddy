import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { WorkBuddyWireIdentity } from '../src/upstream.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyDeviceProfileLookup } from '../src/device-profile.ts'
import type { TuringTokenSource } from '../src/turing-sdk.ts'

/**
 * P1 —— 出站身份档位（`docs/DEVICE-IDENTITY-AUDIT.md` 的 P1）。
 *
 * 两档的契约完全不同，因此这里分两组测：
 *   - `balanced`（默认）：每一条请求说同一种话，billing 不再是裸 HTTP 客户端。
 *   - `conservative`：**逐字节**等于 5.16.0，连 `X-Product: SaaS` 都还原。
 *
 * 盐一律显式注入（`SALT`），所以这些测试不读盘、不创建 `$DSH_HOME` 下的任何文件，
 * 也不依赖运行顺序。
 */

const SALT = 'a'.repeat(64)

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'access-token-fixture',
  refreshToken: 'refresh-token-fixture',
  expiresAtMs: 0,
  domain: 'www.codebuddy.cn',
  uid: 'u-1',
  enterpriseId: 'ent-1',
  source: 'desktop',
  filePath: '/tmp/workbuddy-desktop.info',
}

const credential = (overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential => ({
  ...CREDENTIAL,
  ...overrides,
})

type Kind = 'chat' | 'billing' | 'refresh'

/**
 * Run one request through the real client with `fetch` stubbed, and return the
 * headers it actually put on the wire.
 *
 * `init.headers` is a plain object in every path this module builds, so copying
 * it is enough — no Header instance is involved.
 */
async function headersOf(
  kind: Kind,
  identity: WorkBuddyWireIdentity,
  overrides: Partial<WorkBuddyCredential> = {},
  options: {
    deviceTokenFile?: string
    deviceProfiles?: WorkBuddyDeviceProfileLookup
    realDevice?: TuringTokenSource
  } = {},
): Promise<Record<string, string>> {
  const seen: Record<string, string> = {}
  vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
    Object.assign(seen, init.headers)
    const body = kind === 'refresh'
      // refreshToken() refuses an envelope without a token; give it one so the
      // caught headers are the ones under test, not a failure path.
      ? { code: 0, data: { accessToken: 'next-access-token' } }
      : { code: 0, data: {} }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  })
  const client = new WorkBuddyUpstreamClient(undefined, identity, options)
  const cred = credential(overrides)
  if (kind === 'chat') await client.chatStream(cred, '{}')
  else if (kind === 'billing') await client.claimDailyCheckin(cred)
  else await client.refreshToken(cred)
  return seen
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('balanced — one client identity everywhere', () => {
  it('claims WorkBuddy for product, IDE name, IDE type and agent purpose', async () => {
    // Before P1 these four disagreed: product said "SaaS" (a generic tenant),
    // type said "CLI", name said "WorkBuddy", and purpose was absent.
    const seen = await headersOf('chat', { profile: 'balanced', deviceSalt: SALT })
    expect(seen['X-Product']).toBe('WorkBuddy')
    expect(seen['X-IDE-Name']).toBe('WorkBuddy')
    expect(seen['X-IDE-Type']).toBe('WorkBuddy')
    expect(seen['X-Agent-Purpose']).toBe('conversation')
    expect(seen['X-IDE-Version']).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('sends the risk-control gate header and the account language', async () => {
    const cn = await headersOf('chat', { profile: 'balanced', deviceSalt: SALT })
    expect(cn['X-CodeBuddy-Request']).toBe('1')
    expect(cn['Accept-Language']).toBe('zh-CN')
    const global = await headersOf('chat', { profile: 'balanced', deviceSalt: SALT }, { domain: 'www.workbuddy.ai' })
    expect(global['Accept-Language']).toBe('en-US')
  })

  it('gives the request a root id that IS the conversation-request id', async () => {
    // Not a fourth id: the root of this request is the request. Sending a
    // different value would announce two roots for one turn.
    const seen = await headersOf('chat', { profile: 'balanced', deviceSalt: SALT })
    expect(seen['X-Root-Request-ID']).toBe(seen['X-Conversation-Request-ID'])
  })

  it('sends the per-account device pair, and no token when none is configured', async () => {
    // Virtual tier with no token source at all: the pair is the whole identity.
    // A token APPEARS here only when one is configured (the P2 file source); the
    // real tier drops the pair instead — see the P3 block below.
    const seen = await headersOf('chat', { profile: 'balanced', deviceSalt: SALT })
    expect(seen['X-Machine-ID']).toMatch(/^[0-9a-f]{36}$/)
    expect(seen['X-Session-ID']).toMatch(/^[0-9a-f]{36}$/)
    expect(seen['X-Machine-ID']).not.toBe(seen['X-Session-ID'])
    expect(seen['X-Device-Token']).toBeUndefined()
  })

  it('keeps one device per account, stable across requests', async () => {
    const first = await headersOf('chat', { profile: 'balanced', deviceSalt: SALT })
    const second = await headersOf('chat', { profile: 'balanced', deviceSalt: SALT })
    expect(second['X-Machine-ID']).toBe(first['X-Machine-ID'])
    const other = await headersOf('chat', { profile: 'balanced', deviceSalt: SALT }, { uid: 'u-2' })
    expect(other['X-Machine-ID']).not.toBe(first['X-Machine-ID'])
  })

  it('drops the pair entirely when the salt is unavailable', async () => {
    // No salt → no device identity at all. Half a pair (machine without session)
    // is a shape a real client never sends, and a temporary random salt would
    // mint a new device per process start.
    //
    // The unavailability is produced for real, by pointing `$DSH_HOME` at a path
    // whose parent is a FILE: creating the lock/index there fails with ENOTDIR,
    // so the client resolves an identity without a salt instead of inventing one.
    const dir = await mkdtemp(join(tmpdir(), 'wb-no-salt-'))
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'not a directory')
    vi.stubEnv('DSH_HOME', join(blocker, 'nested'))
    try {
      const seen = await headersOf('chat', { profile: 'balanced' })
      expect(seen['X-Machine-ID']).toBeUndefined()
      expect(seen['X-Session-ID']).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('dresses billing like chat instead of a bare HTTP client', async () => {
    // The audit's D2: same token, same minute, billing used to send no UA, no
    // Origin/Referer, no client identity — the single most static-checkable
    // inconsistency in the plugin. Billing is also where the WRITE endpoints
    // live (check-in, compensation), so it is the last path that should look
    // unusual.
    const seen = await headersOf('billing', { profile: 'balanced', deviceSalt: SALT })
    expect(seen['User-Agent']).toMatch(/^WorkBuddy\/\d+\.\d+\.\d+/)
    expect(seen['Origin']).toBe('https://www.codebuddy.cn')
    expect(seen['Referer']).toBe('https://www.codebuddy.cn/')
    expect(seen['X-Requested-With']).toBe('XMLHttpRequest')
    expect(seen['X-CodeBuddy-Request']).toBe('1')
    expect(seen['Accept-Language']).toBe('zh-CN')
    expect(seen['X-Product']).toBe('WorkBuddy')
    expect(seen['X-IDE-Name']).toBe('WorkBuddy')
    expect(seen['X-Machine-ID']).toMatch(/^[0-9a-f]{36}$/)
  })

  it('leaves refresh on the 5.16.0 bytes, with its own token', async () => {
    // refresh 是整条链路里唯一"失败就等于掉登录"的一跳，所以它不参与 P1 的
    // 身份统一：没有归属头、没有设备头，**连 CodeBuddy-Request / Accept-Language
    // 也不加**（B 会加，但那是 B 一直在跑的形状；本插件没有在 refresh 上验过
    // 任何新头）。这条断言就是"统一"的边界——凡是维护类/元数据类的一跳，
    // 字节保持原样。
    const seen = await headersOf('refresh', { profile: 'balanced', deviceSalt: SALT })
    expect(seen['X-Refresh-Token']).toBe('refresh-token-fixture')
    expect(seen['Authorization']).toBeUndefined()
    expect(seen['User-Agent']).toBe('CLI/2.63.2 CodeBuddy/2.63.2')
    expect(seen['X-CodeBuddy-Request']).toBeUndefined()
    expect(seen['Accept-Language']).toBeUndefined()
    expect(seen['X-Product']).toBeUndefined()
    expect(seen['X-Machine-ID']).toBeUndefined()
  })
})

describe('P2 — the external device token (file source)', () => {
  it('sends nothing when no token source is configured', async () => {
    const seen = await headersOf('chat', { profile: 'balanced', deviceSalt: SALT })
    expect(seen['X-Device-Token']).toBeUndefined()
  })

  it('reads the token from the configured file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-token-wire-'))
    const file = join(dir, 'token')
    await writeFile(file, 'v3:from-file\n')
    try {
      const seen = await headersOf('chat', { profile: 'balanced', deviceSalt: SALT }, {}, { deviceTokenFile: file })
      expect(seen['X-Device-Token']).toBe('v3:from-file')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('carries the token on billing too, and never on refresh', async () => {
    const billing = await headersOf('billing', { profile: 'balanced', deviceSalt: SALT, deviceToken: 'v3:abc' })
    expect(billing['X-Device-Token']).toBe('v3:abc')
    const refresh = await headersOf('refresh', { profile: 'balanced', deviceSalt: SALT, deviceToken: 'v3:abc' })
    expect(refresh['X-Device-Token']).toBeUndefined()
  })

  it('skips the header when the configured file cannot be read', async () => {
    // A missing/unreadable token degrades to "no header", never to a made-up
    // value and never to a failed request.
    const seen = await headersOf('chat', { profile: 'balanced', deviceSalt: SALT }, {}, { deviceTokenFile: '/nonexistent/device-token' })
    expect(seen['X-Device-Token']).toBeUndefined()
    // The rest of the identity is unaffected.
    expect(seen['X-Machine-ID']).toMatch(/^[0-9a-f]{36}$/)
  })

  it('sends the file token alongside the derived pair — still the virtual tier', async () => {
    // P3 moved the exclusivity rule to the TIER, not to "a token exists". A file
    // source is a virtual-tier feature: it supplies a token someone else wrote,
    // and the account still presents its own derived pair. The real tier is a
    // different path entirely (see the P3 block below), so this shape is not a
    // contradiction — it is the virtual tier with an extra header.
    const seen = await headersOf('chat', { profile: 'balanced', deviceSalt: SALT, deviceToken: 'v3:abc' })
    expect(seen['X-Device-Token']).toBe('v3:abc')
    expect(seen['X-Machine-ID']).toMatch(/^[0-9a-f]{36}$/)
    expect(seen['X-Session-ID']).toMatch(/^[0-9a-f]{36}$/)
  })
})

/**
 * P3 —— 真实值档：所有账号共用这台机器的真实设备。
 *
 * 这一组的核心断言只有一个：**真实值档下不会出现派生的 id**。审计 §5.3 的
 * 结论是"真 token 旁边挂一对按 uid 算出来的 id 等于自证不一致"，所以互斥不是
 * "少发几个头"，而是两条互斥的路径。
 */
describe('P3 — the real tier', () => {
  const tokenSource = (token: string | undefined): TuringTokenSource => ({
    current: async () => token,
    readout: () => ({ state: token === undefined ? 'unavailable' : 'ok', masked: token === undefined ? '' : 'v3:****************', length: token?.length ?? 0 }),
    refresh: async () => ({ state: 'ok', masked: '', length: 0 }),
    reveal: async () => token,
  })
  const realMode = (mode: 'real' | 'virtual'): WorkBuddyDeviceProfileLookup => ({
    forUid: async () => ({ machineId: 'c'.repeat(36), sessionId: 'd'.repeat(36) }),
    mode: async () => mode,
  })

  it('sends the real token and NOT the derived pair', async () => {
    const seen = await headersOf('chat', { profile: 'balanced', deviceSalt: SALT }, {}, {
      deviceProfiles: realMode('real'),
      realDevice: tokenSource('v3:real'),
    })
    expect(seen['X-Device-Token']).toBe('v3:real')
    expect(seen['X-Machine-ID']).toBeUndefined()
    expect(seen['X-Session-ID']).toBeUndefined()
  })

  it('ignores the per-account overrides — one machine cannot be two devices', async () => {
    // The gear would have written machineId 'cccc…'. In the real tier that value
    // must not reach the wire even though the file still holds it.
    const seen = await headersOf('chat', { profile: 'balanced', deviceSalt: SALT }, {}, {
      deviceProfiles: realMode('real'),
      realDevice: tokenSource('v3:real'),
    })
    expect(seen['X-Machine-ID']).toBeUndefined()
  })

  it('sends no device header at all when the SDK has no token', async () => {
    // NOT a fallback to the derived pair: that would make the card say "real"
    // while the wire says "virtual", which is the one thing the tier split
    // exists to prevent.
    const seen = await headersOf('chat', { profile: 'balanced', deviceSalt: SALT }, {}, {
      deviceProfiles: realMode('real'),
      realDevice: tokenSource(undefined),
    })
    expect(seen['X-Device-Token']).toBeUndefined()
    expect(seen['X-Machine-ID']).toBeUndefined()
    expect(seen['X-Session-ID']).toBeUndefined()
    // Everything else about the identity is untouched.
    expect(seen['X-Product']).toBe('WorkBuddy')
  })

  it('carries the real token on billing too', async () => {
    const seen = await headersOf('billing', { profile: 'balanced', deviceSalt: SALT }, {}, {
      deviceProfiles: realMode('real'),
      realDevice: tokenSource('v3:real'),
    })
    expect(seen['X-Device-Token']).toBe('v3:real')
  })

  it('keeps conservative byte-identical even in the real tier', async () => {
    // The rollback tier is a promise about BYTES, so it wins over the tier
    // selection: a user who set `conservative` gets 5.16.0, full stop.
    const seen = await headersOf('chat', { profile: 'conservative', deviceSalt: SALT }, {}, {
      deviceProfiles: realMode('real'),
      realDevice: tokenSource('v3:real'),
    })
    expect(seen['X-Device-Token']).toBeUndefined()
    expect(seen['X-Machine-ID']).toBeUndefined()
    expect(seen['X-Product']).toBe('SaaS')
  })
})

describe('conservative — the 5.16.0 bytes, exactly', () => {
  it('restores X-Product: SaaS and drops every P1 header', async () => {
    const seen = await headersOf('chat', { profile: 'conservative', deviceSalt: SALT })
    expect(seen['X-Product']).toBe('SaaS')
    for (const name of [
      'X-Agent-Purpose',
      'X-IDE-Name',
      'X-IDE-Type',
      'X-IDE-Version',
      'X-CodeBuddy-Request',
      'Accept-Language',
      'X-Root-Request-ID',
      'X-Machine-ID',
      'X-Session-ID',
    ]) {
      expect(seen[name], name).toBeUndefined()
    }
    // The three headers the chat gate DOES require must survive the fallback.
    expect(seen['X-Conversation-ID']).toBeTruthy()
    expect(seen['X-Conversation-Request-ID']).toBeTruthy()
    expect(seen['X-Conversation-Message-ID']).toBeTruthy()
  })

  it('leaves billing a bare client again — the shape this profile exists to restore', async () => {
    // Pinned so the fallback cannot drift into "half of balanced". This is the
    // exact defect D2 describes, kept available on purpose.
    const seen = await headersOf('billing', { profile: 'conservative', deviceSalt: SALT })
    expect(seen['User-Agent']).toBeUndefined()
    expect(seen['Origin']).toBeUndefined()
    expect(seen['Referer']).toBeUndefined()
    expect(seen['X-Requested-With']).toBeUndefined()
    expect(seen['X-CodeBuddy-Request']).toBeUndefined()
    expect(seen['X-Product']).toBeUndefined()
    expect(seen['Authorization']).toBe('Bearer access-token-fixture')
  })
})
