// @vitest-environment jsdom
/**
 * The composer credit readout, rendered.
 *
 * The gate tests (`composer-credits-gate.spec.ts`) lock WHICH session shows a
 * readout. This file locks what the user sees and touches: that the trigger
 * names the right region and carries that region's number, that the panel is a
 * per-account TABLE whose row click switches accounts, and that a failed
 * balance renders "—" rather than a confident "0".
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerCredits } from '../src/client/ComposerCredits.tsx'
import { WORKBUDDY_COMPOSER_CSS } from '../src/client/styles.ts'
import { mount, stubFetch, t } from './pool-render-helpers.tsx'
import type { Mounted } from './pool-render-helpers.tsx'
import { zh } from '../src/client/locales.ts'
import { AccountPool } from '../src/client/AccountPool.tsx'

afterEach(() => { vi.unstubAllGlobals() })

/** A signed-in usage body for one region. */
function usageOf(region: string, total: number): Record<string, unknown> {
  return {
    status: 'signed-in',
    region,
    accountId: 'a-1',
    accountName: 'A One',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [
      { id: 'a-1', accountName: 'A One', selected: true },
      { id: 'a-2', accountName: 'A Two', selected: false },
    ],
    models: [],
    enabledModelIds: [],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total, expiringSoon: 0, packages: [] },
  }
}

/** A settings scope stub. */
function scopeOf(value: unknown, writable = true): any {
  return {
    getSnapshot: () => ({ status: 'ready', value, writable }),
    subscribe: () => () => {},
    set: async () => true,
  }
}

const render = async (props: Record<string, unknown>) => {
  const m = await mount(ComposerCredits as any, { t, ...props })
  await m.settle()
  return m
}

/**
 * Buttons of the open PANEL.
 *
 * The panel is portaled to `document.body` (it must be, to escape the
 * composer's overflow), so it is NOT inside the mount container — querying the
 * container would find only the trigger and every panel assertion would fail
 * for the wrong reason.
 */
const panelButtons = (): HTMLButtonElement[] =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('.dsm-workbuddy-composer-panel button'))

/** Text of the whole panel, for content assertions. */
const panelText = (): string =>
  document.body.querySelector('.dsm-workbuddy-composer-panel')?.textContent ?? ''

afterEach(() => {
  // The portal outlives the component unless the body is cleaned between cases.
  document.body.querySelectorAll('.dsm-workbuddy-composer-panel').forEach(node => { node.remove() })
})

describe('ComposerCredits trigger', () => {
  it('names the CN region and shows the CN balance', async () => {
    const calls = stubFetch(() => ({ body: usageOf('cn', 1072) }))
    const m = await render({ provider: 'workbuddy' })
    expect(m.text()).toContain('composer.pointsCn')
    expect(m.text()).toContain('1,072')
    expect(calls[0]?.url).toContain('region=cn')
  })

  it('names the international region and shows its balance', async () => {
    const calls = stubFetch(() => ({ body: usageOf('global', 88) }))
    const m = await render({ provider: 'workbuddy-global' })
    expect(m.text()).toContain('composer.pointsGlobal')
    expect(m.text()).toContain('88')
    expect(calls[0]?.url).toContain('region=global')
  })

  it('does not label the international readout as CN', async () => {
    // Pins the mapping itself: the two labels must not be swapped.
    stubFetch(() => ({ body: usageOf('global', 88) }))
    const m = await render({ provider: 'workbuddy-global' })
    expect(m.text()).not.toContain('composer.pointsCn')
  })

  it('renders NOTHING for another provider', async () => {
    // The shared composer row must stay untouched when a foreign model is
    // selected — not merely blank, but absent, with no fetch.
    const calls = stubFetch(() => ({ body: usageOf('cn', 5) }))
    const m = await render({ provider: 'trae' })
    expect(m.text().trim()).toBe('')
    expect(calls).toHaveLength(0)
  })

  it('carries no refresh control on the row itself', async () => {
    // The manual refresh lives in the panel: the composer row is shared with
    // the shell's own controls, so it holds only the clickable readout.
    stubFetch(() => ({ body: usageOf('cn', 5) }))
    const m = await render({ provider: 'workbuddy' })
    expect(m.buttons()).toHaveLength(1)
    expect(m.buttons()[0]?.textContent).toContain('composer.pointsCn')
  })

  it('hides the readout when the HOST reports the switch off (issue #46)', async () => {
    // The reported symptom: unticking "显示 WBCN 积分" wrote `false` correctly
    // and the readout stayed. The Host carries the authoritative flag on the
    // usage document, so the component must obey it even when the settings
    // scope it was handed is dead (bound to a namespace nothing serves).
    stubFetch(() => ({ body: { ...usageOf('cn', 1072), showCreditsInMainUi: false } }))
    const m = await render({
      provider: 'workbuddy',
      // Bound to a namespace the Host does not serve: every read is undefined,
      // which the opt-out rule would otherwise read as "shown".
      settingsScope: scopeOf(undefined),
    })
    await m.settle()
    expect(m.text()).not.toContain('1,072')
    expect(m.text().trim()).toBe('')
  })

  it('still renders when the Host reports the switch on', async () => {
    // The mirror says hidden (stale), the Host says shown: the Host wins, so a
    // user who re-enables the box sees the number without a reload.
    stubFetch(() => ({ body: { ...usageOf('cn', 1072), showCreditsInMainUi: true } }))
    const m = await render({
      provider: 'workbuddy',
      settingsScope: scopeOf({ regions: { cn: { showCreditsInMainUi: false } } }),
    })
    await m.settle()
    expect(m.text()).toContain('1,072')
  })

  it('treats a Host document without the field as "did not say"', async () => {
    // Documents written before the field existed must keep the scope's answer.
    stubFetch(() => ({ body: usageOf('cn', 1072) }))
    const m = await render({ provider: 'workbuddy', settingsScope: scopeOf({ regions: {} }) })
    await m.settle()
    expect(m.text()).toContain('1,072')
  })
})

describe('ComposerCredits panel', () => {
  it('opens a per-account table on click, fetching balances on demand', async () => {
    const calls = stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [
            { id: 'a-1', accountName: 'A One', selected: true, credits: 1072 },
            { id: 'a-2', accountName: 'A Two', selected: false, credits: 300 },
          ] }
        : usageOf('cn', 1072),
    }))
    const m = await render({ provider: 'workbuddy', settingsScope: scopeOf({ accounts: {} }) })
    expect(calls.some(call => call.url.includes('account-credits'))).toBe(false)
    await m.click(m.buttons()[0] as Element)
    await m.settle()

    // The table lists every account with its own figure.
    expect(panelText()).toContain('A One')
    expect(panelText()).toContain('A Two')
    expect(panelText()).toContain('300')
    expect(calls.some(call => call.url.includes('account-credits'))).toBe(true)
  })

  it('shows "—" rather than 0 for an account whose balance could not be read', async () => {
    // The endpoint omits `credits` in that case precisely so this component
    // cannot claim the account is out of credits.
    stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [
            { id: 'a-1', accountName: 'A One', selected: true, credits: 1072 },
            { id: 'a-2', accountName: 'A Two', selected: false },
          ] }
        : usageOf('cn', 1072),
    }))
    const m = await render({ provider: 'workbuddy', settingsScope: scopeOf({ accounts: {} }) })
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    expect(panelText()).toContain('A Two')
    expect(panelText()).toContain('—')
  })

  it('switches account through the shared, landed-checked writer', async () => {
    const posted: any[] = []
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      const target = String(url)
      const answer = (payload: unknown): Response => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => payload,
        text: async () => JSON.stringify(payload),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)))
            controller.close()
          },
        }),
      }) as unknown as Response
      if (target.includes('__save')) {
        posted.push(JSON.parse(String(init?.body)))
        return answer({ ok: true, value: { accounts: { cn: 'a-2' } } })
      }
      if (target.includes('account-credits')) {
        return answer({ accounts: [
          { id: 'a-1', accountName: 'A One', selected: true, credits: 1072 },
          { id: 'a-2', accountName: 'A Two', selected: false, credits: 300 },
        ] })
      }
      return answer(usageOf('cn', 1072))
    })
    const scope = scopeOf({ accounts: {} })
    const m = await render({ provider: 'workbuddy', settingsScope: scope })
    await m.click(m.buttons()[0] as Element)
    await m.settle()

    // Click the row for the account that is NOT selected.
    const rowButton = panelButtons().find(button => button.textContent?.includes('A Two'))
    expect(rowButton, 'switch button for A Two').toBeDefined()
    await m.click(rowButton as Element)
    await m.settle()

    const save = posted.find(body => body.field === 'accounts')
    expect(save, 'account write').toBeDefined()
    // The save endpoint takes `{ field, value: { [region]: slot } }`.
    expect(save.value.cn).toBe('a-2')
  })

  it('marks a rate-limited account in the table', async () => {
    // The account the user might switch TO must be labelled before they pick
    // it: a table that presents an exhausted account as an equally good choice
    // is worse than no table.
    stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [
            { id: 'a-1', accountName: 'A One', selected: true, credits: 1072 },
            { id: 'a-2', accountName: 'A Two', selected: false, credits: 300, excludedBy: 'rate-limited' },
          ] }
        : usageOf('cn', 1072),
    }))
    const m = await render({ provider: 'workbuddy', settingsScope: scopeOf({ accounts: {} }) })
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    // The label the POOL table uses for the same fact.
    expect(panelText()).toContain('row.poolExcludedRateLimited')
    // Two second lines, and each says exactly one thing: the selected account
    // names itself, the limited one says why. The COUNT is the guard against a
    // line appearing on a row that has nothing to report.
    const marks = Array.from(document.body.querySelectorAll('.dsm-workbuddy-composer-panel-mark'))
      .map(node => node.textContent ?? '')
    expect(marks).toContain('composer.current')
    expect(marks.some(line => line.includes('row.poolExcludedRateLimited')), 'the reason is printed').toBe(true)
    expect(marks).toHaveLength(2)
  })

  it('marks nothing for an account with no known problem', async () => {
    stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [
            { id: 'a-1', accountName: 'A One', selected: true, credits: 1072 },
            { id: 'a-2', accountName: 'A Two', selected: false, credits: 300 },
          ] }
        : usageOf('cn', 1072),
    }))
    const m = await render({ provider: 'workbuddy', settingsScope: scopeOf({ accounts: {} }) })
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    // The selected row still names itself -- that is not a problem report. What
    // must stay empty is every other row, and the list has exactly that one line.
    const marks = Array.from(document.body.querySelectorAll('.dsm-workbuddy-composer-panel-mark'))
      .map(node => node.textContent ?? '')
    expect(marks).toEqual(['composer.current'])
  })

  it('renders the rows inert without a writable scope', async () => {
    // A panel that cannot switch anything must not pretend to.
    stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [
            { id: 'a-1', accountName: 'A One', selected: true, credits: 1072 },
            { id: 'a-2', accountName: 'A Two', selected: false, credits: 300 },
          ] }
        : usageOf('cn', 1072),
    }))
    const m = await render({ provider: 'workbuddy' })
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    const switchButtons = panelButtons().filter(button => button.className.includes('panel-switch'))
    expect(switchButtons.length).toBeGreaterThan(0)
    expect(switchButtons.every(button => button.disabled)).toBe(true)
  })
})

describe('composer CSS contract (the classes the component renders must exist)', () => {
  it('defines a rule for EVERY class the readout renders', () => {
    // The bug this pins: the component was renamed Points → Credits and the two
    // TRIGGER rules were left behind as `.dsm-workbuddy-composer-points-*`, so
    // the trigger matched no rule and rendered as the browser's default button
    // box — a bordered, larger chip instead of plain composer text. Every other
    // class happened to keep its name, so only these two were wrong and nothing
    // else noticed.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'ComposerCredits.tsx'),
      'utf8',
    )
    const rendered = new Set(
      [...source.matchAll(/dsm-workbuddy-composer-[a-z-]+/g)].map(match => match[0]),
    )
    const defined = new Set(
      [...WORKBUDDY_COMPOSER_CSS.matchAll(/\.(dsm-workbuddy-composer-[a-z-]+)/g)].map(match => match[1] as string),
    )
    expect(rendered.size).toBeGreaterThan(5)
    const missing = [...rendered].filter(name => !defined.has(name))
    expect(missing).toEqual([])
  })

  it('styles the trigger as plain text, not a default button', () => {
    // The visible half of the same contract: no border, no fill, transparent
    // background — the readout must not read as a chunky button in the composer
    // row it shares with the shell's own controls.
    const rule = /\.dsm-workbuddy-composer-credits-trigger\{([^}]*)\}/.exec(WORKBUDDY_COMPOSER_CSS)?.[1] ?? ''
    expect(rule).toContain('border:0')
    expect(rule).toContain('background:transparent')
    expect(rule).toContain('font-size:12px')
  })
})

/**
 * The panel must agree with the pool card about ORDER.
 *
 * The reported symptom: accounts were sorted manually in the pool card, but the
 * credit panel listed them in a different sequence — the same pool rendered two
 * different ways. It made the ordering feature look like it had not saved.
 */
describe('ComposerCredits panel follows the manual priority order', () => {
  /** Names of the panel's rows, in the order they are displayed. */
  const panelRowNames = (): string[] =>
    Array.from(document.body.querySelectorAll('.dsm-workbuddy-composer-panel-who'))
      .map(node => node.querySelector('.dsm-workbuddy-composer-panel-name')?.textContent ?? '')

  const threeAccounts = () => ({
    accounts: [
      { id: 'a-1', accountName: 'A One', selected: true, credits: 1072 },
      { id: 'a-2', accountName: 'A Two', selected: false, credits: 300 },
      { id: 'a-3', accountName: 'A Three', selected: false, credits: 55 },
    ],
  })

  const orderScope = (order: readonly string[]) =>
    scopeOf({ regions: { cn: { pool: { orderAccountIds: order } } } })

  it('lists accounts in the saved manual order, not the Host order', async () => {
    stubFetch((url) => ({ body: url.includes('account-credits') ? threeAccounts() : usageOf('cn', 1072) }))
    const m = await render({ provider: 'workbuddy', settingsScope: orderScope(['a-3', 'a-1', 'a-2']) })
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    // This is the assertion that fails on the reported bug: the Host returns
    // a-1, a-2, a-3 and the panel used to render exactly that.
    expect(panelRowNames()).toEqual(['A Three', 'A One', 'A Two'])
  })

  it('keeps an unsorted pool in the Host order', async () => {
    // No manual order must not be mistaken for "sort by something else".
    stubFetch((url) => ({ body: url.includes('account-credits') ? threeAccounts() : usageOf('cn', 1072) }))
    const m = await render({ provider: 'workbuddy', settingsScope: orderScope([]) })
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    expect(panelRowNames()).toEqual(['A One', 'A Two', 'A Three'])
  })

  it('reads the order from the SAME region the panel is showing', async () => {
    // The two pools are independent: an order set for the domestic pool must
    // not reorder the international panel, which would look like the arrows
    // were moving the wrong list.
    stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [
            { id: 'g-1', accountName: 'G One', selected: true, credits: 10 },
            { id: 'g-2', accountName: 'G Two', selected: false, credits: 20 },
          ] }
        : usageOf('global', 88),
    }))
    const m = await render({
      provider: 'workbuddy-global',
      settingsScope: scopeOf({
        regions: {
          cn: { pool: { orderAccountIds: ['g-2', 'g-1'] } },
          global: { pool: { orderAccountIds: [] } },
        },
      }),
    })
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    expect(panelRowNames()).toEqual(['G One', 'G Two'])
  })

  it('still renders every account when the order is stale', async () => {
    // A saved order can name an account that has since been removed. Dropping
    // it must not hide the ones that remain.
    stubFetch((url) => ({ body: url.includes('account-credits') ? threeAccounts() : usageOf('cn', 1072) }))
    const m = await render({ provider: 'workbuddy', settingsScope: orderScope(['gone', 'a-2']) })
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    expect(panelRowNames()).toEqual(['A Two', 'A One', 'A Three'])
  })
})

/**
 * The panel and the pool card must agree about AVAILABILITY, not just order.
 *
 * The reported symptom: the card said "被限流 · 10/19 01:32 之后可再用" with an
 * amber dot, while the panel beside it said a bare "被限流" with a grey dot and
 * no time. One measurement, two stories — which is worse than either story
 * alone, because the user concludes the plugin is confused about its own data.
 */
/** A settings scope carrying a saved manual order. */
const orderScope = (order: readonly string[]): any =>
  scopeOf({ regions: { cn: { pool: { orderAccountIds: order } } } })

describe('ComposerCredits panel agrees with the pool card about availability', () => {
  /** A pool document the panel can read availability from. */
  const poolUsage = (): Record<string, unknown> => ({
    ...usageOf('cn', 1072),
    pool: {
      enabled: true,
      targetModelId: '',
      checkinSupported: true,
      modelId: 'deepseek-v4.1-flash',
      accounts: [
        {
          accountId: 'a-1',
          accountName: 'A One',
          credits: 1072,
          current: true,
          member: true,
          probe: { outcome: 'ok', atMs: Date.now() - 60_000 },
        },
        {
          accountId: 'a-2',
          accountName: 'A Two',
          credits: 300,
          current: false,
          member: true,
          // A rate limit WITH a stated reset. The instant is fixed so the two
          // surfaces' formatting can be compared character for character.
          probe: { outcome: 'rate-limited', atMs: Date.now() - 60_000, retryAtMs: 1_800_000_000_000 },
          excludedBy: 'rate-limited',
        },
        {
          accountId: 'a-3',
          accountName: 'A Three',
          credits: 55,
          current: false,
          member: true,
        },
      ],
    },
  })

  const openPanel = async (usage: () => Record<string, unknown>) => {
    stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [
            { id: 'a-1', accountName: 'A One', selected: true, credits: 1072 },
            { id: 'a-2', accountName: 'A Two', selected: false, credits: 300 },
            { id: 'a-3', accountName: 'A Three', selected: false, credits: 55 },
          ] }
        : usage(),
    }))
    const m = await render({ provider: 'workbuddy' })
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    return m
  }

  /** The mark under one panel row's name, by account name. */
  const markOf = (name: string): string | undefined =>
    Array.from(document.body.querySelectorAll('.dsm-workbuddy-composer-panel-who'))
      .find(node => node.querySelector('.dsm-workbuddy-composer-panel-name')?.textContent === name)
      ?.querySelector('.dsm-workbuddy-composer-panel-mark')?.textContent ?? undefined

  /** The row's hover text, which is where the absolute instant now lives. */
  const rowTitleOf = (name: string): string | undefined =>
    Array.from(document.body.querySelectorAll('tr[title]'))
      .find(node => node.querySelector('.dsm-workbuddy-composer-panel-name')?.textContent === name)
      ?.getAttribute('title') ?? undefined

  /** The row header's accessible name — the same sentence, for screen readers. */
  const rowLabelOf = (name: string): string | undefined =>
    Array.from(document.body.querySelectorAll('th[aria-label]'))
      .find(node => node.querySelector('.dsm-workbuddy-composer-panel-name')?.textContent === name)
      ?.getAttribute('aria-label') ?? undefined

  /** The dot under one panel row's name, by account name. */
  const dotOf = (name: string): Element | undefined =>
    Array.from(document.body.querySelectorAll('.dsm-workbuddy-composer-panel-switch'))
      .find(button => button.querySelector('.dsm-workbuddy-composer-panel-name')?.textContent === name)
      ?.querySelector('.dsm-workbuddy-composer-panel-dot') ?? undefined

  it('prints the reason and the wait, but not the absolute instant', async () => {
    // The owner's request, on this panel only: "被限流 · 约 6 小时后恢复" stays,
    // the "10/19, 01:32 之后可再用" in the middle goes. The wait answers the
    // question a limited row raises ("how long until it comes back?"); the date
    // is the part nobody acts on, and in this column it read like a log line
    // wrapped in a sentence.
    const m = await openPanel(poolUsage)
    const mark = markOf('A Two')
    expect(mark).toBeDefined()
    expect(mark).toContain('row.poolExcludedRateLimited')
    expect(mark, 'the reset instant must no longer be printed here').not.toContain('row.poolRetryAt')
    const WAIT = /row\.recovers(Imminent|Minutes|Hours|Days)(\|count=\d+)?/
    expect(WAIT.test(mark ?? ''), 'the wait must survive').toBe(true)
    await m.unmount()
  })

  it('keeps the absolute instant one hover away, in the card\'s own words', async () => {
    // Dropping the instant from the visible line is not dropping the fact. The
    // row keeps the full `availabilityLine` sentence as its title — and the row
    // header carries the same words, because a screen reader cannot hover.
    const m = await openPanel(poolUsage)
    const title = rowTitleOf('A Two') ?? ''
    expect(title, 'the row must still be able to say exactly when').toContain('row.poolRetryAt')
    expect(title).toContain('row.poolExcludedRateLimited')
    expect(rowLabelOf('A Two'), 'and say it without a mouse').toBe('A Two — ' + title)
    await m.unmount()
  })

  it('formats the reset instant exactly as the pool card does', async () => {
    // The drift guard. Both surfaces call one shared formatter; if either grows
    // its own, the same instant prints two ways and the pair looks broken.
    const m = await openPanel(poolUsage)
    const mark = markOf('A Two') ?? ''
    // The panel's instant now lives in the row title, not the visible line.
    const panelLine = rowTitleOf('A Two') ?? ''
    const INSTANT = /at=([^|]+?)(?:\s·|$)/
    const panelAt = INSTANT.exec(panelLine)?.[1]
    expect(panelAt, 'the panel must still carry an instant, in its title').toBeDefined()
    // And the WAIT stays visible. "01:32 之后可再用" alone makes the reader
    // subtract from the clock and does not say whether that is tonight or
    // tomorrow, which is why the visible half keeps the relative wait.
    const WAIT = /row\.recovers(Imminent|Minutes|Hours|Days)(\|count=\d+)?/
    expect(WAIT.test(mark), 'the panel must print how long until it is usable').toBe(true)

    // Render the card from the SAME document, then compare the instants. The
    // card takes the pool block itself, so the measurement compared below is
    // literally the same object the panel read.
    const card = await mount(AccountPool as any, {
      t,
      region: 'cn',
      settingsScope: scopeOf({ regions: { cn: { pool: { memberAccountIds: ['a-1', 'a-2', 'a-3'], orderAccountIds: [] } } } }),
      pool: (poolUsage() as any).pool,
    })
    const cardLine = Array.from(card.container.querySelectorAll('.dsm-workbuddy-pool-probe-main'))
      .map(node => node.textContent ?? '')
      .find(text => text.includes('row.poolExcludedRateLimited')) ?? ''
    const cardAt = INSTANT.exec(cardLine)?.[1]
    expect(cardAt, 'the card must print the same instant').toBe(panelAt)
    // Same WAIT derived from the same number — but not the same sentence, and
    // that is deliberate rather than drift.
    //
    // The card's sentence already carries its own verb earlier ("{at} 之后可再用"),
    // so appending "约 2 小时后恢复" there would say it twice in one line:
    // "10/22, 14:47 之后可再用 · 约 2 小时后恢复". The panel has no such verb —
    // its line is "被限流 · …" — so it needs one, which is the whole reason
    // `recoversInText` exists beside `remainingText`.
    //
    // What the shared rule must still guarantee is the NUMBER and its rounding:
    // both surfaces read one instant through one rounding rule, so they can
    // never disagree about how long is left. Compare those, not the key prefix.
    const cardNum = /row\.remaining(Imminent|Minutes|Hours|Days)(\|count=\d+)?/.exec(cardLine)?.[0]
    const panelNum = (WAIT.exec(mark)?.[0] ?? '').replace('row.recovers', 'row.remaining')
    expect(panelNum, 'the panel must state a wait at all').not.toBe('')
    expect(cardNum, 'the card must state the same wait, from the same instant').toBe(panelNum)
    await card.unmount()
    await m.unmount()
  })

  // FOURTH AND FINAL CONTRACT, at the user's explicit request:
  //
  //   "能用的 绿色圆点，当前选择的，绿色圆点加第二行提示当前选用，不能用的 红色圆点+原因"
  //
  // Colour answers ONE question — can this account serve the next message? — and
  // the second line answers the other — is it the one this tab is using?
  //
  // The revision this replaces painted green only on the selected account, so
  // every other usable row was grey ("可用的用灰色，在用的用绿色"). That was an
  // answer to "这样无法知道当前用的是什么", but it made the panel's default
  // question — "which accounts do I have left?" — unreadable: one green row
  // among greys. The two facts now have separate channels, which is what the
  // earlier revision could not do while using colour for both.
  it('paints every usable account green and names the one in use', async () => {
    const pool = (currentId: string): Record<string, unknown> => ({
      ...usageOf('cn', 1072),
      pool: {
        enabled: true,
        targetModelId: '',
        checkinSupported: true,
        modelId: 'deepseek-v4.1-flash',
        accounts: [
          {
            accountId: 'a-1',
            accountName: 'A One',
            credits: 1072,
            current: currentId === 'a-1',
            member: true,
            probe: { outcome: 'ok', atMs: Date.now() - 60_000 },
          },
          {
            accountId: 'a-2',
            accountName: 'A Two',
            credits: 200,
            current: currentId === 'a-2',
            member: true,
            probe: { outcome: 'ok', atMs: Date.now() - 60_000 },
          },
        ],
      },
    })

    // Two healthy accounts, A Two in use: BOTH green, and only A Two says so.
    const m = await openPanel(() => pool('a-2'))
    expect(dotOf('A Two')!.className, 'a usable account is green, selected or not').toContain('panel-dot-ok')
    expect(dotOf('A One')!.className, 'the other usable account is green too').toContain('panel-dot-ok')
    expect(markOf('A Two'), 'the selected account says which it is').toBe('composer.current')
    expect(markOf('A One'), 'a usable account that is not selected says nothing').toBeUndefined()
    await m.unmount()

    // Swap the selection: the label moves with it, and no dot changes colour,
    // because usability did not change.
    const swapped = await openPanel(() => pool('a-1'))
    expect(dotOf('A One')!.className).toContain('panel-dot-ok')
    expect(dotOf('A Two')!.className).toContain('panel-dot-ok')
    expect(markOf('A One')).toBe('composer.current')
    expect(markOf('A Two')).toBeUndefined()
    await swapped.unmount()
  })

  it('marks the row the POOL is serving, even when the saved choice names another', async () => {
    // The reported screenshot: the highlight sat on one account while
    // 「当前选用」 sat on another. The row's highlight and its label were reading
    // DIFFERENT answers — highlight from the credits endpoint's `selected` (the
    // SAVED choice), label from `pool.accounts[].current` (what the shim bills).
    // With the pool rotating, those two legitimately differ.
    //
    // One question, one answer: everything on the row must follow the pool
    // document while it exists. `usageOf` here says a-1 is the saved choice;
    // the pool says a-2 is serving.
    const doc = {
      ...usageOf('cn', 1072),
      pool: {
        enabled: true,
        targetModelId: '',
        checkinSupported: true,
        modelId: 'deepseek-v4.1-flash',
        accounts: [
          { accountId: 'a-1', accountName: 'A One', credits: 1072, current: false, member: true, probe: { outcome: 'ok', atMs: Date.now() - 60_000 } },
          { accountId: 'a-2', accountName: 'A Two', credits: 200, current: true, member: true, probe: { outcome: 'ok', atMs: Date.now() - 60_000 } },
        ],
      },
    }
    const m = await openPanel(() => doc)
    // The LABEL follows the serving account…
    expect(markOf('A Two'), 'the serving account is the one that says so').toBe('composer.current')
    expect(markOf('A One'), 'the saved choice must not claim to be in use').toBeUndefined()
    // …and so does the HIGHLIGHT. These are the two halves that disagreed.
    // The panel is portalled out of the component tree, so it is found on
    // `document.body` exactly like `markOf` above does.
    const rowOf = (name: string): Element | undefined => Array.from(document.body.querySelectorAll('tr'))
      .find(tr => (tr.querySelector('.dsm-workbuddy-composer-panel-name')?.textContent ?? '') === name)
    expect(rowOf('A Two')!.className, 'the highlight follows the same answer as the label').toContain('row-current')
    expect(rowOf('A One')!.className ?? '', 'the saved choice is not highlighted').not.toContain('row-current')
    await m.unmount()
  })

  it('paints a refusal red rather than amber', async () => {
    // A rate limit is a refusal, not a warning: the account cannot answer this
    // message, and amber ("mostly fine, look later") was the one thing the row
    // was not. The reason still rides on the second line, so the colour is not
    // the only carrier of the fact.
    const m = await openPanel(poolUsage)
    expect(dotOf('A Two')!.className, 'a stated rate limit is red').toContain('panel-dot-error')
    expect(dotOf('A Two')!.className).not.toContain('panel-dot-ok')
    expect(markOf('A Two')).toContain('row.poolExcludedRateLimited')
    await m.unmount()
  })

  it('still shows a problem on the in-use row, in words', async () => {
    // Green-for-current must not swallow a real limitation. The dot carries
    // "live"; the mark under the name continues to carry "rate limited, until
    // when", so the two facts coexist instead of one hiding the other.
    const m = await openPanel(() => ({
      ...usageOf('cn', 1072),
      pool: {
        enabled: true,
        targetModelId: '',
        checkinSupported: true,
        modelId: 'deepseek-v4.1-flash',
        accounts: [
          {
            accountId: 'a-1',
            accountName: 'A One',
            credits: 1072,
            current: true,
            member: true,
            probe: { outcome: 'rate-limited', atMs: Date.now() - 60_000, retryAtMs: Date.now() + 9 * 3_600_000 },
            excludedBy: 'rate-limited',
          },
        ],
      },
    }))
    // The dot goes RED even though this is the account in use: the row cannot
    // answer the next message, and a green dot would say it can. Selection is
    // spelled out on the second line instead, so nothing is lost by it.
    expect(dotOf('A One')!.className, 'the in-use row is red when it cannot serve').toContain('panel-dot-error')
    const line = markOf('A One') ?? ''
    expect(line, 'the limitation is not hidden').toContain('row.poolExcludedRateLimited')
    expect(line, 'and the row still says it is the one in use').toContain('composer.current')
    await m.unmount()
  })

  it('marks a healthy account and an unmeasured one differently', async () => {
    const m = await openPanel(poolUsage)
    expect(dotOf('A One')!.className).toContain('panel-dot-ok')
    // No probe and no exclusion: state unknown, NOT success. Claiming green
    // would assert a measurement nobody made.
    expect(dotOf('A Three')!.className).toContain('panel-dot-unknown')
    expect(markOf('A Three'), 'nothing to explain for an unmeasured account').toBeUndefined()
    await m.unmount()
  })

  it('prints no reason on a row that has no problem', async () => {
    // The second line carries two facts only: "this is the account in use" and
    // "this is why it cannot serve". A healthy row prints the first or nothing:
    // never a state label, because a checkmark on every row is noise and the
    // green dot already says it.
    //
    // A One is the selected account in this fixture, so the "nothing" half is
    // asserted on its absence-of-a-reason: the line exists, and says only that
    // this is the current one -- no health claim, no instant, no wait.
    const m = await openPanel(poolUsage)
    const line = markOf('A One')
    expect(line, 'the selected row names itself').toBe('composer.current')
    expect(line, 'and claims nothing more').not.toContain('row.')
    await m.unmount()
  })

  it('paints the selection green and the refusal in its own tone', async () => {
    // The owner's follow-up, pointing at the boxed line in a screenshot:
    //
    //   "框出来的，当前选用用绿色的字"
    //
    // "当前选用" and "被限流" used to share ONE span and therefore one colour --
    // the reason's amber -- so a statement of fact was painted like a problem.
    // They are two facts and now two spans, each with its own class, joined by a
    // separator drawn in CSS so the plain-text reading of the line is unchanged.
    const markPartsOf = (name: string): { current?: Element | undefined; reason?: Element | undefined } => {
      const who = Array.from(document.body.querySelectorAll('.dsm-workbuddy-composer-panel-who'))
        .find(node => node.querySelector('.dsm-workbuddy-composer-panel-name')?.textContent === name)
      return {
        current: who?.querySelector('.dsm-workbuddy-composer-panel-mark-current') ?? undefined,
        reason: who?.querySelector('.dsm-workbuddy-composer-panel-mark-reason') ?? undefined,
      }
    }

    const m = await openPanel(poolUsage)
    // A healthy selected row: the selection span exists alone.
    expect(markPartsOf('A One').current?.textContent).toBe('composer.current')
    expect(markPartsOf('A One').reason, 'a healthy row has no refusal to print').toBeUndefined()
    // An unusable row that is NOT selected: only the reason.
    expect(markPartsOf('A Two').reason?.textContent).toContain('row.poolExcludedRateLimited')
    expect(markPartsOf('A Two').current).toBeUndefined()
    await m.unmount()

    // Both facts on one row: the in-use account that is rate limited.
    const both = await openPanel(() => ({
      ...usageOf('cn', 1072),
      pool: {
        enabled: true,
        targetModelId: '',
        checkinSupported: true,
        modelId: 'deepseek-v4.1-flash',
        accounts: [
          {
            accountId: 'a-1',
            accountName: 'A One',
            credits: 1072,
            current: true,
            member: true,
            probe: { outcome: 'rate-limited', atMs: Date.now() - 60_000, retryAtMs: Date.now() + 3_600_000 },
            excludedBy: 'rate-limited',
          },
        ],
      },
    }))
    // The dots of both rows stay driven by usability -- this change is about the
    // second line's colours, not the dot's.
    expect(markPartsOf('A One').current?.textContent).toBe('composer.current')
    expect(markPartsOf('A One').reason?.textContent).toContain('row.poolExcludedRateLimited')
    // And the rule each one gets, read from the real stylesheet.
    const ruleOf = (name: string): string =>
      new RegExp(`\\.dsm-workbuddy-composer-panel-mark-${name}\\{([^}]*)\\}`).exec(WORKBUDDY_COMPOSER_CSS)?.[1] ?? ''
    expect(ruleOf('current'), 'the selection is green').toContain('--dsw-alias-state-success-primary')
    expect(ruleOf('reason'), 'the refusal keeps the warn tone').toContain('--dsw-alias-state-warn-primary')
    await both.unmount()
  })

  it('falls back to the credits row when the Host has no pool document', async () => {
    // An older Host answers the credits route but not the pool route; the panel
    // must still warn about a rate-limited account instead of silently hiding it.
    stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [
            { id: 'a-1', accountName: 'A One', selected: true, credits: 1072 },
            { id: 'a-2', accountName: 'A Two', selected: false, credits: 300, excludedBy: 'rate-limited' },
          ] }
        : usageOf('cn', 1072),
    }))
    const m = await render({ provider: 'workbuddy' })
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    expect(markOf('A Two')).toBe('row.poolExcludedRateLimited')
    await m.unmount()
  })
})

/**
 * The order the panel sorts by must come from the SAME place the card reads.
 *
 * The card sorts by `pool.orderAccountIds` (the wire field). Reading the settings
 * snapshot alone let the two lists disagree whenever the credits route answered
 * before the settings scope had caught up — the symptom being a panel that
 * re-sorted itself a moment after opening.
 */
describe('ComposerCredits panel takes its order from the pool document', () => {
  const names = (): string[] =>
    Array.from(document.body.querySelectorAll('.dsm-workbuddy-composer-panel-name'))
      .map(node => node.textContent ?? '')

  const creditsRows = {
    accounts: [
      { id: 'a-1', accountName: 'A One', selected: true, credits: 10 },
      { id: 'a-2', accountName: 'A Two', selected: false, credits: 20 },
    ],
  }

  it('follows the pool document order even with no saved settings order', async () => {
    // A Host that reports the order in the pool document only. The panel must
    // still match the card, which is what the user sees beside it.
    stubFetch((url) => ({
      body: url.includes('account-credits')
        ? creditsRows
        : {
            ...usageOf('cn', 30),
            pool: {
              enabled: true,
              targetModelId: '',
              orderAccountIds: ['a-2', 'a-1'],
              accounts: [
                { accountId: 'a-1', accountName: 'A One', current: true, member: true },
                { accountId: 'a-2', accountName: 'A Two', current: false, member: true },
              ],
            },
          },
    }))
    const m = await render({ provider: 'workbuddy', settingsScope: orderScope(['a-1', 'a-2']) })
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    // The document wins over the stale settings snapshot: agreement with the
    // card beats agreement with a snapshot the user cannot see.
    expect(names()).toEqual(['A Two', 'A One'])
    await m.unmount()
  })

  it('falls back to the settings order when the Host sends no order', async () => {
    stubFetch((url) => ({ body: url.includes('account-credits') ? creditsRows : usageOf('cn', 30) }))
    const m = await render({ provider: 'workbuddy', settingsScope: orderScope(['a-2', 'a-1']) })
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    expect(names()).toEqual(['A Two', 'A One'])
    await m.unmount()
  })
})

/**
 * Issue #108: the reason mark must FIT the column it lives in.
 *
 * THE REPORT. A CN row read "✗ 网关拦的是提示词本身，不是这个账号—" and stopped,
 * the clause severed at the panel's right edge with no ellipsis. The issue title
 * was simply "文字显示不完整".
 *
 * TWO CAUSES, and the fix addresses both:
 *  1. The printed string was `row.probeChannelRejected` — 88 characters of
 *     Chinese, 179 of English — used as the SHORT mark. It is an EXPLANATION
 *     written for the pool card's wide probe column; the panel gives it roughly
 *     180 px beside an account name, where it cannot fit.
 *  2. The panel's switch sets `white-space:nowrap` + `overflow:hidden` for the
 *     NAME and the mark inherited both, so the overflow was CUT rather than
 *     ellipsised. A hard cut carries no signal that anything is missing, which
 *     is why it read as broken rendering instead of as "truncated".
 *
 * WHAT MUST HOLD. The mark is the VERDICT, the full sentence stays one hover
 * away, and the mark's box is allowed to WRAP — the structural rule that keeps
 * the next long label from being severed silently.
 */
describe('issue #108: a long reason mark must not be clipped mid-sentence', () => {
  /** One account, channel-rejected — the shape the reporter captured. */
  const channelRejectedDoc = (): Record<string, unknown> => ({
    ...usageOf('cn', 1072),
    pool: {
      enabled: true,
      targetModelId: '',
      checkinSupported: true,
      modelId: 'deepseek-v4.1-flash',
      accounts: [{
        accountId: 'a-1',
        accountName: 'ISSAC',
        credits: 1072,
        current: true,
        member: true,
        probe: { outcome: 'channel-rejected', atMs: Date.now() - 60_000, source: 'live-request' },
      }],
    },
  })

  /**
   * A translator backed by the REAL Chinese strings.
   *
   * The shared `t` helper echoes keys, which is right for "which message did the
   * component choose" and wrong for this issue: the defect WAS the literal
   * length of the shipped string, so the assertion has to read the shipped one.
   */
  const zhT: any = (key: string, params?: Record<string, unknown>): string => {
    const raw = (zh as Record<string, string>)[key] ?? key
    if (params === undefined) return raw
    return raw.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name] ?? ''))
  }

  const open = async (): Promise<Mounted> => {
    stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [{ id: 'a-1', accountName: 'ISSAC', selected: true, credits: 1072 }] }
        : channelRejectedDoc(),
    }))
    const m = await mount(ComposerCredits as any, { t: zhT, provider: 'workbuddy' })
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    return m
  }

  it('prints the SHORT verdict, not the 88-character explanation', async () => {
    const m = await open()
    const mark = document.body.querySelector('.dsm-workbuddy-composer-panel-mark-reason')?.textContent ?? ''
    expect(mark).toBe('✗ 网关拦的是提示词')
    // The point is WIDTH, so assert it directly: a swap back to the long label
    // is the exact regression, and 88 vs 11 characters is what made it break.
    expect(mark.length, 'the mark must be a verdict, not a paragraph').toBeLessThan(20)
    await m.unmount()
  })

  it('keeps the whole explanation one hover away', async () => {
    // Shortening the visible mark must not DELETE the explanation: the row's
    // `title` carries `availabilityLine`, which is the long form plus instant.
    const m = await open()
    const title = Array.from(document.body.querySelectorAll('tr[title]'))
      .find(node => node.querySelector('.dsm-workbuddy-composer-panel-name')?.textContent === 'ISSAC')
      ?.getAttribute('title') ?? ''
    expect(title, 'the full sentence must survive in the title').toContain('网关拦的是提示词本身')
    expect(title, 'and must still name the real cause').toContain('第三方 agent 过滤')
    await m.unmount()
  })

  it('lets the mark WRAP, so a future long label is not severed', async () => {
    // The structural half. jsdom does not evaluate CSS, so this asserts the
    // shipped stylesheet — which is the only place the clipping ever existed.
    const rule = /\.dsm-workbuddy-composer-panel-mark\{([^}]*)\}/.exec(WORKBUDDY_COMPOSER_CSS)?.[1] ?? ''
    expect(rule, 'the mark must set its own whitespace').toContain('white-space:normal')
    expect(rule, 'and must break inside a CJK run').toContain('overflow-wrap:anywhere')
  })
})

/**
 * THE HEADER'S PAGE BUTTON.
 *
 * It opens this plugin's own `main` panel — the WIDE layout — because that is
 * the layout the accounts table needs. (An earlier 5.19.0 revision removed the
 * button on the belief that no public API could land on a configuration
 * surface; the wide page is reachable through `layout.selectPanel`, and the
 * entry registers it unconditionally, so the button is back.)
 */
describe('the panel header\'s page button', () => {
  it('is absent when the entry offers no route', async () => {
    // A control that cannot do what it says is worse than one that is not there.
    stubFetch(() => ({ body: usageOf('cn', 100) }))
    const m = await render({ provider: 'workbuddy' })
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    expect(document.body.querySelector('.dsm-workbuddy-composer-panel-settings')).toBeNull()
  })

  it('calls the route and closes the panel on success', async () => {
    stubFetch(() => ({ body: usageOf('cn', 100) }))
    let opened = 0
    const m = await render({ provider: 'workbuddy', onOpenSettings: () => { opened += 1; return true } })
    await m.click(m.buttons()[0] as Element)
    await m.settle()

    const button = document.body.querySelector<HTMLButtonElement>('.dsm-workbuddy-composer-panel-settings')
    expect(button, 'the page button is not rendered').not.toBeNull()
    button?.click()
    await m.settle()

    expect(opened, 'the route was never asked').toBe(1)
    // The panel is portaled and floats over the composer; navigating does not
    // remove it, so leaving it open would park this table on the page the user
    // just asked for.
    expect(document.body.querySelector('.dsm-workbuddy-composer-panel'), 'the panel stayed open over the page')
      .toBeNull()
  })

  it('reports a host with no route instead of silently doing nothing', async () => {
    stubFetch(() => ({ body: usageOf('cn', 100) }))
    const m = await render({ provider: 'workbuddy', onOpenSettings: () => false })
    await m.click(m.buttons()[0] as Element)
    await m.settle()

    document.body.querySelector<HTMLButtonElement>('.dsm-workbuddy-composer-panel-settings')?.click()
    await m.settle()

    expect(panelText(), 'a press that changes nothing reads as a broken button')
      .toContain('composer.openSettingsFailed')
    // And the panel stays open: the user needs to see the explanation.
    expect(document.body.querySelector('.dsm-workbuddy-composer-panel')).not.toBeNull()
  })
})
