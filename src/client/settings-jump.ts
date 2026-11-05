/**
 * Best-effort jump to this plugin's **Settings section** (设置 → WorkBuddy).
 *
 * ## Why a DOM walk rather than a service call
 *
 * The host gives a third-party plugin NO public way to open one of its
 * `settings.section`s. The shell keeps the selected section in its own store
 * (`ui-settings-general`'s `createSettingsShellStore().activeId`), and the only
 * `openSection(id)` it hands out goes to `settings.onboarding` registrants —
 * that is the first-run guidance seat, not a configuration entry. Nothing else
 * in `@deepseek-ai/dsh-client-ui-settings`' client contract exposes a
 * `openSection` / `selectedSection` service.
 *
 * This is not a WorkBuddy-specific finding: `dsh-connect-qoder`, `dsh-context`
 * and `dsh-better-sidebar` all document the same gap and all drive the real
 * chrome instead.
 *
 * ## What "driving the chrome" means here
 *
 *   1. click the shell's settings trigger (`aria-haspopup="dialog"` +
 *      `aria-expanded`) — unless the panel is already open, in which case
 *      clicking it would CLOSE it and the jump would turn into a disappearing
 *      act;
 *   2. wait for the panel to mount (it renders on demand into `body`);
 *   3. find this plugin's nav row by its LABEL and click it.
 *
 * ## Why the label and not the id
 *
 * The shell renders each nav row's `row.label` — an already-localized string —
 * and writes no `data-section-id` or similar stable anchor; `aria-current` only
 * appears on the row that is already selected. The label comes from this
 * plugin's own `section.label` (`t('nav.panel')`), so both languages live in
 * this repository and "the one we found" cannot drift from "the one we
 * registered".
 *
 * ## Why it never throws
 *
 * Every step is called from a RENDER path (a click handler in the credits
 * popover). A throw here would take out the whole readout rather than one
 * button, so each stage swallows its own failure and the whole jump degrades to
 * a silent no-op when the shell has a different shape (an older host, a hidden
 * sidebar, a language we did not ship).
 *
 * @module dsh-connect-workbuddy/client/settings-jump
 */

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

/**
 * Budget for "panel mounted + nav row rendered".
 *
 * The panel mounts SYNCHRONOUSLY on the click, but the nav rows' labels wait for
 * a locale snapshot, so a same-frame query is often one tick too early. Five
 * attempts over ~300ms covers one layout pass while staying under the threshold
 * where a user starts to think the click did nothing.
 */
const RETRY_DELAYS_MS = [0, 60, 70, 80, 90] as const

export interface SettingsJumpOptions {
  /** Document; injected by tests. */
  doc?: Document
  /** This plugin's nav-row label in the current language, evaluated per click. */
  label: () => string
  /**
   * Called when every retry ran out without finding the row. The caller uses it
   * for a fallback landing spot, so "the label did not match" does not become a
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
 * Open the settings panel and select this plugin's section.
 *
 * @returns whether the trigger was driven at all (`false` = the panel is not on
 *   this host, so nothing was attempted and `onGiveUp` already ran).
 */
export function openWorkBuddySettingsSection(options: SettingsJumpOptions): boolean {
  const { doc = document, label } = options
  const schedule = options.schedule ?? defaultSchedule
  try {
    // The panel may already be open (the user was just looking at another
    // section). Clicking the trigger then would CLOSE it, so only drive the
    // trigger when the panel is genuinely absent.
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
