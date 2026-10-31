import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { WorkBuddyWireIdentity } from '../src/upstream.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

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
async function headersOf(kind: Kind, identity: WorkBuddyWireIdentity, overrides: Partial<WorkBuddyCredential> = {}): Promise<Record<string, string>> {
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
  const client = new WorkBuddyUpstreamClient(undefined, identity)
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

  it('sends the per-account device pair, and never a device token', async () => {
    // The pair is the P1 (synthetic) tier. X-Device-Token is P2/P3 and must stay
    // absent here: a real token plus a derived machine id is the self-
    // contradiction the audit's §5.3 warns about.
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

  it('keeps refresh on common headers only, with its own token', async () => {
    // refresh is a maintenance hop: it carries X-Refresh-Token and no Bearer,
    // and it deliberately does NOT carry the attribution/device family — that
    // is the one place where the two reference implementations agree on staying
    // thin, and the one call that must never fail for a cosmetic reason.
    const seen = await headersOf('refresh', { profile: 'balanced', deviceSalt: SALT })
    expect(seen['X-Refresh-Token']).toBe('refresh-token-fixture')
    expect(seen['Authorization']).toBeUndefined()
    expect(seen['X-CodeBuddy-Request']).toBe('1')
    expect(seen['X-Product']).toBeUndefined()
    expect(seen['X-Machine-ID']).toBeUndefined()
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
