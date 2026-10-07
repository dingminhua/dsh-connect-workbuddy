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
    expect(document.body.querySelectorAll('.dsm-workbuddy-composer-panel-mark')).toHaveLength(1)
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
    expect(document.body.querySelectorAll('.dsm-workbuddy-composer-panel-mark')).toHaveLength(0)
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
