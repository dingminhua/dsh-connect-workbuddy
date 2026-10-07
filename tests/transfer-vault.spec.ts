import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkBuddyCredentialStore, workbuddyAccountId } from '../src/auth.ts'
import { mergeTransferRecords, parseTransferFile, transferRecordOf } from '../src/transfer.ts'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The transfer HOST path end-to-end: an exported record re-imported through
 * the real vault, plus the region gate against real vault files. No fetch
 * stubs needed — the transfer path never touches the network.
 */
describe('transfer into the credential vault', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-transfer-'))
    process.env.DSH_HOME = root
  })
  afterEach(async () => { await rm(root, { force: true, recursive: true }) })

  /** A store over one region's vault with a no-op refresh. */
  function storeFor(region: 'cn' | 'global'): WorkBuddyCredentialStore {
    return new WorkBuddyCredentialStore({
      region,
      vaultDir: join(root, 'workbuddy-vault', region),
      refresh: async () => { throw new Error('no refresh in this test') },
    })
  }

  it('stores an imported record so the account becomes selectable', async () => {
    const store = storeFor('cn')
    const records = parseTransferFile(JSON.stringify([{
      access_token: 'at-imported',
      refresh_token: 'rt-imported',
      uid: 'u-import',
      nickname: '导入账号',
      domain: 'workbuddy.cn',
      expiresAt: 1893456000000,
    }]))
    const merged = mergeTransferRecords(records, [0], 'cn', () => 'cn')
    expect(merged.imported).toBe(1)
    for (const [id, credential] of merged.changes) {
      await store.addOAuthAccount(credential)
      expect(id).toBe(workbuddyAccountId(credential))
    }
    const accounts = await store.accounts()
    expect(accounts.map(account => account.accountName)).toContain('导入账号')
    // The stored entry survives a restart-shaped re-read: the vault file is
    // the source, not the importing process's memory.
    const vaultDir = join(root, 'workbuddy-vault', 'cn')
    const names = await readdir(vaultDir)
    expect(names.some(name => name.endsWith('.json'))).toBe(true)
  })

  it('re-importing the same account overwrites its entry, not a duplicate', async () => {
    const store = storeFor('cn')
    const record = {
      access_token: 'at-old',
      refresh_token: 'rt-old',
      uid: 'u-dup',
      domain: 'workbuddy.cn',
      expiresAt: 1893456000000,
    }
    const first = mergeTransferRecords(parseTransferFile(JSON.stringify([record])), [0], 'cn', () => 'cn')
    for (const [, credential] of first.changes) await store.addOAuthAccount(credential)
    const second = mergeTransferRecords(parseTransferFile(JSON.stringify([{ ...record, access_token: 'at-new' }])), [0], 'cn', () => 'cn')
    for (const [, credential] of second.changes) await store.addOAuthAccount(credential)
    const credential = await store.credentialFor(workbuddyAccountId({ uid: 'u-dup' }))
    expect(credential?.accessToken).toBe('at-new')
  })

  it('keeps the other region\'s records out of this region\'s vault', async () => {
    const store = storeFor('cn')
    const records = parseTransferFile(JSON.stringify([
      { access_token: 'at-global', uid: 'u-g', domain: 'workbuddy.ai', expiresAt: 1893456000000 },
      { access_token: 'at-cn', uid: 'u-c', domain: 'workbuddy.cn', expiresAt: 1893456000000 },
    ]))
    const merged = mergeTransferRecords(records, [0, 1], 'cn', domain => domain === 'workbuddy.ai' ? 'global' : 'cn')
    expect(merged.imported).toBe(1)
    expect(merged.skipped).toBe(1)
    for (const [, credential] of merged.changes) await store.addOAuthAccount(credential)
    const accounts = await store.accounts()
    expect(accounts.map(account => account.id)).toEqual([
      workbuddyAccountId({ uid: 'u-c' }),
    ])
  })

  it('exports a vault entry as a record the sibling shape can parse back', async () => {
    const store = storeFor('global')
    const accountId = await store.addOAuthAccount({
      accessToken: 'at-export',
      refreshToken: 'rt-export',
      expiresAtMs: 1893456000000,
      domain: 'workbuddy.ai',
      uid: 'u-exp',
      nickname: '导出账号',
    })
    const credential = await store.credentialFor(accountId)
    expect(credential).toBeDefined()
    if (credential === undefined) return
    // Export through the same projection the Host deps use.
    const record = transferRecordOf(credential, {
      auth: {
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        expiresAt: Math.floor(credential.expiresAtMs / 1000),
        domain: credential.domain,
      },
      account: { uid: credential.uid, nickname: credential.nickname },
    })
    // Round-trip through a FILE, like a user moving it between machines.
    const filePath = join(root, 'export.json')
    await writeFile(filePath, JSON.stringify([record], null, 2))
    const text = await readFile(filePath, 'utf8')
    const merged = mergeTransferRecords(parseTransferFile(text), [0], 'global', domain => domain === 'workbuddy.ai' ? 'global' : 'cn')
    expect(merged.imported).toBe(1)
    const restored = [...merged.changes.values()][0]
    expect(restored?.accessToken).toBe('at-export')
    expect(workbuddyAccountId(restored as never)).toBe(accountId)
    await mkdir(root, { recursive: true })
  })
})
