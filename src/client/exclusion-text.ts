/**
 * One account's "cannot serve right now" reason, as a short localized label.
 *
 * Extracted from `AccountPool.tsx` (where the pool table first needed it) so the
 * composer panel's account table states the SAME thing about the SAME account:
 * two tables on one screen giving different names to one measurement is how a
 * user learns to trust neither. This module depends only on the translate
 * function and the exclusion union, so both callers can share it — and it stays
 * testable without a Host.
 */
import type { WorkBuddyWebPoolExclusion } from '../status-paths.ts'
import type { Translate } from './searched-paths.ts'

/** The exclusion label for one account, or undefined when it is usable. */
export function exclusionText(
  t: Translate,
  excludedBy: WorkBuddyWebPoolExclusion | undefined,
): string | undefined {
  switch (excludedBy) {
    case 'rate-limited': return t('row.poolExcludedRateLimited')
    case 'out-of-credit': return t('row.poolExcludedOutOfCredit')
    case 'credential-rejected': return t('row.poolExcludedRejected')
    // These four used to be folded into 'credential-rejected', which made the
    // name column contradict the probe column right beside it: "被拒绝，请重新
    // 登录" next to "连不上上游——这是网络问题" (that probe label is now
    // cause-neutral; see `locales.ts`). They now reuse the probe labels, so one
    // measurement yields one consistent story.
    case 'not-found': return t('row.probeNotFound')
    case 'unavailable': return t('row.probeUnavailable')
    case 'failed': return t('row.probeFailed')
    case 'unusable': return t('row.poolExcludedUnusable')
    default: return undefined
  }
}
