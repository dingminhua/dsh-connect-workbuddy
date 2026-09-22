/**
 * Recovery-advice tests.
 *
 * The behaviour that matters is the distinction, not the plumbing: a refused
 * credential must produce "switch accounts" when another local sign-in works,
 * and "sign in again" only when there is genuinely nothing else to switch to.
 * Getting that backwards is what sends users to re-authenticate for a problem
 * re-authentication cannot fix.
 */

import { describe, expect, it } from 'vitest'
import {
  createAccountUsabilityProbe,
  resolveCredentialRecovery,
} from '../src/credential-recovery.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

function credential(tag: string, lastRefreshAtMs = 1_700_000_000_000): WorkBuddyCredential {
  return {
    accessToken: `access-${tag}`,
    refreshToken: `refresh-${tag}`,
    expiresAtMs: 1_800_000_000_000,
    domain: 'www.codebuddy.cn',
    uid: `uid-${tag}`,
    uin: `10000000000${tag}`,
    source: 'desktop',
    filePath: `/tmp/${tag}.info`,
    lastRefreshAtMs,
  }
}

const ALPHA = { id: 'aaa', accountName: 'Alpha' }
const BETA = { id: 'bbb', accountName: 'Beta' }

describe('createAccountUsabilityProbe', () => {
  it('reports usable when the billing gateway answers for that account', async () => {
    const probe = createAccountUsabilityProbe({
      store: () => ({
        accounts: async () => [ALPHA, BETA],
        credentialFor: async () => credential('bbb'),
      }),
      client: { fetchCheckinStatus: async () => ({ active: true }) } as never,
    })
    expect(await probe('cn', BETA)).toBe(true)
  })

  it('reports unusable when the upstream refuses the credential', async () => {
    const probe = createAccountUsabilityProbe({
      store: () => ({
        accounts: async () => [ALPHA, BETA],
        credentialFor: async () => credential('bbb'),
      }),
      client: { fetchCheckinStatus: async () => { throw new Error('401 refused') } } as never,
    })
    expect(await probe('cn', BETA)).toBe(false)
  })

  it('reports unusable for an account that is no longer present locally', async () => {
    const probe = createAccountUsabilityProbe({
      store: () => ({ accounts: async () => [ALPHA], credentialFor: async () => undefined }),
      client: { fetchCheckinStatus: async () => ({ active: true }) } as never,
    })
    expect(await probe('cn', BETA)).toBe(false)
  })

  it('caches a verdict within its TTL so a polling card does not re-probe', async () => {
    let calls = 0
    let clock = 1_000
    const probe = createAccountUsabilityProbe({
      store: () => ({
        accounts: async () => [BETA],
        credentialFor: async () => credential('bbb'),
      }),
      client: { fetchCheckinStatus: async () => { calls++; return { active: true } } } as never,
      ttlMs: 60_000,
      now: () => clock,
    })
    expect(await probe('cn', BETA)).toBe(true)
    expect(await probe('cn', BETA)).toBe(true)
    expect(calls).toBe(1)
    clock += 60_001
    await probe('cn', BETA)
    expect(calls).toBe(2)
  })

  it('re-probes after a re-login changes the credential\'s issuance time', async () => {
    // A rejection recorded before signing in again must not keep labelling the
    // account unusable: the fresh credential is a different fact.
    let refreshAt = 1_700_000_000_000
    let usable = false
    const probe = createAccountUsabilityProbe({
      store: () => ({
        accounts: async () => [BETA],
        credentialFor: async () => credential('bbb', refreshAt),
      }),
      client: { fetchCheckinStatus: async () => { if (!usable) throw new Error('401'); return { active: true } } } as never,
    })
    expect(await probe('cn', BETA)).toBe(false)
    // The user signs in again in the desktop app: same account, new issuance.
    refreshAt = 1_700_009_999_999
    usable = true
    expect(await probe('cn', BETA)).toBe(true)
  })

  it('keeps verdicts apart per region and per account', async () => {
    const seen: string[] = []
    const probe = createAccountUsabilityProbe({
      store: () => ({
        accounts: async () => [ALPHA, BETA],
        credentialFor: async id => credential(id),
      }),
      client: {
        fetchCheckinStatus: async (c: WorkBuddyCredential) => {
          seen.push(c.uid)
          return { active: true }
        },
      } as never,
    })
    await probe('cn', ALPHA)
    await probe('cn', BETA)
    await probe('global', ALPHA)
    expect(seen).toEqual(['uid-aaa', 'uid-bbb', 'uid-aaa'])
  })
})

describe('resolveCredentialRecovery', () => {
  it('demands a re-login only when nothing else exists to switch to', async () => {
    const recovery = await resolveCredentialRecovery({
      region: 'cn',
      store: { accounts: async () => [ALPHA], credentialFor: async () => undefined },
      rejectedAccountId: ALPHA.id,
      probe: async () => false,
    })
    expect(recovery.reloginRequired).toBe(true)
    expect(recovery.usableAccount).toBeUndefined()
  })

  it('names the verified account when another sign-in still works', async () => {
    const recovery = await resolveCredentialRecovery({
      region: 'cn',
      store: { accounts: async () => [ALPHA, BETA], credentialFor: async () => undefined },
      rejectedAccountId: ALPHA.id,
      probe: async (_region, account) => account.id === BETA.id,
    })
    expect(recovery.usableAccount).toEqual({ accountId: 'bbb', accountName: 'Beta' })
    expect(recovery.reloginRequired).toBe(false)
  })

  it('never demands a re-login while an unverified alternative exists', async () => {
    // This is the misdirection guard: alternatives exist, none verified. The
    // honest answer is "try switching", NOT "sign in again".
    const recovery = await resolveCredentialRecovery({
      region: 'cn',
      store: { accounts: async () => [ALPHA, BETA], credentialFor: async () => undefined },
      rejectedAccountId: ALPHA.id,
      probe: async () => false,
    })
    expect(recovery.reloginRequired).toBe(false)
    expect(recovery.usableAccount).toBeUndefined()
  })

  it('never probes the account that was just refused', async () => {
    const probed: string[] = []
    await resolveCredentialRecovery({
      region: 'cn',
      store: { accounts: async () => [ALPHA, BETA], credentialFor: async () => undefined },
      rejectedAccountId: ALPHA.id,
      probe: async (_region, account) => { probed.push(account.id); return false },
    })
    expect(probed).toEqual(['bbb'])
  })

  it('stops probing at the first usable account', async () => {
    const GAMMA = { id: 'ccc', accountName: 'Gamma' }
    const probed: string[] = []
    const recovery = await resolveCredentialRecovery({
      region: 'cn',
      store: { accounts: async () => [ALPHA, BETA, GAMMA], credentialFor: async () => undefined },
      rejectedAccountId: ALPHA.id,
      probe: async (_region, account) => { probed.push(account.id); return account.id === BETA.id },
    })
    expect(probed).toEqual(['bbb'])
    expect(recovery.usableAccount?.accountId).toBe('bbb')
  })

  it('probes every alternative when none survives, then stays silent about re-login', async () => {
    const GAMMA = { id: 'ccc', accountName: 'Gamma' }
    const probed: string[] = []
    const recovery = await resolveCredentialRecovery({
      region: 'cn',
      store: { accounts: async () => [ALPHA, BETA, GAMMA], credentialFor: async () => undefined },
      rejectedAccountId: ALPHA.id,
      probe: async (_region, account) => { probed.push(account.id); return false },
    })
    expect(probed).toEqual(['bbb', 'ccc'])
    expect(recovery.reloginRequired).toBe(false)
  })

  it('survives an unreadable account list without crashing the route', async () => {
    const recovery = await resolveCredentialRecovery({
      region: 'cn',
      store: {
        accounts: async () => { throw new Error('scan failed') },
        credentialFor: async () => undefined,
      },
      rejectedAccountId: ALPHA.id,
      probe: async () => false,
    })
    expect(recovery).toEqual({ reloginRequired: false })
  })
})
