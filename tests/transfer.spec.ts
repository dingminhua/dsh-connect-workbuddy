import { describe, expect, it } from 'vitest'
import {
  credentialOfTransferRecord,
  mergeTransferRecords,
  parseTransferFile,
  previewTransferFile,
  transferRecordOf,
} from '../src/transfer.ts'
import { workbuddyAccountId } from '../src/auth.ts'
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
  const regionOfDomain = (domain: string): 'cn' | 'global' =>
    domain === 'workbuddy.ai' || domain === 'codebuddy.ai' ? 'global' : 'cn'

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
      siblingRecord({ uid: 'u-3' }),
    ] as never[]
    const merged = mergeTransferRecords(records, [0, 1, 2, 9], 'cn', regionOfDomain)
    expect(merged.imported).toBe(1)
    expect(merged.skipped).toBe(3)
    // The global record is NOT in the cn changeset.
    expect([...merged.changes.keys()]).toEqual([workbuddyAccountId({ uid: 'u-3', accessToken: 'at-1', refreshToken: 'rt-1', expiresAtMs: 1893456000000, domain: 'workbuddy.cn' } as never)])
  })

  it('admits a domain-less record (the gate cannot classify it)', () => {
    const records = [siblingRecord({ domain: '' })] as never[]
    const merged = mergeTransferRecords(records, [0], 'global', regionOfDomain)
    expect(merged.imported).toBe(1)
    expect(merged.skipped).toBe(0)
  })
})
