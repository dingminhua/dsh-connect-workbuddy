/**
 * The HOST's model picker label: the catalog name, the upstream's promotion
 * badge, and the load-level icon.
 *
 * WHY A SLOT. The host renders the model name as a plain string, so the only
 * thing a provider can put there is a character — and a character's colour is
 * the emoji font's business, not ours. The host therefore offers exactly one
 * seam for this: the `conversation.input.model.label` slot, whose contract is
 * "render non-interactive inline content such as a coloured name or badge"
 * while the picker keeps owning clicks, focus, check marks and the accessibility
 * text. The shipped example is the official DeepSeek "1017" release badge — a
 * coloured marker next to a model name — which is the same job.
 *
 * WHY THE BADGE BELONGS HERE AT ALL. The picker is where the choice is made,
 * and a time-boxed promotion is a choice criterion: "free until the 25th" and
 * "half price at night" both change which row you click. The card already drew
 * these badges, but the card is the settings surface — by the time you read
 * them there you have already picked. The badge is not decoration added here;
 * it is the same upstream fact, moved to the place where it can still change a
 * decision.
 *
 * WHY A SEPARATE FETCH. The slot is rendered by the host, outside the plugin's
 * card, so it cannot read the card's React state. It therefore asks the Host
 * for the snapshot itself — and asks for the SAME route the card polls
 * (`WORKBUDDY_USAGE_PATH`), which carries both the load levels and each model's
 * unresolved promotions. One request, both facts. The answer is cached briefly:
 * a picker that re-fetched on every re-render would be wasteful, and a level
 * that is a few seconds old is still true.
 *
 * WHY THE CLOCK IS RE-READ ON EVERY RENDER. A promotion's badge is a function
 * of the clock (a night window opens and closes; a campaign expires). Resolving
 * it once at fetch time and holding it would leave "夜间折扣" on the composer
 * button the next morning — the exact overstatement `src/promo.ts` refuses to
 * make. The snapshot is therefore fetched once and the BADGE is resolved at
 * render time; a shared one-minute ticker re-renders the mounted labels so a
 * window edge is picked up without one timer per model row.
 *
 * WHY THE HOST STILL OWNS THE NAME. The contract says to keep `model.name` as
 * the text and render the addition beside it, so this component returns the
 * name first and never replaces it.
 *
 * FOR A PROVIDER THAT IS NOT OURS IT RENDERS THE CATALOG NAME PLUS THAT MODEL'S
 * OWN `badge` — never another plugin's component. The name half is not
 * cosmetic: this slot is `kind: "single"`, so whatever registers becomes the
 * cell's only occupant, and an occupant that outputs plain text still occupies
 * it. A previous version of this paragraph said the component "renders nothing
 * at all" for a foreign provider, which made the lost-decoration cost look
 * harmless; issue #138 is what that mis-description looks like from the outside
 * (the host's own 1017 badge disappears on ITS rows while this plugin holds the
 * cell). Returning `null` would not free the cell either — occupancy is decided
 * by registration, never by what the component outputs.
 *
 * THE `badge` HALF IS WHAT MAKES SIBLING CHIPS SURVIVE. The host runs its own
 * badge fallback only when the cell has NO occupant, so once this plugin wins the
 * cell it must draw a sibling's badge itself or that badge is never drawn
 * anywhere. The data is `props.model.badge` — the host's catalog field, which
 * arrives here regardless of who published it — so this is not the coordination
 * `docs/DESIGN.md` §零 rules out: no ledger is read, no foreign component is
 * rendered, and the output does not change based on which plugins are installed.
 * See `HostBadgeChip` and `docs/MODEL-LABEL-SPEC.md`.
 */
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { busyIcon } from './busy-icon.tsx'
import type { WorkBuddyBusyLevel } from '../busy.ts'
import type { WorkBuddyPromo } from '../promo.ts'
import { selectPromoBadge, selectPromoMultiplier } from '../promo.ts'
import { normalizeNewModelIds } from './new-model-ids.ts'
import { promoBadgeColor, promoBadgeLabel, promoBadgeShortLabel, promoBadgeTooltip, uiLanguage } from './promo-badge.ts'
import { withWorkBuddyRegion, WORKBUDDY_USAGE_PATH } from '../status-paths.ts'
import type { WorkBuddyWebModel, WorkBuddyWebRegion } from '../status-paths.ts'

/** The provider ids this plugin registers, and the region each one serves. */
const PROVIDER_REGIONS: ReadonlyMap<string, WorkBuddyWebRegion> = new Map([
  ['workbuddy', 'cn'],
  ['workbuddy-global', 'global'],
])

/**
 * The region a provider id serves, or `undefined` for a provider that is not
 * this plugin's.
 *
 * Exported because the mapping is the part that can be silently wrong: asking
 * the Host without the region answers for the DEFAULT region, which would put
 * one gateway's load on the other gateway's models.
 */
export function regionOfProvider(providerId: string): WorkBuddyWebRegion | undefined {
  return PROVIDER_REGIONS.get(providerId)
}

/** How long a fetched snapshot is trusted, in milliseconds. */
const CACHE_MS = 60_000

/** How often a mounted label re-reads the clock, in milliseconds. */
const TICK_MS = 60_000

/**
 * The two facts one label needs, as read from the Host.
 *
 * Both ride on the SAME usage response: `busyLevels` is per region, and each
 * model carries its own `promos` UNRESOLVED — the badge is resolved against the
 * clock by the renderer, not by the Host.
 */
interface StatusSnapshot {
  levels: Readonly<Record<string, WorkBuddyBusyLevel>>
  promos: Readonly<Record<string, readonly WorkBuddyPromo[]>>
  /** Each model's catalog multiplier, so the label can show the discounted
   *  price while a discount runs (issue #120). */
  rates: Readonly<Record<string, number>>
  /** The ids THIS machine first saw inside the new-model window: the same
   *  normalised list the composer pill's "· N 新模型" segment renders, so the
   *  pill's count and the rows marked "新" here cannot disagree. */
  newModelIds: readonly string[]
}

/** The snapshot per region, plus when it was read. */
const caches = new Map<WorkBuddyWebRegion, { snapshot: StatusSnapshot, at: number }>()

/**
 * The snapshot, read from the Host once and reused briefly.
 *
 * `undefined` means "not known" — the caller renders nothing rather than
 * guessing, because a badge that claims a level or a promotion the upstream
 * never stated is worse than no badge.
 */
async function statusNow(region: WorkBuddyWebRegion): Promise<StatusSnapshot | undefined> {
  const cached = caches.get(region)
  if (cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached.snapshot
  try {
    // The answer is per REGION: the two gateways are separate catalogs with
    // separate load and separate promotions, so asking without the region
    // would show one region's facts on the other's models.
    const response = await fetch(withWorkBuddyRegion(WORKBUDDY_USAGE_PATH, region), {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!response.ok) return undefined
    const body = await response.json() as {
      busyLevels?: Record<string, WorkBuddyBusyLevel>
      models?: readonly WorkBuddyWebModel[]
      newModelIds?: unknown
      showNewModelsInMainUi?: unknown
    }
    // Absent means OFF (opt-in), matching the host's own `=== true` reading.
    const showNewModels = body.showNewModelsInMainUi === true
    // Missing levels are an empty set, not an error: the promotions often ride
    // along on a response whose probe has not run, and losing them because the
    // probe is cold would be a second, unrelated failure.
    const promos: Record<string, readonly WorkBuddyPromo[]> = {}
    const rates: Record<string, number> = {}
    for (const model of body.models ?? []) {
      if (model.creditMultiplier !== undefined) rates[model.id] = model.creditMultiplier
      if (model.promos !== undefined) promos[model.id] = model.promos
    }
    const snapshot: StatusSnapshot = {
      levels: body.busyLevels ?? {},
      promos,
      rates,
      // Same opt-in as the composer segment (`showNewModelsInMainUi`): the two
      // surfaces read ONE snapshot, so turning the switch off must silence the
      // per-row mark too, or the picker would keep claiming "新" for a feature
      // the user turned off.
      newModelIds: showNewModels ? normalizeNewModelIds(body.newModelIds) : [],
    }
    caches.set(region, { snapshot, at: Date.now() })
    return snapshot
  } catch {
    // The Host is unreachable or refused: no badge. Never a made-up one.
    return undefined
  }
}

/** Forget the cached snapshots; used by the tests. */
export function resetBusyLevelCache(): void {
  caches.clear()
}

/** One shared minute ticker, so N mounted labels cost one timer, not N. */
const minuteTicker: { timer: ReturnType<typeof setInterval> | undefined, listeners: Set<() => void> } = {
  timer: undefined,
  listeners: new Set(),
}

/**
 * Re-render the caller once a minute while it is mounted.
 *
 * @param listener - The callback to run at each tick.
 * @returns The unsubscribe function, which stops the shared timer when the last
 *          listener leaves.
 */
function subscribeMinute(listener: () => void): () => void {
  minuteTicker.listeners.add(listener)
  if (minuteTicker.timer === undefined) {
    minuteTicker.timer = setInterval(() => {
      for (const each of [...minuteTicker.listeners]) each()
    }, TICK_MS)
    // A pending interval keeps the Node event loop alive. This one exists for
    // the UI, so it must never be the reason a test run or a CLI command hangs.
    const handle = minuteTicker.timer as unknown as { unref?: () => void }
    handle.unref?.()
  }
  return () => {
    minuteTicker.listeners.delete(listener)
    if (minuteTicker.listeners.size === 0 && minuteTicker.timer !== undefined) {
      clearInterval(minuteTicker.timer)
      minuteTicker.timer = undefined
    }
  }
}

/**
 * The upstream's promotion badge, as the picker draws it.
 *
 * Reuses the card's chip class so the two surfaces cannot drift apart, and adds
 * one modifier for the two things a menu row changes: the chip must fit a row
 * that is one line wide (see `.dsm-workbuddy-model-label-promo` in the card's
 * stylesheet), and it is the only place the full tooltip is available.
 *
 * @param props - The resolved promotion, and whether space is tight.
 * @returns The chip.
 */
function PromoBadge(props: { promo: WorkBuddyPromo, compact: boolean }): ReactElement {
  const { promo, compact } = props
  const language = uiLanguage()
  const label = compact ? promoBadgeShortLabel(promo, language) : promoBadgeLabel(promo, language)
  const color = promoBadgeColor(promo)
  const tooltip = promoBadgeTooltip(promo, language)
  // A custom property cannot be written as an object literal in React's
  // `CSSProperties` type, so the style is built as a plain record first.
  const style: Record<string, string> | undefined = color === undefined
    ? undefined
    : { '--dsm-workbuddy-promo-color': color }
  return (
    <span
      className="dsm-workbuddy-model-promo dsm-workbuddy-model-label-promo"
      title={tooltip === '' ? undefined : tooltip}
      style={style}
    >
      <span className="dsm-workbuddy-model-label-promo-text">{label}</span>
    </span>
  )
}

/**
 * The "本机首次见到" marker, as the picker draws it.
 *
 * WHY IT IS HERE AT ALL. The pill's "· N 新模型" answers "how many" and its
 * panel answers "which" — but only once the reader opens it. The picker is
 * where the choice is actually made, and this is the SAME set marked on the
 * row, so a newly seen model is visible the moment the picker opens, with no
 * extra step. It reads the pill's normalised list (`normalizeNewModelIds`), not
 * a second reading of the same field, so the two surfaces cannot disagree.
 *
 * MUTED, and muted further than the promotion chip: a promotion is a fact about
 * price, "新" only says when this machine first recorded the id. The pill's ink
 * (label-dimmed) is reused here for the same reason it is used there — the
 * marker must not out-shout the model name or the chip beside it.
 */
function NewModelMark(): ReactElement {
  const language = uiLanguage()
  return (
    <span
      className="dsm-workbuddy-model-label-new"
      title={language === 'zh' ? '本机首次见到的模型' : 'First seen by this machine'}
    >
      {language === 'zh' ? '新' : 'NEW'}
    </span>
  )
}

/**
 * One provider-authored selector badge, as the host publishes it in the model
 * catalog (`LlmModelInfo.badge`, DSH 0.2.2+).
 *
 * Declared LOCALLY rather than imported from `@deepseek-ai/dsh-llm` on purpose:
 * this plugin's peer range still starts at `0.1.7-rc.1`, where that field does
 * not exist. Importing the type would fail to compile against the older
 * declaration and buy nothing — the wire shape is three fields, and on 0.1.x the
 * value simply never arrives (`undefined`). See `docs/MODEL-LABEL-SPEC.md`.
 */
export interface HostModelBadge {
  text: string | Record<string, string>
  tone: 'neutral' | 'info' | 'success' | 'warning'
}

/**
 * The one line a foreign badge shows, in the reader's language.
 *
 * Mirrors the host's own resolver (`ctx.locale.resolveText`): a plain string is
 * used verbatim; a table is looked up by the full lowercase tag, then its base
 * tag (`de-DE` → `de`), then `en`, which the contract requires. The host treats
 * an EMPTY string as a translation that exists, so this function deliberately
 * goes one step further and treats it as absent — a blank chip is a decoration
 * that says nothing, and this component would rather draw the bare name.
 *
 * @param text - The badge's literal or its translation table.
 * @returns The line to draw, or `undefined` when nothing readable is left.
 */
function resolveHostBadgeText(text: HostModelBadge['text']): string | undefined {
  if (typeof text === 'string') return text.trim() === '' ? undefined : text
  // A malformed table (null, an array) must degrade to "no badge", never throw:
  // an exception here would retire this whole component from the cell.
  if (text === null || typeof text !== 'object') return undefined
  const language = uiLanguage().toLowerCase()
  const base = language.split('-')[0] ?? ''
  const picked = text[language] ?? (base === '' ? undefined : text[base]) ?? text.en
  if (typeof picked !== 'string' || picked.trim() === '') return undefined
  return picked
}

/**
 * The tone palette, mapped onto the tokens the host's own `Tag` paints.
 *
 * WHY THESE EXACT TOKENS. They are read off the host's `Tag.module.css`
 * (0.2.2-rc.1), not invented: `info` rides `state-business-primary` (NOT
 * `brand-primary`) and `warning` rides `state-warn-primary` (NOT
 * `state-warn-secondary`). Getting either wrong leaves two chips in one row
 * that are supposed to look identical and do not.
 *
 * `neutral` is the fallback for an unknown tone: the host's `Tag` would render
 * such a chip unstyled, which reads as a rendering bug next to a real one.
 */
const HOST_BADGE_TONES: Record<HostModelBadge['tone'], { color: string, background: string }> = {
  neutral: { color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-module-platform)' },
  info: { color: 'var(--dsw-alias-state-business-primary)', background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)' },
  success: { color: 'var(--dsw-alias-state-success-primary)', background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)' },
  warning: { color: 'var(--dsw-alias-state-warn-primary)', background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)' },
}

/**
 * A badge another provider published for its own model, drawn where the host's
 * own fallback would have drawn it.
 *
 * WHY THIS PLUGIN DRAWS IT AT ALL. `conversation.input.model.label` is a
 * `single` slot, so this component is called for EVERY provider's rows, not just
 * its own. The host only runs its own badge fallback when the cell has no
 * occupant at all, so without this branch a sibling plugin's badge would never
 * appear anywhere while this plugin holds the cell.
 *
 * WHY IT IS NOT INTER-PLUGIN COORDINATION (`docs/DESIGN.md` §零). The data is
 * `props.model.badge` — the host's catalog field, handed to every occupant of
 * the cell. This component does not know which plugin filled it, does not read
 * the slot ledger, does not render another plugin's component, and its output is
 * identical whether or not any sibling is installed. Data flows one way through
 * the host; there is no channel between plugins. That is the difference between
 * this and §零's rejected "copy the host's 1017 badge", which hard-codes one
 * specific plugin's conditions and styles.
 *
 * NOT A FETCH, NOT A TIMER. A picker can show twenty foreign rows at once, so
 * this must stay a pure function of its props.
 *
 * NO `placement` PARAMETER, DELIBERATELY. The chip is always drawn AFTER the
 * name now, so where it goes is the caller's one-line decision, not something
 * this function needs to know. It used to take `placement` and ignore it, which
 * read as though a placement-dependent rule existed inside the chip.
 *
 * @param props - The badge to draw.
 * @returns The chip, or `undefined` when there is nothing readable to draw.
 */
function HostBadgeChip(props: { badge: HostModelBadge }): ReactElement | undefined {
  // A `null` badge would throw on `.text` below and retire this WHOLE component
  // from the cell, costing every row its decoration. The host's 0.2.2
  // normalization already filters `null` out (`badge === void 0 ? {} : …`), but
  // that is the host's current implementation, not this component's contract.
  const badge = props.badge as HostModelBadge | null | undefined
  if (badge === null || typeof badge !== 'object') return undefined
  const label = resolveHostBadgeText(badge.text)
  if (label === undefined) return undefined
  // `Object.hasOwn` and not a bare index: `HOST_BADGE_TONES['constructor']`
  // walks the prototype chain and returns a function, which `??` happily
  // accepts, leaving a chip with NO colour at all. The host does not validate
  // `tone` either, so a wrong value can genuinely arrive.
  const tone = Object.hasOwn(HOST_BADGE_TONES, badge.tone)
    ? HOST_BADGE_TONES[badge.tone]
    : HOST_BADGE_TONES.neutral
  return (
    <span
      className="dsm-workbuddy-model-label-host-badge"
      title={label}
      style={{ color: tone.color, background: tone.background }}
    >
      {label}
    </span>
  )
}

/**
 * Whether a model's badge will actually draw something.
 *
 * The caller needs this BEFORE it decides on the separator: `<HostBadgeChip/>`
 * is always an element, so rendering `{chip} {name}` and then finding the chip
 * empty leaves a trailing space on the row. Deciding from the text is the only
 * way to know, which is why the resolution is exported rather than duplicated.
 *
 * @param badge - The catalog badge, if any.
 * @returns Whether a chip will be drawn.
 */
function hasDrawableBadge(badge: HostModelBadge | undefined): badge is HostModelBadge {
  // `null` and non-objects are refused here too, not only in `HostBadgeChip`:
  // this is the guard that runs FIRST, so a malformed value must not reach
  // `.text` through it either.
  const candidate = badge as HostModelBadge | null | undefined
  if (candidate === null || typeof candidate !== 'object') return false
  return resolveHostBadgeText(candidate.text) !== undefined
}

/** The props the host's picker hands to whatever wins the model-label cell. */
export interface WorkBuddyModelLabelProps {
  provider: { id: string, name: string }
  model: {
    id: string
    name: string
    /**
     * The model's own catalog badge, if its provider published one.
     *
     * The host spreads the whole catalog model into these props, so a badge a
     * sibling plugin attached in ITS `adapter.listModels()` arrives here. Absent
     * on every host before 0.2.2 and absent on models that carry none — the two
     * cases are indistinguishable, which is why nothing branches on the host
     * version.
     */
    badge?: HostModelBadge
  }
  placement: 'trigger' | 'menu' | 'option'
  selected: boolean
}

/**
 * The priority this plugin registers the model-label slot at.
 *
 * WHY A DISTINCT PRIORITY AT ALL. `conversation.input.model.label` is a
 * `single` slot: it holds ONE cell, and `SlotCore.register()` THROWS when a
 * second registration claims one priority — "single slot … already has a
 * registration at priority 0 — register at a different priority to shadow it
 * (lowest renders)". The default priority is `0`, which is also what the host's
 * own shipped contributor uses
 * (`@deepseek-ai/dsh-client-ui-deepseek-model-label-1017`, in the web-app
 * bundle from 0.2.1-rc.2 on), so registering at `0` made the two race. Measured
 * on 0.2.1-rc.3 that is US: the app's own crash log records
 * `single slot "conversation.input.model.label" already has a registration at
 * priority 0 (registered by Kb)` and this entry's catch-all line
 * `model label slot failed to register`, and because that catch only logs, the
 * badge simply vanished from the picker with no visible error.
 *
 * WHY NOT `-1`. That is `dsh-connect-qoder`'s slot priority, and two plugins on
 * one priority collide for exactly the same reason `0` did.
 *
 * WHY `-0.5` WAS TOO HIGH — the measured defect. `-0.5` is legal and collides
 * with nothing, but "distinct from everyone" is NOT the same as "wins", and this
 * cell only renders its LOWEST priority. `-0.5` sits ABOVE two contributors that
 * were present in the same profile:
 *
 *     dsh-connect-qoder   -1
 *     dsh-connect-trae    -0.25
 *     this plugin         -0.5   ← lost to qoder, so this component never ran
 *
 * Losing is silent by construction: the winner renders, the loser is simply not
 * called. The symptom is exactly "the picker shows no badges", with correct
 * data, a correct component and no error anywhere — which is what made this cost
 * several rounds to find. The rows still showed `Hy4 · x0.00` because that
 * string is the catalog `model.name` the WINNER drew, not our label.
 *
 * WHY `-105`. The value has to be BELOW every plausible claimant, not merely
 * different from the ones visible today. That is the whole lesson: `-0.5` was
 * chosen to be DISTINCT, was distinct, and still lost. Contributors already
 * shipped at `-10` (`dsh-model-picker-brand`, a label decorator) and `-1`
 * (`dsh-connect-qoder`), so anything in the single digits is a value someone
 * else can step under. `-105` is an ordinary number to the sort (no range is
 * reserved) and makes the ordering a decision of this plugin rather than a race
 * it keeps losing.
 *
 * WHY NOT `-100` — MEASURED, TWICE. `-100` won for a while, then two other
 * connectors moved underneath it in the same profile:
 *
 *     dsh-connect-qoder   -1   → -101
 *     dsh-connect-trae    -0.25 → -102
 *     this plugin         -100 → lost to both
 *
 * Both of them wrote THIS constant into their own source comments while doing
 * it, which is the clearest evidence that the cell is a contest and not a
 * composed surface: each new connector reads the others' shipped values and
 * steps under the lowest one. `-105` keeps a small gap below `-102` rather than
 * a huge one, so the next connector that wants the cell has to say so
 * explicitly too.
 *
 * THE COST, STATED PLAINLY. Winning here is not free: in `single` semantics the
 * winner draws EVERY row, so trae's and qoder's chips would disappear from the
 * picker exactly as ours did. What closes that gap is NOT a priority choice — it
 * is `HostBadgeChip` below: a sibling plugin publishes its badge in ITS
 * `adapter.listModels()`, the host carries it in the catalog, and this component
 * reproduces it on that plugin's rows. Every connector that adopts that channel
 * keeps its chip whichever of them wins the cell (`docs/MODEL-LABEL-SPEC.md`).
 * This value is still chosen so the users of THIS plugin see its full surface,
 * not because the arrangement is fair.
 *
 * A low priority is also the CORRECT semantic here: this label shows more than
 * any other contributor (name + price + promotion + load + new-model mark), so
 * it should be the one that takes the cell when several want it.
 *
 * WHAT THIS PLUGIN DELIBERATELY DOES NOT DO. It does not read the slot ledger,
 * does not look for another plugin's registration, and does not render another
 * plugin's component. Foreign rows get the plain catalog name PLUS the model's
 * own `badge`, when the host's catalog carries one — that badge is host data
 * (`props.model.badge`), not another plugin's component, and this component
 * cannot tell which provider wrote it. Inter-plugin chaining is out of scope by
 * project policy (`docs/DESIGN.md` §零) — and that policy is NOT stricter than
 * the Host's own: the shipped `dsh-client-ui-deepseek-model-label-1017` README
 * lists, under "Known Limitations and Deferred Work", that "another model-label
 * plugin at the same priority conflicts; the two presentations do not compose
 * automatically", and the remedy it documents is DISABLING it in the profile
 * patch — a configuration decision, not a runtime negotiation. Reproducing a
 * catalog badge is neither of those: nothing here branches on another plugin
 * being present.
 *
 * WHY WINNING IS THE RIGHT SIDE OF THAT TRADE. 1017 is a TEMPORARY marker
 * (its own package description: "Temporary 1017 release badge …"; its README
 * says to remove the package and its bundle row once structured release labels
 * replace it) and it decorates exactly ONE model, on two provider routes. This
 * plugin decorates every WorkBuddy model row with load level, promo price and
 * the new-model mark — its core surface. Trading a long-lived feature for a
 * temporary marker is the wrong way round, and when 1017 is removed this
 * plugin is already the only occupant of the cell.
 *
 * Exported so the test asserts against the value that actually ships rather
 * than a copy of it.
 */
export const MODEL_LABEL_PRIORITY = -105

/**
 * The label for one model row in the host's picker.
 *
 * Self-contained by design: a model this plugin owns gets the full label, and
 * anything else gets the catalog name plus that model's own `badge`, if its
 * provider published one. There is no forwarding and no consultation of other
 * plugins' registrations — see `MODEL_LABEL_PRIORITY`.
 *
 * @param props - The host's model identity and the placement of this label.
 * @returns The catalog name, the promotion chip when one holds, the load badge
 *          when the probe reported one, or a sibling's badge on a foreign row.
 */
export function WorkBuddyModelLabel(props: WorkBuddyModelLabelProps): ReactElement {
  const { provider, model, placement } = props
  const region = regionOfProvider(provider.id)
  if (region === undefined) {
    // Another provider's model. The badge, when its provider published one, is
    // reproduced so it survives this plugin holding the cell. With no drawable
    // badge this is the plain catalog name, which is the slot contract's
    // minimum — see `HostBadgeChip` for why drawing a sibling's badge is data,
    // not the inter-plugin linkage `docs/DESIGN.md` §零 rules out.
    //
    // THE BADGE IS ALWAYS AFTER THE NAME, ON EVERY PLACEMENT. The host's own
    // fallback moves it BEFORE the name on the trigger and AFTER it in menus;
    // this plugin does not follow that, on purpose. Following it produced the
    // worst of both worlds: this plugin's own rows are always "name, then chip",
    // so a single open menu showed "chip name" for other providers' models and
    // "name chip" for its own — two orders in one list, which reads as a
    // rendering bug rather than a rule. One order for every row, both branches,
    // is the only arrangement a user can learn. See `docs/MODEL-LABEL-SPEC.md`.
    //
    // THE WRAPPER IS A FLEX ROW, NOT A BARE SPAN WITH A SPACE. The host's own
    // fallback wraps name and badge in `.badgedName`
    // (`display:inline-flex; align-items:center; gap:4px`), and this plugin's
    // own rows use the same model (`.dsm-workbuddy-model-label`). A bare span
    // with a space instead aligns the chip on the TEXT BASELINE, and since the
    // chip is itself `inline-flex` its baseline comes from its inner text — so
    // the pill rides visibly HIGHER than on a flex row. That was a real
    // mismatch against WorkBuddy's own rows in the picker; the two branches
    // must share one alignment model.
    if (!hasDrawableBadge(model.badge)) return <span>{model.name}</span>
    return (
      <span className="dsm-workbuddy-model-label dsm-workbuddy-model-label-host-row">
        <span>{model.name}</span>
        <HostBadgeChip badge={model.badge} />
      </span>
    )
  }
  return <WorkBuddyModelLabelInner
    modelId={model.id}
    name={model.name}
    region={region}
    compact={placement !== 'trigger'}
  />
}

/** The stateful half: fetches the snapshot, then renders what holds right now. */
function WorkBuddyModelLabelInner(props: {
  modelId: string
  name: string
  region: WorkBuddyWebRegion
  compact: boolean
}): ReactElement {
  const { modelId, name, region, compact } = props
  const [snapshot, setSnapshot] = useState<StatusSnapshot | undefined>(undefined)
  const [, setTick] = useState(0)

  useEffect(() => {
    let live = true
    void statusNow(region).then(next => {
      // Superseded while in flight: a newer answer must not be overwritten by
      // an older one.
      if (!live || next === undefined) return
      setSnapshot(next)
    })
    return () => { live = false }
  }, [modelId, region])

  // The clock is an input to the badge, so the component has to re-read it
  // while it is mounted. One shared timer for every label keeps an open menu
  // with twenty rows from starting twenty intervals.
  useEffect(() => subscribeMinute(() => setTick(count => count + 1)), [])

  const level = snapshot?.levels[modelId]
  // Resolved against NOW, not against the fetch: a night window that opened
  // after this snapshot was cached still shows, and one that closed stops.
  const promo = snapshot === undefined ? undefined : selectPromoBadge(snapshot.promos[modelId], Date.now())

  // Same clock as the badge: a standing "night discount" entry outside its
  // hours must not change the price (issue #120).
  const discounted = snapshot === undefined ? undefined : selectPromoMultiplier(snapshot.promos[modelId], Date.now())

  // The host's `model.name` ALREADY ends in the catalog multiplier
  // (`DeepSeek-V4.1-Flash · x0.11` — see `workBuddyDisplayName`), so appending
  // another rate would print the figure twice (observed in the picker). The
  // catalog figure is therefore STRIPPED from the name and drawn separately,
  // and the discounted one takes its place: always exactly one number, and it
  // is the one that holds right now.
  const { base, rate } = splitCatalogRate(name, snapshot?.rates[modelId], discounted)

  return (
    <span className="dsm-workbuddy-model-label">
      <span>{base}</span>
      {rate === undefined ? null : <span className="dsm-workbuddy-model-label-rate"> · x{rate.toFixed(2)}</span>}
      {promo === undefined ? null : <PromoBadge promo={promo} compact={compact} />}
      {level === undefined ? null : busyIcon(level, 'zh')}
      {(snapshot?.newModelIds.includes(modelId) ?? false) ? <NewModelMark /> : null}
    </span>
  )
}

/**
 * Split the host's display name into "name" and "the multiplier to show".
 *
 * `workBuddyDisplayName` builds `"<name> · x<multiplier>"` and the host renders
 * that string verbatim, so appending another rate next to it printed the figure
 * twice in the picker (`DeepSeek-V4.1-Flash · x0.11 · x0.11`). The suffix is
 * therefore pulled back OUT of the string and re-drawn in the span that can
 * carry the discounted value — exactly one number, and it is the one that holds
 * right now.
 *
 * The suffix is recognised by SHAPE, not by comparing against the snapshot's
 * `baseRate`: the two can disagree (a promotion can change the catalog figure
 * between the snapshot and this render), and leaving the suffix in place then
 * prints two numbers again — the very defect this function removes.
 *
 * @param name - The host's rendered name, possibly ending in ` · x<rate>`.
 * @param baseRate - The catalog multiplier, as the snapshot reports it.
 * @param discounted - The rate to show instead, when a discount is running.
 * @returns The name without its rate suffix, and the single rate to draw.
 *          `undefined` means "draw no number" (the name had none and no
 *          discount is running).
 */
export function splitCatalogRate(
  name: string,
  baseRate: number | undefined,
  discounted: number | undefined,
): { base: string, rate: number | undefined } {
  const match = / · x(\d+(?:\.\d+)?)$/.exec(name)
  const fromName = match === null ? undefined : Number(match[1])
  const base = match === null ? name : name.slice(0, match.index)
  // The discount wins; otherwise keep the number the name carried; otherwise
  // fall back to the snapshot (a name with no suffix still gets its rate).
  const rate = discounted ?? fromName ?? baseRate
  return { base, rate }
}

