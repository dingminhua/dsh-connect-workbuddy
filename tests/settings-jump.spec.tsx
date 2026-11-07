// @vitest-environment jsdom
/**
 * The jump to 设置 → WorkBuddy.
 *
 * TWO ROUTES. The first is exact: the settings shell publishes its state handle
 * as the `store` seat on `sidebar.settings`, and `create().actions.openSection(id)`
 * sets `activeId` and `open` in one call. The second is the older one — driving
 * the real chrome — and is kept for a shell line that predates the seat.
 *
 * Both halves are pinned here. For route 1: the exact section id, the fact that
 * the seat is probed per PRESS (a bundle that applies after ours must still be
 * found), and that a seat which offers only `open()` still lands on this
 * plugin's page rather than merely somewhere in Settings. For route 2: that it
 * must not close an already-open panel, it must survive a shell whose rows are
 * not rendered yet, and it must never throw.
 */
import { beforeEach, describe, expect, it } from 'vitest'
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

// ---------------------------------------------------------------------------
// Route 1: the settings shell's store seat.
// ---------------------------------------------------------------------------

/** A `ctx.get` whose `slots.entries('sidebar.settings')` yields `store`. */
function getWithSeat(store: unknown): (name: string) => unknown {
  return (name: string) =>
    name === 'slots'
      ? { entries: (key: string) => (key === 'sidebar.settings' ? [{ store }] : []) }
      : undefined
}

describe('openWorkBuddySettingsSection — the store seat', () => {
  // Same convention as the cases above: a case that asserts "there is no
  // chrome" must start from an empty document, or a previous case's trigger
  // answers for it and the assertion means nothing.
  beforeEach(() => { document.body.innerHTML = '' })

  it('opens the dialog on THIS section, in one call, without touching the chrome', () => {
    // The whole point of the route: `openSection(id)` both selects the section
    // and opens the dialog, so there is no window in which the user sees the
    // wrong section. The id must be the registered one — an unknown id is not
    // an error to the store, it silently opens the shell's FIRST section.
    const opened: string[] = []
    const store = { create: () => ({ actions: { openSection: (id: string) => opened.push(id) } }) }
    let triggerClicks = 0
    const triggerButton = trigger()
    triggerButton.addEventListener('click', () => { triggerClicks += 1 })
    document.body.append(triggerButton)

    try {
      const taken = openWorkBuddySettingsSection({
        label: () => 'WorkBuddy',
        get: getWithSeat(store),
        schedule: flush,
      })
      expect(taken).toBe(true)
      expect(opened).toEqual(['dsh-connect-workbuddy'])
      // No fallback clicking: the seat answered, so the chrome was left alone.
      expect(triggerClicks, 'the trigger was clicked even though the seat worked').toBe(0)
    } finally {
      triggerButton.remove()
    }
  })

  it('probes the seat on every press, so a late-applying bundle is still found', () => {
    // The seat belongs to another bundle whose apply order is not ours. A probe
    // cached at `apply` time would be `undefined` here and the button would be
    // dead for the whole session.
    let seats: unknown[] = []
    const get = (name: string): unknown =>
      name === 'slots'
        ? { entries: (key: string) => (key === 'sidebar.settings' ? seats.map(store => ({ store })) : []) }
        : undefined

    // First press: the sidebar has not applied yet.
    const first = openWorkBuddySettingsSection({
      label: () => 'WorkBuddy', get, onGiveUp: () => {}, schedule: flush,
    })
    expect(first, 'reported a route on a host with no seat and no chrome').toBe(false)

    // Later the bundle applies; the SAME options now find it.
    const opened: string[] = []
    seats = [{ create: () => ({ actions: { openSection: (id: string) => opened.push(id) } }) }]
    const second = openWorkBuddySettingsSection({
      label: () => 'WorkBuddy', get, onGiveUp: () => {}, schedule: flush,
    })
    expect(second).toBe(true)
    expect(opened).toEqual(['dsh-connect-workbuddy'])
  })

  it('uses its own id when the caller does not pass one, and honours an override', () => {
    const opened: string[] = []
    const store = { create: () => ({ actions: { openSection: (id: string) => opened.push(id) } }) }
    openWorkBuddySettingsSection({ label: () => 'X', get: getWithSeat(store), schedule: flush })
    openWorkBuddySettingsSection({
      label: () => 'X', get: getWithSeat(store), sectionId: 'other-id', schedule: flush,
    })
    expect(opened).toEqual(['dsh-connect-workbuddy', 'other-id'])
  })

  it('still lands on this section when the seat predates openSection', () => {
    // A shell whose store has `open()` but no `openSection()`. Pressing it must
    // NOT stop at "the dialog is open somewhere": it falls through to route 2
    // and clicks this plugin's row.
    let openedDialog = 0
    const store = { create: () => ({ actions: { open: () => { openedDialog += 1 } } }) }
    let rowClicks = 0
    const row = document.createElement('button')
    row.textContent = 'WorkBuddy'
    row.addEventListener('click', () => { rowClicks += 1 })
    const panel = panelWith([])
    panel.append(row)
    document.body.append(panel)

    try {
      const taken = openWorkBuddySettingsSection({
        label: () => 'WorkBuddy', get: getWithSeat(store), schedule: flush,
      })
      expect(taken).toBe(true)
      expect(openedDialog, 'open() was not called').toBe(1)
      expect(rowClicks, 'the nav row was not clicked after open()').toBe(1)
    } finally {
      panel.remove()
    }
  })

  it('falls back to the chrome when the seat is missing, unusable or throwing', () => {
    const cases: Array<[string, (name: string) => unknown]> = [
      ['no slots service', () => undefined],
      ['slots without entries', () => ({ slots: {} }) as unknown as undefined],
      ['empty ledger', getWithSeat(undefined)],
      ['seat without create', getWithSeat({})],
      ['create() throws', getWithSeat({ create: () => { throw new Error('nope') } })],
      ['create() returns junk', getWithSeat({ create: () => null })],
      ['get throws', () => { throw new Error('nope') }],
    ]
    for (const [why, get] of cases) {
      // Each case must reach route 2, which (with a panel already open and a
      // matching row) clicks the row. That is how we observe "fell through".
      let rowClicks = 0
      const row = document.createElement('button')
      row.textContent = 'WorkBuddy'
      row.addEventListener('click', () => { rowClicks += 1 })
      const panel = panelWith([])
      panel.append(row)
      document.body.append(panel)
      try {
        const taken = openWorkBuddySettingsSection({ label: () => 'WorkBuddy', get, schedule: flush })
        expect(taken, why).toBe(true)
        expect(rowClicks, `${why}: route 2 did not run`).toBe(1)
      } finally {
        panel.remove()
      }
    }
  })
})
