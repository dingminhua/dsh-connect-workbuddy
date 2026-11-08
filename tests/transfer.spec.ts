import { describe, expect, it } from 'vitest'
import {
  credentialOfTransferRecord,
  mergeTransferRecords,
  parseTransferFile,
  previewTransferFile,
  transferRecordOf,
} from '../src/transfer.ts'
import { workbuddyAccountId } from '../src/auth.ts'
import { knownRegionOf } from '../src/upstream.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

/**
 * The transfer module is the INTEROP contract with sibling credential
 * managers: a JSON array of snake_case records, uid-keyed merge, preview
 * without token material. These tests pin the format from BOTH directions —
 * parsing a file the sibling tool writes, and producing a file the sibling
 * tool can read back.
 */

/** A minimal sibling-format record (as another tool exports it). */
function siblingRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'generated-id',
    uid: 'u-1',
    nickname: '小明',
    email: 'a@b.c',
    access_token: 'at-1',
    refresh_token: 'rt-1',
    token_type: 'Bearer',
    domain: 'workbuddy.cn',
    expiresAt: 1893456000000,
    createdAt: 1,
    ...overrides,
  }
}

/** A vault-shaped credential for export tests. */
function vaultCredential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: 'at-vault',
    refreshToken: 'rt-vault',
    expiresAtMs: 1893456000000,
    refreshExpiresAtMs: 1896048000000,
    lastRefreshAtMs: 1700000000000,
    domain: 'workbuddy.cn',
    uid: 'u-9',
    nickname: '阿九',
    uin: '10001',
    source: 'dsh',
    filePath: '/vault/abc.json',
    ...overrides,
  }
}

describe('parseTransferFile', () => {
  it('accepts a JSON array of objects and rejects everything else with a positioned error', () => {
    expect(parseTransferFile(JSON.stringify([siblingRecord(), siblingRecord({ uid: 'u-2' })]))).toHaveLength(2)
    expect(() => parseTransferFile('')).toThrow('empty')
    expect(() => parseTransferFile('not json')).toThrow('JSON')
    expect(() => parseTransferFile('{"a":1}')).toThrow('array')
    expect(() => parseTransferFile('[{"uid":"u1"},42]')).toThrow('item 2')
  })

  /**
   * ISSUE #229: 「导出的账号 JSON 文件导入失败 … 导出导入流程闭环失效」.
   *
   * The importer demanded a bare array. Several sibling tools — and this
   * plugin's OWN `?action=export` answer, which is `{accounts: [...]}` — wrap the
   * same records one level down, so a user who saved that JSON verbatim had a
   * file that already held every record and was still refused. The loop has to
   * close against the files that exist, not only the one shape the reader
   * happened to write first.
   */
  it('reads the records out of the wrappers sibling tools emit', () => {
    const records = [siblingRecord(), siblingRecord({ uid: 'u-2' })]
    // A bare array stays the primary format.
    expect(parseTransferFile(JSON.stringify(records))).toHaveLength(2)
    // THE one that closes the loop: this plugin's own export response body.
    expect(parseTransferFile(JSON.stringify({ accounts: records }))).toHaveLength(2)
    expect(parseTransferFile(JSON.stringify({ data: records }))).toHaveLength(2)
    expect(parseTransferFile(JSON.stringify({ records }))).toHaveLength(2)
    // …and the envelope-of-envelope form, bounded to one extra level.
    expect(parseTransferFile(JSON.stringify({ code: 0, data: { accounts: records } }))).toHaveLength(2)
  })

  it('is bounded at one extra level, and proves it by walking deep', () => {
    // THIS TEST EXISTS BECAUSE THE FIRST VERSION OF THE FIX LIED.
    //
    // `recordsOf` recursed unconditionally while its comment said "bounded on
    // purpose: one extra level". The claim was false — measured, an array of
    // records wrapped 200 levels deep was still accepted, which defeats the very
    // reason the wrappers are recognized BY NAME: a log dump with an array under
    // `data` would have been read as a credential file.
    //
    // A comment cannot be tested. This asserts the bound by walking past it.
    const records = [siblingRecord()]
    expect(parseTransferFile(JSON.stringify({ data: { accounts: records } }))).toHaveLength(1)
    let deep: unknown = records
    for (let i = 0; i < 200; i += 1) deep = { data: deep }
    expect(() => parseTransferFile(JSON.stringify(deep))).toThrow('array')
  })

  it('still refuses a document whose shape it does not recognize, and says what it saw', () => {
    // Not every object is a transfer file: a wrapper must be recognized BY NAME.
    // Scanning for "the first array anywhere" would accept a log dump.
    expect(() => parseTransferFile(JSON.stringify({ unrelated: [] }))).toThrow('array')
    // The message names the actual top level, so 「导入失败」 becomes actionable
    // instead of leaving the user to guess whether the file or the importer is wrong.
    expect(() => parseTransferFile(JSON.stringify({ a: 1, b: 2 }))).toThrow('a, b')
    expect(() => parseTransferFile('null')).toThrow('null')
    // A wrapper whose array holds a non-object still reports the POSITION, which
    // is what lets the user find the broken record in an editor.
    expect(() => parseTransferFile(JSON.stringify({ accounts: [{ uid: 'u1' }, 42] }))).toThrow('item 2')
  })
})

describe('previewTransferFile', () => {
  it('exposes only desensitized fields plus hasToken, normalizing dirty display values', () => {
    const dirty = JSON.stringify([
      { uid: { nested: true }, nickname: { zh: '信封昵称' }, email: ['a@b.c'], access_token: 'tok' },
      { uid: 'u-2', nickname: 12345, email: 'x@y.z' },
    ])
    const preview = previewTransferFile(dirty)
    expect(preview.total).toBe(2)
    const [first, second] = preview.accounts
    expect(first?.hasToken).toBe(true)
    expect(first?.uid).toBe('')
    expect(first?.nickname).toBe('')
    expect(second?.hasToken).toBe(false)
    // A numeric nickname is legitimate data: stringified, not dropped.
    expect(second?.nickname).toBe('12345')
  })
})

describe('credentialOfTransferRecord', () => {
  it('maps the sibling record into a vault credential (ms expiry preserved)', () => {
    const credential = credentialOfTransferRecord(siblingRecord() as never)
    expect(credential).toBeDefined()
    if (credential === undefined) return
    expect(credential.accessToken).toBe('at-1')
    expect(credential.refreshToken).toBe('rt-1')
    expect(credential.uid).toBe('u-1')
    expect(credential.nickname).toBe('小明')
    expect(credential.domain).toBe('workbuddy.cn')
    // The transfer contract's expiresAt is epoch ms — carried through verbatim.
    expect(credential.expiresAtMs).toBe(1893456000000)
  })

  it('skips records without a token (the importer\'s skip rule)', () => {
    expect(credentialOfTransferRecord(siblingRecord({ access_token: '' }) as never)).toBeUndefined()
    expect(credentialOfTransferRecord(siblingRecord({ access_token: undefined }) as never)).toBeUndefined()
  })
})

describe('transferRecordOf (export shape)', () => {
  it('emits snake_case fields with ms expiry and the nested auth_raw document', () => {
    const credential = vaultCredential()
    const record = transferRecordOf(credential, {
      auth: {
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        expiresAt: Math.floor(credential.expiresAtMs / 1000),
        ...credential.lastRefreshAtMs === undefined ? {} : { lastRefreshTime: Math.floor(credential.lastRefreshAtMs / 1000) },
        domain: credential.domain,
      },
      account: { uid: credential.uid, nickname: credential.nickname, uin: credential.uin },
    })
    expect(record['access_token']).toBe('at-vault')
    expect(record['refresh_token']).toBe('rt-vault')
    expect(record['uid']).toBe('u-9')
    expect(record['nickname']).toBe('阿九')
    expect(record['domain']).toBe('workbuddy.cn')
    // Export expiry is in MILLISECONDS (the transfer contract's unit), even
    // though the vault document on disk stores seconds.
    expect(record['expiresAt']).toBe(1893456000000)
    expect(record['refreshExpiresAt']).toBe(1896048000000)
    // auth_raw carries the vault document's nested shape verbatim.
    const raw = record['auth_raw'] as { auth: Record<string, unknown>, account: Record<string, unknown> }
    expect(raw['auth']?.['accessToken']).toBe('at-vault')
    expect(raw['account']?.['uin']).toBe('10001')
  })
})

describe('export → import round-trip', () => {
  it('re-imports an exported record to the SAME account id', () => {
    const credential = vaultCredential()
    const record = transferRecordOf(credential, {
      auth: { accessToken: credential.accessToken, refreshToken: credential.refreshToken, expiresAt: Math.floor(credential.expiresAtMs / 1000), domain: credential.domain },
      account: { uid: credential.uid, nickname: credential.nickname, uin: credential.uin },
    })
    const parsed = parseTransferFile(JSON.stringify([record]))
    const merged = mergeTransferRecords(parsed, [0], 'cn', domain => domain.endsWith('.ai') || domain === 'workbuddy.ai' || domain === 'codebuddy.ai' ? 'global' : 'cn')
    expect(merged.imported).toBe(1)
    expect(merged.skipped).toBe(0)
    const restored = [...merged.changes.values()][0]
    expect(restored?.accessToken).toBe('at-vault')
    expect(restored?.uid).toBe('u-9')
    expect(workbuddyAccountId(restored as never)).toBe(workbuddyAccountId(credential))
  })
})

describe('mergeTransferRecords', () => {
  // The REAL classifier, not a stand-in: the gate's whole job is to decide
  // positively, and a fake one would not exercise the catch-all that made the
  // gate fail open.
  const regionOfDomain = knownRegionOf

  it('overwrites the same account id and counts it as imported', () => {
    const records = [
      siblingRecord({ uid: 'u-1', access_token: 'old' }),
      siblingRecord({ uid: 'u-1', access_token: 'new' }),
    ] as never[]
    const merged = mergeTransferRecords(records, [0, 1], 'cn', regionOfDomain)
    expect(merged.imported).toBe(2)
    expect(merged.changes.size).toBe(1)
    expect([...merged.changes.values()][0]?.accessToken).toBe('new')
  })

  it('skips token-less records, bad indexes, and the other region\'s records', () => {
    const records = [
      siblingRecord({ access_token: '' }),
      siblingRecord({ uid: 'u-2', domain: 'workbuddy.ai' }),
      siblingRecord({ uid: 'u-3', domain: 'www.codebuddy.cn' }),
    ] as never[]
    const merged = mergeTransferRecords(records, [0, 1, 2, 9], 'cn', regionOfDomain)
    expect(merged.imported).toBe(1)
    expect(merged.skipped).toBe(3)
    // The global record is NOT in the cn changeset.
    expect([...merged.changes.keys()]).toEqual([workbuddyAccountId({ uid: 'u-3', accessToken: 'at-1', refreshToken: 'rt-1', expiresAtMs: 1893456000000, domain: 'www.codebuddy.cn' } as never)])
  })

  it('skips a record whose domain cannot be positively classified', () => {
    // The gate must not fall back to a default region. `domain` comes from a
    // file someone handed the plugin, so "unrecognised" means "cannot be
    // classified" — admitting it as CN would file a foreign or spoofed
    // credential in the CN vault.
    for (const domain of ['', 'workbuddy.ai.evil.com', 'notworkbuddy.ai', 'example.com']) {
      const merged = mergeTransferRecords([siblingRecord({ domain })] as never[], [0], 'cn', regionOfDomain)
      expect(merged.imported, `domain ${JSON.stringify(domain)} must not be admitted to cn`)
      expect(merged.skipped).toBe(1)
    }
  })

  it('admits a positively classified record in its own region', () => {
    const cn = mergeTransferRecords([siblingRecord({ domain: 'www.codebuddy.cn' })] as never[], [0], 'cn', regionOfDomain)
    expect(cn.imported).toBe(1)
    const global = mergeTransferRecords([siblingRecord({ domain: 'www.workbuddy.ai' })] as never[], [0], 'global', regionOfDomain)
    expect(global.imported).toBe(1)
  })

  it('admits the CN chat gateway, which real credentials name as their domain', () => {
    // `copilot.tencent.com` is this plugin's OWN CN gateway (CN_CHAT_BASE), not a
    // third product. Refusing it made the card's export un-importable: a real
    // 8-account export was re-imported and the three gateway-domain records were
    // silently counted as `skipped`, so the user lost accounts the plugin had
    // itself just handed them.
    for (const domain of ['copilot.tencent.com', 'www.copilot.tencent.com']) {
      expect(knownRegionOf(domain), `${domain} is the CN gateway`).toBe('cn')
      const merged = mergeTransferRecords([siblingRecord({ domain })] as never[], [0], 'cn', regionOfDomain)
      expect(merged.imported).toBe(1)
      expect(merged.skipped).toBe(0)
    }
    // Still a registrable-domain match: a lookalike host is refused.
    expect(knownRegionOf('copilot.tencent.com.evil.com')).toBeUndefined()
    expect(knownRegionOf('evilcopilot.tencent.com')).toBeUndefined()
  })

  it('re-imports a whole export that mixes login domains with the gateway domain', () => {
    // The regression as the user hit it: one export file, 8 records, five
    // carrying the CN login domain and three the CN gateway. All eight are CN.
    const records = [
      ...Array.from({ length: 5 }, (_, i) => siblingRecord({ uid: `cn-${i}`, domain: 'www.workbuddy.cn' })),
      ...Array.from({ length: 3 }, (_, i) => siblingRecord({ uid: `gw-${i}`, domain: 'copilot.tencent.com' })),
    ] as never[]
    const merged = mergeTransferRecords(records, records.map((_, i) => i), 'cn', regionOfDomain)
    expect(merged.imported).toBe(8)
    expect(merged.skipped).toBe(0)
    expect(merged.changes.size).toBe(8)
  })
})


/**
 * ISSUE #229, SECOND REPORT: a sibling tool's export is rejected before parsing.
 *
 * The first round of that issue fixed the wrapper (`{accounts: [...]}`). The
 * user then reported the OTHER half: a Cockpit-Tools file of ONE account is
 * 108 KiB — because it carries `quota_raw` and `usage_raw` snapshots that this
 * plugin never reads — and the upload died with a bare `Failed to fetch` before
 * any parser ran (the transfer route shared the probe's 64 KiB body cap and
 * destroyed the socket on overflow). So there are two independent defects here
 * and both must stay fixed: the file's SIZE must not decide whether it imports,
 * and the redundant snapshots must not be carried forward.
 *
 * These cases pin the second one. The route-level cap is pinned in
 * `web-status.spec.ts`, where the reader lives.
 */
/**
 * One account in the shape a sibling tool exports, with the REAL measured
 * payload sizes: `access_token` ~1568 chars, `refresh_token` ~1570, and the two
 * raw snapshots that dominate — `quota_raw` ~29 KiB, `usage_raw` ~29 KiB.
 * A single such account measured 108 KiB on disk.
 */
function cockpitAccount(extraQuotaBytes = 0) {
  return {
    access_token: 'x'.repeat(1568),
    refresh_token: 'y'.repeat(1570),
    uid: '100000000001',
    nickname: '账号A',
    email: 'someone@example.com',
    domain: 'workbuddy.cn',
    expiresAt: Date.now() + 3_600_000,
    auth_raw: { auth: { t: 1 }, account: { uin: '100000000001' } },
    quota_raw: { blob: 'q'.repeat(29_687 + extraQuotaBytes) },
    usage_raw: { blob: 'u'.repeat(29_392) },
  }
}

describe('redundant raw snapshots (issue #229)', () => {
  it('strips *_raw snapshots but keeps auth_raw', () => {
    const file = JSON.stringify([cockpitAccount()])
    const before = Buffer.byteLength(file)
    const records = parseTransferFile(file)
    const after = Buffer.byteLength(JSON.stringify(records))
    // Measured: 62 KiB down to 3.3 KiB for ONE account. Pinning a ratio rather
    // than an exact byte count keeps this honest under any future field change.
    expect(after).toBeLessThan(before / 4)
    expect(records).toHaveLength(1)
    expect(records[0]).not.toHaveProperty('quota_raw')
    expect(records[0]).not.toHaveProperty('usage_raw')
    expect(records[0]).toHaveProperty('auth_raw')       // uin lives here
    expect(after).toBeLessThan(before * 0.3)
  })

  it('the credential still imports correctly after stripping', () => {
    const records = parseTransferFile(JSON.stringify([cockpitAccount()]))
    const cred = credentialOfTransferRecord(records[0]!)
    expect(cred).toBeDefined()
    expect(cred?.accessToken).toHaveLength(1568)
    expect(cred?.uid).toBe('100000000001')
    // `auth_raw` survives BECAUSE it carries the billing `uin`: dropping it would
    // change which vault account a re-import lands on, not just the file size.
    expect(records[0]!['auth_raw']).toBeDefined()
  })

  it('a bare array with no *_raw keys is returned unchanged (identity)', () => {
    const file = JSON.stringify([{ access_token: 'abc', uid: 'u1' }])
    const records = parseTransferFile(file)
    expect(records[0]).toHaveProperty('access_token', 'abc')
  })

  it('wrapper forms still parse AND get stripped', () => {
    const file = JSON.stringify({ accounts: [cockpitAccount()] })
    const records = parseTransferFile(file)
    expect(records).toHaveLength(1)
    expect(records[0]).not.toHaveProperty('quota_raw')
  })
})
