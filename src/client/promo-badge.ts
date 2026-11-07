/**
 * The upstream's promotion badge, as the card draws it.
 *
 * THREE THINGS LIVE HERE, and all three are about not overstating what the
 * upstream said:
 *
 * 1. WHICH badge — resolved by `selectPromoBadge` against the clock, never
 *    frozen at parse time. A promotion's hours are wall-clock hours in a
 *    named zone (`schedule.daily`, e.g. `23:00`–`7:50` Asia/Shanghai), so a
 *    badge picked when the document was read would keep claiming the night
 *    after the night is over. The card re-renders at least once a minute
 *    while it is open (it polls the usage route), so a window edge is picked
 *    up within a minute without a second timer.
 * 2. WHAT it says — the upstream's own wording. The badge's label is the
 *    upstream's, in the upstream's own region wording ("限时免费" on the CN
 *    feed, "Free now" on the global one); the hover copy is the upstream's
 *    too, in the language the user reads (the global feed publishes English
 *    prose under `textZh` and no `textEn` at all, so the fallback matters).
 * 3. HOW it looks — the upstream's own colour, and only when it is a colour
 *    this card can safely put in a style.
 *
 * Nothing here invents copy: every string on the chip is the upstream's.
 *
 * @module dsh-connect-workbuddy/client/promo-badge
 */

import type { WorkBuddyPromo } from '../promo.ts'

/**
 * The UI's language, as the browser reports it.
 *
 * The card already formats dates and numbers with the browser's locale
 * (`formatDate`), so reading the same signal for the upstream's copy is
 * consistent: the badge says what the upstream says, in the language the
 * user reads.
 *
 * `navigator` is read defensively — this module is imported by unit tests
 * that run in a plain Node environment, where it does not exist.
 */
export function uiLanguage(): string {
  return typeof navigator === 'undefined' ? '' : navigator.language
}

/** Whether the given language is an English one. */
function isEnglish(language: string | undefined): boolean {
  return (language ?? '').toLowerCase().startsWith('en')
}

/**
 * The badge's own wording.
 *
 * The upstream's label is the region's own wording, so it is the default for
 * every UI. An English UI prefers the English label when the upstream
 * published one; the global feed publishes none, and there its label is
 * already English.
 */
export function promoBadgeLabel(promo: WorkBuddyPromo, language?: string): string {
  const badge = promo.badge
  if (isEnglish(language)) return badge.labelEn ?? badge.label
  return badge.label
}

/**
 * The badge's wording where the chip has to fit a narrow row.
 *
 * The model picker's rows are one line wide and already carry the model name,
 * the credit rate and the load icon, so a four-character label ("夜间折扣") can
 * push the check mark out of the row. The upstream publishes a compact wording
 * for exactly this case (`shortLabel`), and when it does not, the full label is
 * still better than a cropped one: an ellipsis in a menu row reads as a
 * truncated word, while the full label is at worst tight.
 */
export function promoBadgeShortLabel(promo: WorkBuddyPromo, language?: string): string {
  const badge = promo.badge
  const short = isEnglish(language)
    ? (badge.shortLabelEn ?? badge.shortLabel)
    : badge.shortLabel
  return short ?? promoBadgeLabel(promo, language)
}

/**
 * The chip's colour, when the upstream published a usable one.
 *
 * Only a hex colour is accepted: the value reaches an inline style, and the
 * upstream's feed publishes hex (`#009273`, `#FF0000`). Anything else is
 * refused rather than passed through, and the card falls back to its own
 * brand colour.
 */
/**
 * The host's own badge tone for a promotion, for the 0.2.2+ `model.badge` field.
 *
 * WHY A TONE AND NOT A COLOUR. From 0.2.2 the host's model directory accepts a
 * per-model `badge` (`LlmModelBadge = { text, tone }`) and draws it itself, in
 * the same place and shape as the picker's own labels. `tone` is one of four
 * semantic slots (`neutral | info | success | warning`), NOT an arbitrary
 * colour: the shell paints it from theme tokens so it stays legible in every
 * theme, which an upstream hex value cannot guarantee.
 *
 * The upstream's hex colour is therefore mapped onto the CLOSEST tone rather
 * than passed through. Green — the value every CN promotion here uses for "free
 * for now" — reads as `success`; blues as `info`; amber/red as `warning`;
 * anything else stays `neutral` rather than inventing a meaning.
 *
 * @param promo - The resolved promotion.
 * @returns The host tone to stamp on `model.badge`.
 */
export function promoBadgeTone(promo: WorkBuddyPromo): 'neutral' | 'info' | 'success' | 'warning' {
  const color = promoBadgeColor(promo)
  if (color === undefined) return 'neutral'
  // #RRGGBB only (promoBadgeColor already refuses anything else).
  const hex = color.replace('#', '')
  if (hex.length !== 6) return 'neutral'
  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return 'neutral'
  // Green dominates when it is clearly the strongest channel: that is the
  // "免费 / 折扣" green and it must not be read as a warning.
  if (g > r + 24 && g > b + 24) return 'success'
  // Blue: a "members only / tier" badge rather than a price event.
  if (b > r + 24 && b > g + 8) return 'info'
  // Warm: amber and red both mean "read this before choosing".
  if (r > b + 24) return 'warning'
  return 'neutral'
}

export function promoBadgeColor(promo: WorkBuddyPromo): string | undefined {
  const color = promo.badge.color
  if (color === undefined) return undefined
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : undefined
}

/**
 * A calendar day, in the user's own locale — read in the ZONE the upstream
 * wrote the instant in.
 *
 * The zone is part of the statement, exactly as it is for the daily hours. The
 * upstream publishes `validFrom: "2026-07-06T00:00:00+08:00"` and describes the
 * same campaign as "7月6日–10月31日". Formatting that instant in the reader's
 * own zone shows 7月5日 to anyone west of UTC, contradicting the upstream's own
 * copy in the same tooltip. Keeping the upstream's zone makes the tooltip
 * self-consistent wherever it is read.
 *
 * `medium` rather than the card's numeric `MM/DD` form: this is a promotion's
 * lifetime, and "Jul 6, 2026" reads as a date while "07/06" reads as a number
 * the user has to decode.
 */
function formatDay(ms: number, language?: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(language === undefined || language === '' ? undefined : language, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      ...timeZone === undefined ? {} : { timeZone },
    }).format(new Date(ms))
  } catch {
    // An unusable locale tag OR zone must not cost the user the whole tooltip.
    return new Date(ms).toISOString().slice(0, 10)
  }
}

/**
 * The promotion's lifetime, as the upstream's own two ends.
 *
 * `validUntil` is EXCLUSIVE — see `promoWithinAbsoluteWindow`: the promotion is
 * over AT that instant. The upstream writes it as the midnight that opens the
 * day after the campaign, and says "– Oct 31" in its own copy for a
 * `validUntil` of `2026-11-01T00:00:00+08:00`. Printing the raw instant would
 * put "Nov 1, 2026" in the same tooltip and read as if the campaign ran a day
 * longer than it does. One millisecond before the boundary is the last instant
 * that still belongs to it, so that is what gets rendered.
 */
function promoRangeText(promo: WorkBuddyPromo, language?: string): string | undefined {
  const schedule = promo.schedule
  if (schedule === undefined) return undefined
  const zone = schedule.timezone
  const from = schedule.validFrom === undefined ? undefined : formatDay(schedule.validFrom, language, zone)
  const to = schedule.validUntil === undefined ? undefined : formatDay(schedule.validUntil - 1, language, zone)
  if (from === undefined && to === undefined) return undefined
  if (from === undefined) return `– ${to ?? ''}`
  if (to === undefined) return `${from} –`
  return `${from} – ${to}`
}

/**
 * The hours the discount runs, in the zone the upstream named.
 *
 * The zone is part of the statement: "23:00–7:50" means nothing to a reader
 * in another zone, and the upstream's windows are written in ITS zone
 * (Asia/Shanghai for the CN feed), not the user's.
 */
function promoHoursText(promo: WorkBuddyPromo): string | undefined {
  const schedule = promo.schedule
  const daily = schedule?.daily
  if (daily === undefined || daily.length === 0) return undefined
  const windows = daily.map(window => `${window.start}–${window.end}`).join(', ')
  const zone = schedule?.timezone
  return zone === undefined ? windows : `${windows} (${zone})`
}

/**
 * The chip's tooltip: the upstream's own copy, its lifetime, and the hours
 * the discount runs.
 *
 * Empty pieces are left out rather than rendered as blanks, so a promotion
 * that publishes nothing but a label gets a chip with a label and no hover
 * text at all.
 */
export function promoBadgeTooltip(promo: WorkBuddyPromo, language?: string): string {
  const parts: string[] = []
  const hover = promo.hover
  if (hover !== undefined) {
    const copy = isEnglish(language)
      ? (hover.textEn ?? hover.textZh)
      : (hover.textZh ?? hover.textEn)
    if (copy !== undefined) parts.push(copy)
  }
  const range = promoRangeText(promo, language)
  if (range !== undefined) parts.push(range)
  const hours = promoHoursText(promo)
  if (hours !== undefined) parts.push(hours)
  return parts.join(' · ')
}
