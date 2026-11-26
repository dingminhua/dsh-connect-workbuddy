/**
 * How a credit balance is written on screen.
 *
 * `4.4.5` made the balance exact: it now comes from the upstream's `*Precise`
 * family, so the number carries a fraction (`2,196.61`) where it used to be a
 * whole integer. The card does not show that fraction — a narrow row reads
 * better, and the product's own breakdown (套餐基础 / 平台奖励 / 购买) is the
 * place to look for detail.
 *
 * Taking the FLOOR rather than rounding is the one decision here, and it is not
 * cosmetic:
 *
 * - a balance is a quantity you either have or do not. `0.61` rounded UP prints
 *   `1`, which tells the reader they can spend a credit they do not have;
 * - the official client shows `2,196.61`, so its integer part is `2,196` — the
 *   floor. Rounding would print `2,197` and make a card that had JUST been
 *   reconciled against the client look one credit off, which is the exact
 *   complaint (issue #58) this display rule is downstream of.
 *
 * Grouping is kept because a four-figure balance is otherwise hard to read at a
 * glance, and it is the only reason this is not `Math.floor(value).toString()`.
 *
 * @module dsh-connect-workbuddy/client/credit-format
 */

/**
 * Format a credit balance for display: whole credits, grouped, floored.
 *
 * `Math.floor` before `toLocaleString` (rather than a `maximumFractionDigits`
 * option) is deliberate: the option ROUNDS, so it would print `2,197` for
 * `2,196.61`.
 */
export function formatCredits(value: number): string {
  return Math.floor(value).toLocaleString('en-US')
}

/**
 * Format a credit AMOUNT SPENT — a different job from a balance, so a different
 * rule (issue #320, raised in review).
 *
 * A balance is a quantity you either have or do not, so it is floored (see
 * above). A per-turn COST is a measurement, and flooring it would erase the
 * most ordinary case there is: a chat turn billed `0.72` would print `0`, and
 * `0.03` (the measured cost of an image generation) would also print `0` — i.e.
 * the display would claim a turn was free when it was not. That is the exact
 * confusion the surrounding card code goes out of its way to avoid ("no data"
 * and "cost nothing" must not look alike).
 *
 * So: up to two decimals, trailing zeros dropped, and a small non-zero amount is
 * never rounded down to `0` — it keeps enough digits to stay non-zero. Never
 * rounds UP either; a cost is not a permission, but inflating it would make the
 * running total disagree with the account's own balance.
 *
 * Separator is `en-US` grouping like the rest of the card, and the decimal point
 * is always `.` so a pasted figure matches what the upstream reported.
 */
export function formatSpent(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (value === 0) return '0'
  if (Math.abs(value) >= 1000) return Math.floor(value).toLocaleString('en-US')
  // NEVER ROUND UP: `toFixed` rounds, so 12.005 would print `12.01` and the
  // running total would drift above what the account was actually charged. Truncate
  // first, then format.
  // Keep more digits for small amounts so 0.003 does not print as "0" — the rule
  // above is "never show free when it was not".
  const digits = Math.abs(value) < 0.01 ? 3 : 2
  const scale = 10 ** digits
  const truncated = Math.trunc(value * scale) / scale
  return truncated.toFixed(digits).replace(/\.?0+$/u, '')
}
