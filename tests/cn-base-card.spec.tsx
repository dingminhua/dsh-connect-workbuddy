// @vitest-environment jsdom
/**
 * The CN gateway editor in the card (issue #220).
 *
 * WHAT THIS PINS, AND WHY EACH PART IS WORTH A TEST:
 *
 *   1. It is a DRAFT + Save, not a commit per keystroke. A text field that wrote
 *      on every `onChange` would post `https://w`, `https://wb`, … to the host —
 *      six settings writes and six `warn` lines for one typed word, with the
 *      last of them possibly a half-typed host that then becomes the live base.
 *
 *   2. An invalid value is REFUSED with the specific rule it broke. The host
 *      falls back to the built-in gateway and logs (correct for a running
 *      process, invisible to a user already convinced their network is broken),
 *      so the card is the only place that can say "that host is not a CN brand".
 *
 *   3. The control is CN-only. The international gateways follow the
 *      credential's own brand domain, where a different brand's host is refused
 *      by the upstream — a control there would be permanently broken-looking.
 *
 *   4. The diagnostics row reports the RESOLVED value, not the saved string. A
 *      saved value that failed validation still routes to the built-in gateway,
 *      and echoing the raw text would tell the user their override is live.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { mount, fakeScope, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

function usageOf(region: string): Record<string, unknown> {
  return {
    status: 'signed-in',
    region,
    domain: region === 'cn' ? 'www.codebuddy.cn' : 'www.workbuddy.ai',
    accountId: `${region}-1`,
    accountName: `${region} One`,
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: `${region}-1`, accountName: `${region} One` }],
    models: [{ id: 'glm-5.3', name: 'GLM-5.3' }],
    enabledModelIds: ['glm-5.3'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 10, expiringSoon: 0, packages: [] },
  }
}

async function render(
  scopeValue: Record<string, unknown> = {},
  region: 'cn' | 'global' = 'cn',
): Promise<{ m: Awaited<ReturnType<typeof mount>>, calls: { url: string, init: any }[], scope: any }> {
  const calls = stubFetch(url => ({
    body: url.includes('__save') ? { value: {} } : usageOf(region),
  }))
  const scope = fakeScope(scopeValue)
  const m = await mount(WorkBuddyCard, { t, settingsScope: scope, view: 'page' })
  await m.settle()
  return { m, calls, scope }
}

/** Switch to the tab whose panel id is given. */
async function openTab(m: Awaited<ReturnType<typeof mount>>, tabId: string): Promise<void> {
  const tab = m.container.querySelector(`#${tabId}`)
  if (tab === null) throw new Error(`${tabId} missing`)
  await m.click(tab)
}

const inputOf = (container: HTMLElement): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>('.dsm-workbuddy-cnbase-input')

const saveButton = (container: HTMLElement): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('.dsm-workbuddy-cnbase-actions .dsm-btn-primary')

/**
 * Type into the field the way React sees it — via the harness's `typeInto`.
 *
 * NOT `m.choose`: that helper is for `<select>`s, and assigning `.value` on an
 * `HTMLInputElement` updates React's internal tracker too, so React concludes
 * nothing changed and never calls `onChange`. The field looks typed while the
 * component never hears about it.
 */
const type = async (
  m: Awaited<ReturnType<typeof mount>>,
  input: HTMLInputElement,
  value: string,
): Promise<void> => m.typeInto(input, value)

describe('the editor is a draft with an explicit Save', () => {
  it('shows the saved value and reflects the built-in gateway when unset', async () => {
    const { m, calls } = await render({})
    await openTab(m, 'dsm-workbuddy-tab-capabilities')
    const input = inputOf(m.container)
    expect(input, 'the CN gateway field is missing from the capabilities tab').not.toBeNull()
    expect(input?.value).toBe('')
    // Nothing to save yet, so the pair is absent: a permanently visible Save
    // under an untouched field turns a settings row into a form.
    expect(saveButton(m.container)).toBeNull()
    await m.unmount()
  })

  it('does NOT write while the user types', async () => {
    // The whole reason this is a draft. One keystroke burst must produce zero
    // save calls; only the explicit Save writes.
    const { m, calls } = await render({})
    await openTab(m, 'dsm-workbuddy-tab-capabilities')
    const input = inputOf(m.container) as HTMLInputElement
    for (const partial of ['h', 'ht', 'htt', 'http', 'https', 'https://wb']) {
      await type(m, input, partial)
    }
    expect(calls.filter(call => call.url.includes('__save'))).toHaveLength(0)
    await m.unmount()
  })

  it('saves the accepted host and clears the draft', async () => {
    const { m, calls } = await render({})
    await openTab(m, 'dsm-workbuddy-tab-capabilities')
    const input = inputOf(m.container) as HTMLInputElement
    await type(m, input, 'https://wb.tencentbuddy.com')
    const button = saveButton(m.container)
    expect(button, 'the Save button did not appear for a dirty draft').not.toBeNull()
    await m.click(button as Element)
    await m.settle()
    const writes = calls.filter(call => call.url.includes('__save'))
    expect(writes.length, 'the accepted host was not written').toBeGreaterThan(0)
    // The draft is discarded on success, so the pair disappears again.
    expect(saveButton(m.container)).toBeNull()
    await m.unmount()
  })
})

describe('an invalid value is refused with the rule it broke', () => {
  it('refuses a host that is not a CN brand, and writes nothing', async () => {
    const { m, calls } = await render({})
    await openTab(m, 'dsm-workbuddy-tab-capabilities')
    const input = inputOf(m.container) as HTMLInputElement
    await type(m, input, 'https://evil.example')
    const button = saveButton(m.container) as HTMLButtonElement
    await m.click(button)
    await m.settle()
    // Nothing reached the host: this is the security boundary, not a nicety.
    expect(calls.filter(call => call.url.includes('__save'))).toHaveLength(0)
    expect(m.text()).toContain('row.cnBaseInvalidHost')
    await m.unmount()
  })

  it('refuses plaintext http with its own wording, not the host rule', async () => {
    const { m, calls } = await render({})
    await openTab(m, 'dsm-workbuddy-tab-capabilities')
    const input = inputOf(m.container) as HTMLInputElement
    await type(m, input, 'http://wb.tencentbuddy.com')
    await m.click(saveButton(m.container) as Element)
    await m.settle()
    expect(calls.filter(call => call.url.includes('__save'))).toHaveLength(0)
    // The distinction is the point: "must be https" and "not a CN brand" need
    // different fixes, and one generic "invalid" leaves the user guessing.
    expect(m.text()).toContain('row.cnBaseInvalidInsecure')
    expect(m.text()).not.toContain('row.cnBaseInvalidHost')
    await m.unmount()
  })

  it('refuses a lookalike domain that merely contains an allowed name', async () => {
    const { m, calls } = await render({})
    await openTab(m, 'dsm-workbuddy-tab-capabilities')
    const input = inputOf(m.container) as HTMLInputElement
    await type(m, input, 'https://tencentbuddy.com.evil.example')
    await m.click(saveButton(m.container) as Element)
    await m.settle()
    expect(calls.filter(call => call.url.includes('__save'))).toHaveLength(0)
    expect(m.text()).toContain('row.cnBaseInvalidHost')
    await m.unmount()
  })

  it('clears a previously saved override when the field is emptied', async () => {
    const { m, calls } = await render({ regions: { cn: { cnBase: 'https://wb.tencentbuddy.com' } } })
    await openTab(m, 'dsm-workbuddy-tab-capabilities')
    const input = inputOf(m.container) as HTMLInputElement
    expect(input.value, 'the saved override must be shown').toBe('https://wb.tencentbuddy.com')
    await type(m, input, '')
    await m.click(saveButton(m.container) as Element)
    await m.settle()
    // Empty is a real instruction ("back to the built-in gateway"), so it does
    // write — unlike an invalid value, which writes nothing at all.
    expect(calls.filter(call => call.url.includes('__save')).length).toBeGreaterThan(0)
    await m.unmount()
  })
})

describe('the control exists only where it can work', () => {
  it('is present on the CN tab and absent on the international one', async () => {
    // Global tokens are brand-bound; a CN host would 401 them. A control there
    // could only ever produce a failure the user cannot diagnose.
    //
    // The region tab must be CLICKED, not merely stubbed: `activeRegion` starts
    // on `cn` regardless of what the fetch stub answers, so a test that only
    // changes the stub's region would assert against the CN tab and pass
    // vacuously — the control it expects to vanish was never the one rendered.
    const { m } = await render({}, 'global')
    await openTab(m, 'dsm-workbuddy-tab-capabilities')
    expect(inputOf(m.container), 'the CN gateway field must exist on the CN tab').not.toBeNull()

    const regionTabs = Array.from(m.container.querySelectorAll('[role=tab]'))
      .filter(tab => (tab.textContent ?? '').includes('row.tabGlobal'))
    expect(regionTabs, 'the international region tab is missing').toHaveLength(1)
    await m.click(regionTabs[0] as Element)
    await openTab(m, 'dsm-workbuddy-tab-capabilities')
    expect(inputOf(m.container), 'the CN gateway field must not appear on the international tab').toBeNull()
    await m.unmount()
  })
})

describe('diagnostics reports the RESOLVED gateway', () => {
  it('says "built-in" when nothing is configured', async () => {
    const { m } = await render({})
    await openTab(m, 'dsm-workbuddy-tab-diag')
    expect(m.text()).toContain('row.diagCnBaseDefault')
    await m.unmount()
  })

  it('names the override host when one is configured and valid', async () => {
    const { m } = await render({ regions: { cn: { cnBase: 'https://wb.tencentbuddy.com' } } })
    await openTab(m, 'dsm-workbuddy-tab-diag')
    expect(m.text()).toContain('https://wb.tencentbuddy.com')
    await m.unmount()
  })

  it('says "built-in" for a saved value that fails validation', async () => {
    // THE CASE THAT MATTERS. A profile can carry a value written by an older
    // build, by hand, or by a sync that mangles it. The request path falls back
    // to the built-in gateway, so reporting the raw string here would tell the
    // user their override is live while every request goes elsewhere.
    const { m } = await render({ regions: { cn: { cnBase: 'https://evil.example' } } })
    await openTab(m, 'dsm-workbuddy-tab-diag')
    expect(m.text(), 'the raw invalid value must not be reported as in force').not.toContain('evil.example')
    expect(m.text()).toContain('row.diagCnBaseDefault')
    await m.unmount()
  })
})
