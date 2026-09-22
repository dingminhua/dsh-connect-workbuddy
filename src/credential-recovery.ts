/**
 * Recovery advice for a credential the upstream has refused.
 *
 * A 401 from the upstream has two very different fixes on this machine, and
 * telling them apart is the whole point of this module:
 *
 *   - the SELECTED account is stale while another local sign-in is healthy →
 *     switching accounts fixes it, and signing in again changes nothing;
 *   - no local sign-in is accepted anymore → signing in again is the fix.
 *
 * Observed on a real machine: a revoked July backup stayed selected while the
 * app's current sign-in was perfectly usable. The card's old, unconditional
 * "sign in again" hint sent the user to re-authenticate — which did nothing,
 * because the credentials were never the problem; the stale SELECTION was.
 *
 * The probe never changes the selection and never switches on its own: choosing
 * which account gets billed is the user's decision, so this module only answers
 * "would switching help?" and the card offers it.
 *
 * @module dsh-connect-workbuddy/credential-recovery
 */

import type { WorkBuddyCredential } from './auth.ts'
import type { WorkBuddyUpstreamClient } from './upstream.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/** What the user can do about a refused credential. */
export interface WorkBuddyCredentialRecovery {
  /**
   * Another local account answered the upstream during this recovery, so
   * switching to it is a fix that has been verified — not a guess.
   */
  usableAccount?: { accountId: string; accountName: string }
  /**
   * Whether signing in again is the only remaining fix: no other local account
   * exists at all, so there is nothing to switch to.
   */
  reloginRequired: boolean
}

/** One account as the recovery path needs to see it. */
export interface WorkBuddyRecoveryCandidate {
  id: string
  accountName: string
}

/** Reads one account's credential for probing, without changing the selection. */
export interface WorkBuddyProbeStore {
  accounts(): Promise<readonly WorkBuddyRecoveryCandidate[]>
  credentialFor(accountId: string): Promise<WorkBuddyCredential | undefined>
}

/** Constructor options for {@link createAccountUsabilityProbe}. */
export interface WorkBuddyUsabilityProbeOptions {
  /** The credential store for one region (its selection is never touched). */
  store(region: WorkBuddyRegion): WorkBuddyProbeStore
  /** The upstream client; only its cheap read-only calls are used. */
  client: Pick<WorkBuddyUpstreamClient, 'fetchCheckinStatus'>
  /**
   * How long a probe verdict is reused. The card polls the usage route, so
   * without this a broken selection would re-probe every account on every poll.
   */
  ttlMs?: number
  /** Injectable clock, for tests. */
  now?: () => number
}

/** How long a verdict stays fresh by default. */
const DEFAULT_PROBE_TTL_MS = 60_000

/**
 * Cached "is this account still accepted upstream?" probe.
 *
 * The cache key includes the credential's own `lastRefreshAtMs`, so a fresh
 * sign-in (which rewrites the file's issuance time) invalidates a stale verdict
 * automatically — a rejection recorded before the user signed in again cannot
 * keep labelling the account unusable afterwards, and no explicit invalidation
 * is needed.
 */
export function createAccountUsabilityProbe(
  options: WorkBuddyUsabilityProbeOptions,
): (region: WorkBuddyRegion, account: WorkBuddyRecoveryCandidate) => Promise<boolean> {
  const ttlMs = options.ttlMs ?? DEFAULT_PROBE_TTL_MS
  const now = options.now ?? Date.now
  const verdicts = new Map<string, { at: number; usable: boolean }>()

  return async (region, account) => {
    let credential: WorkBuddyCredential | undefined
    try {
      credential = await options.store(region).credentialFor(account.id)
    } catch {
      return false
    }
    if (credential === undefined) return false

    const key = `${region}\0${account.id}\0${credential.lastRefreshAtMs ?? credential.expiresAtMs}`
    const cached = verdicts.get(key)
    if (cached !== undefined && now() - cached.at < ttlMs) return cached.usable

    let usable = false
    try {
      // The check-in status route is the cheapest authenticated read that
      // exercises the same billing gateway and header set as the credit query,
      // so "it answers" is real evidence about the credential, not about a
      // different endpoint that may be routed elsewhere.
      await options.client.fetchCheckinStatus(credential)
      usable = true
    } catch {
      usable = false
    }
    verdicts.set(key, { at: now(), usable })
    return usable
  }
}

/**
 * Decide what to tell the user after the upstream refused the selected
 * credential: switch to a verified-usable account, or sign in again.
 *
 * The two answers are mutually exclusive by construction. `reloginRequired` is
 * set ONLY when there is no other local account to switch to — never as a
 * fallback for "the probe did not verify anything", because that would repeat
 * the misdirection this module exists to remove. When other accounts exist but
 * none was verified, both fields stay empty and the card says so honestly.
 */
export async function resolveCredentialRecovery(options: {
  region: WorkBuddyRegion
  store: WorkBuddyProbeStore
  rejectedAccountId?: string
  /** Verifies whether one account is still accepted; see the probe factory. */
  probe: (region: WorkBuddyRegion, account: WorkBuddyRecoveryCandidate) => Promise<boolean>
}): Promise<WorkBuddyCredentialRecovery> {
  let accounts: readonly WorkBuddyRecoveryCandidate[]
  try {
    accounts = await options.store.accounts()
  } catch {
    return { reloginRequired: false }
  }
  const others = accounts.filter(account => account.id !== options.rejectedAccountId)
  if (others.length === 0) {
    // Nothing to switch to: signing in again is the only path, and saying so is
    // accurate rather than a guess.
    return { reloginRequired: true }
  }
  for (const account of others) {
    if (await options.probe(options.region, account)) {
      return {
        usableAccount: { accountId: account.id, accountName: account.accountName },
        reloginRequired: false,
      }
    }
  }
  return { reloginRequired: false }
}
