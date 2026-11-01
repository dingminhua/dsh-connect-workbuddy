/**
 * Whether the OPTIONAL sidebar panel is switched on, as the browser half sees
 * it, plus the tiny subscription the registration controller needs.
 *
 * ## Why this is a module-level store and not component state
 *
 * The `sidebar.panellist` row is built from ENTRY METADATA, not from the
 * component: `ui-sidebar`'s `SidebarRoot` maps `usePanels(...)` (the slot's
 * entries) into a `PanelRow` button whose label comes from `options.label` and
 * whose glyph is `renderSlot(...)`. A component that returns `null` therefore
 * does not hide the row — it renders a BLANK, still-clickable nav button. That
 * is why the panel cannot use the `ComposerCreditsGate` trick the composer
 * readout uses (that seat renders a list of components, so `null` means
 * absent). The row has to be registered only while the switch is on, and
 * unregistered when it goes off.
 *
 * Registering conditionally in turn means something must OWN the re-register on
 * a settings change, and that something lives in the entry (`apply`), not in a
 * component. This module is the seam between the two: the card writes a value
 * here after it has verified a write landed, and the entry subscribes to
 * register or dispose.
 *
 * ## Why the Host is the seed
 *
 * The value is DELIVERED by the Host on the status document
 * (`sidebarPanelEnabled`), for the reason every other switch in this plugin is
 * Host-carried: this namespace's browser mirror is documented as stale on the
 * affected 0.1.7 deployments. Reading only the settings scope at startup would
 * let a stale `false` hide a row the Host believes it is serving — with nothing
 * to re-evaluate it afterwards, the panel would then be gone for the session.
 *
 * Turning the panel OFF while the page is open needs no special handling here:
 * `ui-layout`'s `retainMainPanels` drops an `activePanelId` whose `main` key no
 * longer exists, so the centre column returns to the conversation by itself.
 */

/** Listeners waiting for a change to the opt-in state. */
const listeners = new Set<() => void>()

/**
 * The current answer, defaulting to OFF.
 *
 * OFF is the whole point of this switch: an absent or unreadable value must
 * never turn the row on. See `Config.sidebarPanel` in `src/index.ts`.
 */
let wanted = false

/** Whether the sidebar panel should currently be registered. */
export function sidebarPanelWanted(): boolean {
  return wanted
}

/**
 * Set the opt-in state and notify the registration controller.
 *
 * Idempotent: the controller re-registers on every call, and a settings
 * subscription can legitimately report the same value twice. Callers that
 * cannot tell whether the value changed need not check first.
 *
 * @param next - the desired state.
 */
export function setSidebarPanelWanted(next: boolean): void {
  if (wanted === next) return
  wanted = next
  for (const listener of [...listeners]) {
    try { listener() } catch { /* one bad listener must not strand the rest */ }
  }
}

/**
 * Observe changes to the opt-in state.
 *
 * @param listener - invoked after each change.
 * @returns the disposer removing this listener.
 */
export function subscribeSidebarPanelWanted(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Reset the store between tests.
 *
 * Exported for the specs only: production code never wants to un-set this.
 */
export function resetSidebarPanelWanted(): void {
  wanted = false
  listeners.clear()
}
