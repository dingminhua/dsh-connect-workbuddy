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
 * FOR A PROVIDER THAT IS NOT OURS IT RENDERS THE PLAIN CATALOG NAME — not
 * nothing. The distinction is not cosmetic: this slot is `kind: "single"`, so
 * whatever registers becomes the cell's only occupant, and an occupant that
 * outputs plain text still occupies it. A previous version of this paragraph
 * said the component "renders nothing at all" for a foreign provider, which
 * made the lost-decoration cost look harmless; issue #138 is what that
 * mis-description looks like from the outside (the host's own 1017 badge
 * disappears on ITS rows while this plugin holds the cell). Returning `null`
 * would not free the cell either — occupancy is decided by registration, never
 * by what the component outputs.
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

/** The props the host's picker hands to whatever wins the model-label cell. */
export interface WorkBuddyModelLabelProps {
  provider: { id: string, name: string }
  model: { id: string, name: string }
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
 * WHY `-0.5` IS SAFE AND SELF-CONTAINED. The value only has to be distinct from
 * whatever else claims the cell; `-0.5` is legal, sorts without collision
 * against both `-1` and `0`, and requires knowing nothing about the other
 * plugins. See the "不做插件联动" invariant in `docs/DESIGN.md`.
 *
 * WHAT THIS PLUGIN DELIBERATELY DOES NOT DO. It does not read the slot ledger,
 * does not look for another plugin's registration, and does not render another
 * plugin's component. Foreign rows get the plain catalog name, which is exactly
 * the slot's documented minimum. Inter-plugin chaining is out of scope by
 * project policy (`docs/DESIGN.md` §零) — and that policy is NOT stricter than
 * the Host's own: the shipped `dsh-client-ui-deepseek-model-label-1017` README
 * lists, under "Known Limitations and Deferred Work", that "another model-label
 * plugin at the same priority conflicts; the two presentations do not compose
 * automatically", and the remedy it documents is DISABLING it in the profile
 * patch — a configuration decision, not a runtime negotiation. A consequence is
 * that when this plugin wins the cell, another contributor's decoration on ITS
 * rows is not composed; that is an accepted, documented trade-off rather than
 * something to work around at runtime.
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
export const MODEL_LABEL_PRIORITY = -0.5

/**
 * The label for one model row in the host's picker.
 *
 * Self-contained by design: a model this plugin owns gets the full label, and
 * anything else gets the plain catalog name. There is no forwarding and no
 * consultation of other plugins' registrations — see `MODEL_LABEL_PRIORITY`.
 *
 * @param props - The host's model identity and the placement of this label.
 * @returns The catalog name, the promotion chip when one holds, and the load
 *          badge when the probe reported one.
 */
export function WorkBuddyModelLabel(props: WorkBuddyModelLabelProps): ReactElement {
  const { provider, model, placement } = props
  const region = regionOfProvider(provider.id)
  if (region === undefined) {
    // Another provider's model. Returning the plain name is the slot contract's
    // minimum — but note that it IS an output, and this cell is `single`, so the
    // other contributor's decoration on these same rows is not rendered at all.
    // That cost is the `docs/DESIGN.md` §零 trade-off, stated here because this
    // is the line it happens on (issue #138).
    return <span>{model.name}</span>
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

