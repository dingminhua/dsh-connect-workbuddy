/**
 * How many registrations the model-label seat needs, and under which keys.
 *
 * WHY THIS IS A RUNTIME QUESTION, NOT A CONSTANT. The host's
 * `conversation.input.model.label` is declared in
 * `@deepseek-ai/dsh-client-ui-model-selection`, and until the host changes that
 * declaration it is a `single` slot with exactly ONE cell:
 *
 *   - `single`: every registration shares the undefined cell, so the ledger's
 *     first entry in priority order is the only one that ever renders and every
 *     other registration is silently discarded (`entriesOfSlot` dedupes by cell,
 *     and every single entry's cell is `undefined`).
 *   - `keyed`: each `options.key` is its own cell, so N registrations can each
 *     win their own cell and no priority ordering decides who is visible.
 *
 * The picker dispatches the label once per model row with owner props
 * `{ provider, model, placement, selected }`, so a cell keyed by `provider.id`
 * is exactly one row's decoration. That is the shape this plugin wants: it owns
 * two provider ids and should decorate its OWN rows, never another provider's.
 *
 * ⚠️ BUT CHANGING THE DECLARATION IS NOT ENOUGH: the owner must also pass
 * `entryKey`. Verified against the shipped `ui-model-selection@0.2.2-rc.1`
 * artifact — the slot has exactly ONE render call site there, and its third
 * argument carries only `fallback`, with no `entryKey`. The renderer's keyed
 * branch is `find(e => e.options.key === opts?.entryKey)`; with `opts.entryKey`
 * undefined it matches no provider-keyed entry, so EVERY row renders
 * `opts.fallback`. The registration here still succeeds, the inject callback
 * still runs, nothing throws and nothing logs — the component is simply never
 * called again. The upstream minimum is therefore TWO changes: declare the slot
 * `keyed`, AND pass `{ entryKey: provider.id }` at the call site. A
 * declaration-only flip silently blanks the whole family's labels.
 *
 * WHY BOTH SHAPES SHIP IN ONE BUILD. The plugin cannot know which host it is
 * running on, and the two are not interchangeable (each failure is silent ON THE
 * PAGE — the caller's catch does log one `console.error` line, which is no help
 * to the person looking at an unlabelled picker):
 *
 *   - Registering a keyed seat on a `single` host is meaningless: the `key` is
 *     carried on the entry (so `single`'s duplicate check, which compares only
 *     priority, still fires) and the cell it lands in is the shared undefined
 *     one. Nothing is gained and the second seat below is what actually breaks.
 *   - Registering N keyed seats on a `single` host is worse: the second one
 *     throws `single slot … already has a registration at priority …`, and the
 *     plugin's catch would turn that into the very silent disappearance this
 *     whole file exists to explain.
 *   - Registering ONE unkeyed seat on a `keyed` host throws
 *     `keyed slot … requires options.key`, which is the hard failure the
 *     upstream proposal does not mention.
 *
 * So the kind is READ AT MOUNT (`ctx.slots.spec(key).kind`, a public accessor on
 * both 0.1.7 and 0.2.2) and the seat list is derived from it. One build serves
 * both lines, and the day the host flips to `keyed` this plugin starts drawing
 * only its own rows without a release.
 *
 * WHY THE PRIORITY SURVIVES THE KEYED PATH. Under `keyed`, priority stops
 * deciding visibility — but it still decides who wins a cell when TWO plugins
 * claim the same provider id at the same priority (that throws) or at different
 * priorities (lowest renders). The value therefore keeps its old meaning inside
 * a cell and loses its old meaning across plugins, which is precisely the
 * armistice: this plugin no longer has to out-bid qoder or trae, because they
 * do not share a cell with it.
 */

/** The `kind` values a host may declare for a slot. */
export type ModelLabelSeatKind = 'single' | 'list' | 'keyed' | 'chain'

/** One `register()` options object for the model-label slot. */
export interface ModelLabelSeat {
  name: string
  /** Always present: the seat list is built from one configured priority. */
  priority: number
  /** Present exactly on the keyed seats; each is one cell. */
  key?: string
}

/**
 * Read the declared kind of a slot, or `undefined` when it is not declared yet.
 *
 * `spec()` is the documented read-only accessor (`SlotRegistry.spec`), present
 * on 0.1.7 and on 0.2.2. It is also the only way to learn the kind: the
 * declaration lives in the host package, and a plugin's own `SlotMap`
 * augmentation says what this plugin HOPES the slot is, not what the running
 * host declared.
 *
 * Anything unexpected — no `spec` method on an older line, a throw from a
 * service that is not ready, a kind this build does not know — returns
 * `undefined`, and the caller falls back to the single-cell shape. That is the
 * conservative direction: it is what every released version of this plugin
 * already does.
 *
 * @param slots - The `slots` service (typed loosely: the accessor is optional).
 * @param key - The slot key to inspect.
 * @returns The declared kind, or `undefined`.
 */
export function declaredSlotKind(slots: unknown, key: string): ModelLabelSeatKind | undefined {
  const face = slots as { spec?: (slotKey: string) => { kind?: unknown } | undefined } | undefined
  if (face === undefined || typeof face.spec !== 'function') return undefined
  let spec: { kind?: unknown } | undefined
  try {
    spec = face.spec(key)
  } catch {
    // A throwing accessor means the service is not ready or not this line's
    // shape. Unknown is the honest answer, not a guess.
    return undefined
  }
  const kind = spec?.kind
  if (kind === 'single' || kind === 'list' || kind === 'keyed' || kind === 'chain') return kind
  return undefined
}

/**
 * The registrations this plugin should make for the model-label seat.
 *
 * `keyed` yields ONE seat per provider id: each is its own cell, each renders
 * only the rows whose owner props carry that provider id, and a provider this
 * plugin does not own falls through to the owner's own fallback (the catalog
 * name, plus that model's `badge` on hosts that have one).
 *
 * Every other kind — including `undefined`, i.e. a host that cannot be
 * inspected — yields the single historical seat. That is not a degraded mode:
 * it is what `single` requires, and on a not-yet-declared slot it is what the
 * inject callback is about to find.
 *
 * An empty provider list under `keyed` would silently disable the label, so it
 * falls back to the single seat instead: a wrong-shaped registration that still
 * draws something beats a correct-shaped registration that draws nothing.
 *
 * @param params - Slot key, declared kind, this plugin's provider ids, priority.
 * @returns One or more `register()` option objects, in registration order.
 */
export function modelLabelSeats(params: {
  name: string
  kind: ModelLabelSeatKind | undefined
  providerIds: readonly string[]
  priority: number
}): ModelLabelSeat[] {
  const { name, kind, providerIds, priority } = params
  // `list` and `chain` are NOT single: their `register()` requires options this
  // planner does not supply (`list` needs `options.id`, `chain` needs
  // `options.select`), so the single-seat fallback below would be REFUSED — a
  // plan that cannot register is worse than no plan, because it looks like an
  // attempt. Returning an empty list is the honest answer: this plugin has no
  // seat in either contract. Serving them would be a different design (an id to
  // filter on, or a selector to elect with), not a shape change.
  if (kind === 'list' || kind === 'chain') return []
  if (kind === 'keyed' && providerIds.length > 0) {
    // Same priority on every key: priority is a per-cell tie-breaker, and all
    // these cells belong to this plugin, so there is nothing to rank.
    return providerIds.map(id => ({ name, key: id, priority }))
  }
  return [{ name, priority }]
}

/**
 * Claim every planned seat, atomically, and hand back ONE disposer.
 *
 * WHY ATOMIC. The seat list is 2-3 entries on a `keyed` host, and `register()`
 * can throw on any ONE of them — a rival plugin claiming the same provider id at
 * the same priority, or the declaration collapsing mid-loop. A plain `.map()`
 * would then leave the earlier seats landed on the ledger with their disposers
 * unreachable (they were only ever held by the array that the throw discarded),
 * which is worse than failing outright: the component stays mounted, the caller
 * believes registration failed, and nothing will ever release those cells. On a
 * `single` host it also means the identity keeps a live entry that the next
 * `inject` re-run cannot displace without a priority clash.
 *
 * So a partial failure is rolled back in reverse order before the error is
 * rethrown, exactly as if it had never been attempted. The rethrow is important:
 * each caller already has a catch that logs, and swallowing here would hide the
 * refusal from the diagnostics that exist to explain it.
 *
 * A disposal that itself throws must not mask the original error, hence the
 * inner catch — the registry treats a second dispose as a no-op, and a broken
 * one must not turn one failure into a crash.
 *
 * @param seats - The plan from {@link modelLabelSeats}, in registration order.
 * @param register - Claims one seat and returns its disposer.
 * @returns One disposer that releases every seat, in reverse registration order.
 */
export function registerModelLabelSeats(
  seats: readonly ModelLabelSeat[],
  register: (seat: ModelLabelSeat) => () => void,
): () => void {
  const claimed: (() => void)[] = []
  try {
    for (const seat of seats) claimed.push(register(seat))
  } catch (error: unknown) {
    for (const dispose of [...claimed].reverse()) {
      try { dispose() } catch { /* already disposed by the slot service */ }
    }
    throw error
  }
  return () => {
    for (const dispose of [...claimed].reverse()) {
      try { dispose() } catch { /* already disposed by the slot service */ }
    }
  }
}
