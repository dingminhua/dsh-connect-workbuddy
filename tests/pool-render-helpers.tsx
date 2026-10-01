// @vitest-environment jsdom
/**
 * The real-render harness for AccountPool.tsx.
 *
 * Round-4 adversarial verification (docs/audit/I-round4-verification.md)
 * proved that every source-text guard on this component can be defeated by a
 * respelling — a ternary around an argument, a decoy lambda parameter, a
 * string literal where a read should be. The only fix that ends the class is
 * to EXECUTE the component, so that is what this file does: it mounts the real
 * AccountPool under jsdom and asserts on the DOM.
 *
 * Everything a test needs to observe is exposed through {@link mount}: the
 * interval input's `value` after each keystroke, the buttons' `disabled`
 * state, the log lines the component renders, and the props the parent would
 * have supplied. A regression that a regex guard let through (M01: the
 * interval field re-serializing its clamped value into the display) shows up
 * here as the wrong `value` attribute, which is the thing the user actually
 * sees.
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'

// React 18.3 moved `act` onto the react export; the test-utils copy warns.
const act: typeof actFromReact = ((React as unknown as { act?: typeof actFromReact }).act
  ?? actTestUtils) as typeof actFromReact

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/**
 * A key-preserving translator.
 *
 * Rendering the real locale strings would couple assertions to wording;
 * returning `key|param=value` makes each assertion name the exact message the
 * component chose, and keeps a raw id (`hex1`) trivially distinguishable from
 * the placeholder key it should have rendered instead.
 */
export const t: any = (key: string, params?: Record<string, unknown>): string => {
  if (params === undefined || params === null) return key
  const parts = Object.entries(params).map(([k, v]) => `${k}=${String(v)}`)
  return [key, ...parts].join('|')
}

export interface Mounted {
  container: HTMLDivElement
  update: (props: any) => Promise<void>
  unmount: () => Promise<void>
  text: () => string
  html: () => string
  buttons: () => HTMLButtonElement[]
  button: (needle: string) => HTMLButtonElement
  checkboxes: () => HTMLInputElement[]
  /** The settings toggles: [0] is the account pool switch. */
  toggles: () => HTMLInputElement[]
  click: (element: Element) => Promise<void>
  settle: () => Promise<void>
}

export async function mount(Component: any, props: any): Promise<Mounted> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => { root.render(React.createElement(Component, props)) })
  const mounted: Mounted = {
    container,
    async update(next: any) {
      await act(async () => { root.render(React.createElement(Component, next)) })
    },
    async unmount() {
      await act(async () => { root.unmount() })
      container.remove()
    },
    text: () => container.textContent ?? '',
    html: () => container.innerHTML,
    buttons: () => Array.from(container.querySelectorAll('button')) as HTMLButtonElement[],
    button(needle: string) {
      const found = mounted.buttons().find(b => (b.textContent ?? '').includes(needle))
      if (found === undefined) {
        throw new Error(
          `no button containing "${needle}". Buttons present: `
          + mounted.buttons().map(b => JSON.stringify(b.textContent)).join(', '),
        )
      }
      return found
    },
    checkboxes: () =>
      Array.from(container.querySelectorAll<HTMLInputElement>('.dsm-workbuddy-pool-table input[type=checkbox]')),
    toggles: () =>
      Array.from(container.querySelectorAll<HTMLInputElement>('.dsm-workbuddy-pool-settings input[type=checkbox]')),
    async click(element: Element) {
      await act(async () => { (element as HTMLElement).click() })
    },
    /**
     * Drain async work started OUTSIDE an act scope.
     *
     * The card's `useEffect` fires `void refreshUsage(...)` — a floating
     * promise — so its `setState` lands after `mount`'s act block exits. A
     * macrotask turn lets the fetch, the `json()` and the re-render complete.
     */
    async settle() {
      for (let turn = 0; turn < 5; turn += 1) {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      }
    },
  }
  return mounted
}

/** A settings-scope double: records writes and serves them back on read.
 *
 * `failWrites` makes `set` answer `false`, which `writeField` reads as "the
 * scope did not persist it" — the state of the 0.1.7 deployments where the
 * mirror is stale, so NEITHER write path lands and the save must fail.
 */
export function fakeScope(initial: Record<string, unknown> = {}, failWrites = false): any {
  const writes: { field: string, value: any }[] = []
  let value: Record<string, unknown> = initial
  return {
    writes,
    getSnapshot: () => ({ status: 'ready', value, writable: true }),
    /** The card subscribes for mirror updates; a no-op unsubscribe suffices. */
    subscribe: () => () => {},
    set: async (field: string, next: any) => {
      writes.push({ field, value: next })
      if (failWrites) return false
      value = { ...value, [field]: next }
      return true
    },
  }
}

/**
 * Records every fetch and answers with a canned body.
 *
 * `contentType` matters: the card picks its parser from it. The default is a
 * single JSON document — what check-in and an older Host answer with — while a
 * test that drives the streamed test route passes `application/x-ndjson`, which
 * also attaches a readable `body` so the card's NDJSON reader has a stream to
 * consume (its `json()` would have nothing to parse).
 */
export function stubFetch(
  answer: (url: string, init: any) => { status?: number, body: unknown, contentType?: string },
): { url: string, init: any }[] {
  const calls: { url: string, init: any }[] = []
  const stub = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    const result = answer(String(url), init)
    const status = result.status ?? 200
    const contentType = result.contentType ?? 'application/json'
    const text = typeof result.body === 'string' ? result.body : JSON.stringify(result.body)
    return {
      ok: status < 400,
      status,
      headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? contentType : null },
      json: async () => JSON.parse(text) as unknown,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text))
          controller.close()
        },
      }),
    }
  })
  vi.stubGlobal('fetch', stub)
  return calls
}

/** The pool preference fields every scenario must supply. */
export function poolOf(overrides: Record<string, unknown>): any {
  return {
    enabled: true,
    // Defaulted ON so existing scenarios keep rendering the check-in column; the
    // international-region scenarios turn it off explicitly.
    checkinSupported: true,
    targetModelSource: 'free',
    targetModelId: 'free-1',
    memberAccountIds: [],
    effectiveMemberAccountIds: [],
    catalog: [{ id: 'free-1', name: 'Free One', creditMultiplier: 0 }],
    accounts: [],
    ...overrides,
  }
}

export function accountOf(overrides: Record<string, unknown>): any {
  return {
    accountId: 'a',
    accountName: 'A',
    current: false,
    member: true,
    checkedInToday: true,
    ...overrides,
  }
}
