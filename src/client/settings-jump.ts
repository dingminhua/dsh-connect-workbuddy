/**
 * The route from this plugin's UI to its **Settings section** (设置 → WorkBuddy).
 *
 * ## Two routes, best first
 *
 * 1. **The settings shell's store seat** — one call, exact, no timing:
 *    `slots.entries('sidebar.settings')[0].store.create().actions.openSection(id)`.
 * 2. **Driving the chrome** — click the sidebar's settings trigger, wait for the
 *    panel, click this plugin's nav row by label.
 *
 * Route 1 is what the owner asked for ("clicking the button should open Settings
 * already on this plugin") and it is available on the shell this plugin targets;
 * route 2 stays as the fallback for a host whose shell predates the seat. Route 1
 * is strictly better where it exists: `openSection(id)` sets `activeId` AND
 * `open` in one action, so there is no retry window in which the dialog is open
 * on the wrong section, and no dependency on the nav row's localized label.
 *
 * ## Why the seat is legitimately public (verified, not assumed)
 *
 * Read from the shipped host (0.1.7-rc.1), not from a sibling README:
 *
 *     ctx.remoteAccess.whenAccess('settings/describe', () => ctx.slots.inject('sidebar.settings', () => {
 *       const shellHandle = createSettingsShellStore()
 *       const shellInstance = shellHandle.create()
 *       const shellStore = { ...shellHandle, create: () => shellInstance }
 *       …
 *       ctx.slots.register({ name: 'sidebar.settings', store: shellStore, … })
 *     }))
 *
 * and the store itself:
 *
 *     defineStore({
 *       init: () => ({ open: false, activeId: void 0 }),
 *       actions: {
 *         open:          (d) => { d.open = true },
 *         close:         (d) => { d.open = false; d.activeId = void 0 },
 *         select:        (d, id) => { d.activeId = id },
 *         openSection:   (d, id) => { d.activeId = id; d.open = true },
 *       },
 *     })
 *
 * Three things follow, and all three are load-bearing:
 *
 *  - `create: () => shellInstance` PINS the seat to the shell's one live
 *    instance. A bare handle would mint a fresh private copy per `create()`,
 *    and `openSection` on that copy would move a dialog nobody renders.
 *  - `store` is a declared registration field ("Declared store seat; instance
 *    resolution and lifecycle live with the host machinery"), and
 *    `slots.entries(key)` is a public service method — the harness's own client
 *    tests read this exact seat the same way.
 *  - **Only `openSection` answers this need.** The published contract gives a
 *    `settings.section` registrant just `close`; `settings.launcher` gets
 *    `openSettings` with no id; `openSection(id)` is otherwise handed only to
 *    `settings.onboarding` steps. Registering a fake first-run step to reach it
 *    would be far more intrusive than reading a seat the shell published.
 *
 * ## Why the probe happens per PRESS, not during `apply`
 *
 * The seat belongs to ANOTHER bundle whose apply order is not ours to assume.
 * Probing once during `apply` would capture `undefined` on a host whose sidebar
 * applied later, leaving the button dead for the whole session. `entries()`
 * answers `[]` for an undeclared slot, so a per-press probe is stateless and
 * always current — the same reason the popover button is built around `softGet`.
 *
 * ## Route 2, and why it is kept rather than deleted
 *
 * The host range this plugin declares spans shell lines that may predate the
 * seat. When the seat is absent, the old route still lands the user on this
 * plugin's page, so deleting it would trade a working fallback for nothing. It
 * is now the SECOND choice, which also means its known weakness (the nav row is
 * found by its localized label, so a language we did not ship cannot match) can
 * no longer affect a host that has the seat.
 *
 *   1. click the shell's settings trigger (`aria-haspopup="dialog"` +
 *      `aria-expanded`) — unless the panel is already open, in which case
 *      clicking it would CLOSE it and the jump would turn into a disappearing
 *      act;
 *   2. wait for the panel to mount (it renders on demand into `body`);
 *   3. find this plugin's nav row by its LABEL and click it.
 *
 * ## Why it never throws
 *
 * Every step runs from a RENDER path (a click handler in the credits popover). A
 * throw here would take out the whole readout rather than one button, so each
 * stage swallows its own failure and the whole jump degrades to a silent no-op
 * when the shell has a different shape.
 *
 * @module dsh-connect-workbuddy/client/settings-jump
 */

import { WORKBUDDY_SETTINGS_SECTION_ID } from '../status-paths.ts'

/**
 * The settings panel container.
 *
 * `data-shortcut-modal="settings"` is the shell's OWN attribute — its shortcut
 * router keys off it to decide whether the open modal is the settings one — so
 * it is far more stable than any class name, which is a CSS-module hash.
 */
const SETTINGS_PANEL_SELECTOR = '[data-shortcut-modal="settings"]'

/** The sidebar's settings trigger: dialog semantics plus an expanded state. */
const TRIGGER_SELECTOR = 'button[aria-haspopup="dialog"][aria-expanded]'

/** The shipped slot whose store seat is the settings shell's state handle. */
const SETTINGS_SLOT = 'sidebar.settings'

/**
 * Budget for "panel mounted + nav row rendered".
 *
 * The panel mounts SYNCHRONOUSLY on the click, but the nav rows' labels wait for
 * a locale snapshot, so a same-frame query is often one tick too early. Five
 * attempts over ~300ms covers one layout pass while staying under the threshold
 * where a user starts to think the click did nothing.
 */
const RETRY_DELAYS_MS = [0, 60, 70, 80, 90] as const

/** The slice of a live shell instance this module calls. */
interface SettingsShellInstanceLike {
  actions?: {
    /** Set `activeId` AND `open` — "open Settings on this section". */
    openSection?: (id: string) => void
    /** Open the dialog without choosing a section. */
    open?: () => void
  } | undefined
}

/** The slice of the declared store seat this module calls. */
interface SettingsShellSeatLike {
  create?: () => SettingsShellInstanceLike
}

/** The slice of a slot ledger entry this module reads. */
interface SlotLedgerEntryLike {
  store?: unknown
}

/** The slice of the `slots` service this module calls. */
interface SlotsServiceLike {
  entries?: (key: string) => readonly SlotLedgerEntryLike[]
}

export interface SettingsJumpOptions {
  /** Document; injected by tests. */
  doc?: Document
  /** This plugin's nav-row label in the current language, evaluated per click. */
  label: () => string
  /**
   * Soft service probe (`ctx.get`): absent services answer `undefined` instead
   * of throwing. Called on every invocation so a service that appears after
   * `apply` is still found.
   */
  get?: (name: string) => unknown
  /**
   * The `settings.section` id this plugin registered. Defaulted from one
   * constant so the page registration, the nav row and this call cannot drift —
   * an unknown id is NOT an error to the store, it silently opens the shell's
   * fallback (first) section.
   */
  sectionId?: string
  /**
   * Called when no route could even be attempted. The caller uses it for a
   * fallback landing spot, so "the shell is unrecognisable" does not become a
   * completely dead button.
   */
  onGiveUp?: () => void
  /** Scheduler; defaults to `window.setTimeout`. */
  schedule?: (run: () => void, ms: number) => void
}

function defaultSchedule(run: () => void, ms: number): void {
  try {
    window.setTimeout(run, ms)
  } catch {
    run()
  }
}

function buttonsIn(scope: ParentNode): HTMLButtonElement[] {
  // `Array.from` rather than spread: this tsconfig's `lib` has no
  // `DOM.Iterable`, so a NodeList is not iterable at the TYPE level even though
  // it is at runtime.
  return Array.from(scope.querySelectorAll<HTMLButtonElement>('button'))
}

/** Find the nav-row button whose label is this plugin's. */
function findSectionRow(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  const want = label.trim()
  if (want === '') return undefined
  return buttonsIn(scope).find(button => (button.textContent ?? '').trim() === want)
}

/**
 * Open Settings on this plugin's section through the shell's store seat.
 *
 * @returns `'opened'` when the dialog is on the right section (done), `'shell'`
 *   when the dialog was opened but not preselected (route 2 can still click the
 *   row), and `undefined` when the seat is absent or unusable.
 */
function openThroughStoreSeat(
  get: (name: string) => unknown,
  sectionId: string,
): 'opened' | 'shell' | undefined {
  let slots: SlotsServiceLike | undefined
  try {
    slots = get('slots') as SlotsServiceLike | undefined
  } catch {
    return undefined
  }
  if (slots === undefined || typeof slots.entries !== 'function') return undefined

  let seat: unknown
  try {
    // A plain ledger read, but it is another bundle's service: a composed
    // profile can replace `slots` with something that throws here.
    seat = slots.entries(SETTINGS_SLOT)[0]?.store
  } catch {
    return undefined
  }
  if (seat === null || typeof seat !== 'object') return undefined

  const handle = seat as SettingsShellSeatLike
  if (typeof handle.create !== 'function') return undefined

  try {
    const instance = handle.create()
    const openSection = instance?.actions?.openSection
    if (typeof openSection === 'function') {
      openSection(sectionId)
      return 'opened'
    }
    // A shell whose store predates `openSection`. Pressing it still opens the
    // dialog, so hand back `'shell'` and let route 2 click the nav row: the
    // user lands on the right page that way, and this is not a dead button.
    const open = instance?.actions?.open
    if (typeof open === 'function') {
      open()
      return 'shell'
    }
  } catch {
    // `create()` or a baked action threw. Nothing left to try here.
  }
  return undefined
}

/**
 * Open the settings panel and select this plugin's section.
 *
 * @returns whether any route was taken (`false` = no route could be attempted,
 *   so the shell is unrecognisable and `onGiveUp` already ran).
 */
export function openWorkBuddySettingsSection(options: SettingsJumpOptions): boolean {
  const { doc = document, label } = options
  const schedule = options.schedule ?? defaultSchedule
  const sectionId = options.sectionId ?? WORKBUDDY_SETTINGS_SECTION_ID

  // ---- Route 1: the shell's own store seat (exact, one call) ---------------
  if (options.get !== undefined) {
    let seatResult: 'opened' | 'shell' | undefined
    try {
      seatResult = openThroughStoreSeat(options.get, sectionId)
    } catch {
      // The probe itself must not be able to break the button.
      seatResult = undefined
    }
    if (seatResult === 'opened') return true
    // `'shell'`: the dialog is open but on another section — fall through so
    // route 2 can click this plugin's row (the panel is now open, which is the
    // state route 2 detects and will not re-click the trigger for).
  }

  // ---- Route 2: drive the chrome ------------------------------------------
  try {
    // The panel may already be open (the user was just looking at another
    // section, or route 1 just opened it). Clicking the trigger then would
    // CLOSE it, so only drive the trigger when the panel is genuinely absent.
    const existing = doc.querySelector(SETTINGS_PANEL_SELECTOR)
    if (existing === null) {
      const triggers = Array.from(doc.querySelectorAll<HTMLButtonElement>(TRIGGER_SELECTOR))
      const collapsed = triggers.find(button => button.getAttribute('aria-expanded') !== 'true')
      // No trigger at all = this host has no settings panel (or the sidebar is
      // collapsed). Do not guess: take the fallback rather than leaving a button
      // that does nothing when pressed.
      if (collapsed === undefined) {
        try { options.onGiveUp?.() } catch { /* the fallback failing is still a no-op */ }
        return false
      }
      collapsed.click()
    }

    let clicked = false
    let remaining = RETRY_DELAYS_MS.length
    for (const delay of RETRY_DELAYS_MS) {
      schedule(() => {
        if (clicked) return
        remaining -= 1
        try {
          const scope = doc.querySelector(SETTINGS_PANEL_SELECTOR) ?? doc
          const row = findSectionRow(scope, label())
          if (row !== undefined) {
            clicked = true
            row.click()
            return
          }
        } catch { /* shell shaped differently: this attempt is done, next one runs */ }
        // Out of retries and still no row: hand over to the caller's fallback.
        // Deliberately AFTER the last attempt rather than on the first miss — a
        // panel that has mounted while its rows are still rendering is normal.
        if (remaining === 0) {
          try { options.onGiveUp?.() } catch { /* the fallback failing is still a no-op */ }
        }
      }, delay)
    }
    return true
  } catch {
    return false
  }
}
