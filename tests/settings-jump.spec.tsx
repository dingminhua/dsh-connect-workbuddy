// @vitest-environment jsdom
/**
 * The best-effort jump to 设置 → WorkBuddy.
 *
 * The host exposes NO public way for a third-party plugin to select one of its
 * `settings.section`s: the shell keeps `activeId` in its own store and hands
 * `openSection(id)` only to `settings.onboarding` registrants. So the jump
 * drives the real chrome. These cases pin the three things that make it safe to
 * call from a click handler: it must not close an already-open panel, it must
 * survive a shell whose rows are not rendered yet, and it must never throw.
 */
import { describe, expect, it } from 'vitest'
import { openWorkBuddySettingsSection } from '../src/client/settings-jump.ts'

/** A settings panel with the given nav-row labels. */
function panelWith(labels: string[]): HTMLElement {
  const panel = document.createElement('div')
  panel.setAttribute('data-shortcut-modal', 'settings')
  for (const label of labels) {
    const button = document.createElement('button')
    button.textContent = label
    panel.append(button)
  }
  return panel
}

/** The sidebar trigger the shell renders. */
function trigger(expanded = 'false'): HTMLButtonElement {
  const button = document.createElement('button')
  button.setAttribute('aria-haspopup', 'dialog')
  button.setAttribute('aria-expanded', expanded)
  return button
}

/** Run every scheduled callback immediately. */
const flush = (run: () => void): void => { run() }

describe('openWorkBuddySettingsSection', () => {
  it('clicks this plugin\'s row when the panel is already open', () => {
    document.body.innerHTML = ''
    let jumped = 0
    const panel = panelWith(['通用', 'WorkBuddy', '插件'])
    document.body.append(panel)
    panel.children[1]?.addEventListener('click', () => { jumped += 1 })

    // No trigger anywhere: an already-open panel must not be toggled shut.
    const result = openWorkBuddySettingsSection({
      label: () => 'WorkBuddy',
      schedule: flush,
    })
    expect(result, 'the panel was there but the jump reported nothing to drive').toBe(true)
    expect(jumped, 'the row was never clicked').toBe(1)
  })

  it('drives the trigger first when no panel is mounted', () => {
    document.body.innerHTML = ''
    let opened = 0
    const button = trigger()
    button.addEventListener('click', () => {
      opened += 1
      document.body.append(panelWith(['通用', 'WorkBuddy']))
    })
    document.body.append(button)

    let jumped = 0
    const result = openWorkBuddySettingsSection({
      label: () => 'WorkBuddy',
      schedule: (run) => {
        run()
        // The row exists only after the trigger's handler ran.
        document.body.querySelector('.x')
      },
      doc: document,
    })
    expect(result).toBe(true)
    expect(opened, 'the trigger was never driven').toBe(1)
    expect(button.getAttribute('aria-expanded'), 'the trigger must be the collapsed one').toBe('false')
    expect(jumped).toBe(0)
  })

  it('takes the fallback when this host has no settings trigger', () => {
    document.body.innerHTML = ''
    let gaveUp = 0
    // No trigger AND no panel: a trimmed profile, or the sidebar collapsed.
    const result = openWorkBuddySettingsSection({
      label: () => 'WorkBuddy',
      schedule: flush,
      onGiveUp: () => { gaveUp += 1 },
    })
    expect(result, 'it should report that nothing could be driven').toBe(false)
    expect(gaveUp, 'it must hand over to the fallback rather than stay silent').toBe(1)
  })

  it('falls back only after every retry, not on the first miss', () => {
    document.body.innerHTML = ''
    let gaveUp = 0
    document.body.append(trigger())
    document.body.append(panelWith(['通用'])) // no WorkBuddy row yet

    const pending: Array<() => void> = []
    openWorkBuddySettingsSection({
      label: () => 'WorkBuddy',
      schedule: (run) => { pending.push(run) },
      onGiveUp: () => { gaveUp += 1 },
    })
    // A panel that has mounted while its rows are still rendering is NORMAL,
    // so the first attempts must not give up.
    expect(pending.length, 'nothing was scheduled').toBeGreaterThan(1)
    pending.shift()?.()
    expect(gaveUp, 'it gave up before the retries were spent').toBe(0)
    // Drain the rest: only the last one may hand over.
    while (pending.length > 0) pending.shift()?.()
    expect(gaveUp, 'it never handed over after the retries ran out').toBe(1)
  })

  it('never throws, whatever the shell looks like', () => {
    document.body.innerHTML = ''
    // `label` itself blowing up is the worst case: a throw here would take out
    // the credits readout, not just one button.
    expect(() => openWorkBuddySettingsSection({
      label: () => { throw new Error('locale gone') },
      schedule: flush,
    })).not.toThrow()
  })

  it('ignores a blank label instead of clicking the first row it finds', () => {
    document.body.innerHTML = ''
    let clicked = 0
    const panel = panelWith(['通用'])
    document.body.append(panel)
    panel.children[0]?.addEventListener('click', () => { clicked += 1 })

    openWorkBuddySettingsSection({ label: () => '  ', schedule: flush })
    expect(clicked, 'a blank label matched a row it does not own').toBe(0)
  })
})
