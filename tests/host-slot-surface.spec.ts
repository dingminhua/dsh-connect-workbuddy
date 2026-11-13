import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The host surface this plugin CLAIMS — pinned as a closed set.
 *
 * ## Why this exists
 *
 * The 0.2.1-rc.5 review (docs/DSH-0.2.1-RC5-FOLLOWUP.md) concluded "no change
 * needed" for one reason above all: the only behavioural change in that release
 * — #7484's split of `conversation.chat.reasoning.body` into `rawText` (the raw
 * model output) and `text` (already prepared for display) — lands in a slot this
 * plugin does not contribute to, so the two facts cannot interact.
 *
 * That conclusion is only as durable as the claim. Nothing stops a future
 * feature from dropping a contribution into `conversation.chat.reasoning.body`
 * — at which point the rc.5 contract DOES apply (read `rawText` for the raw
 * output, never re-run display preparation on `text`), and the review's
 * reasoning quietly stops being true without anything going red. The review
 * document cannot enforce itself; this file can.
 *
 * So the claim is pinned in two directions:
 *
 * 1. **Closed set.** The slots registered from `src/client/index.tsx` are
 *    exactly the ones the design names. A further one is not forbidden — but it
 *    must be a deliberate act, so it fails here first and names the reason.
 * 2. **Conditional contract.** IF the source ever touches the reasoning-body
 *    surfaces, THEN it must also read `rawText`. That is the whole rc.5
 *    migration requirement, expressed so it bites only when it becomes real.
 *
 * Reading files rather than importing is deliberate, for the same reason as
 * `client-host-contract.spec.ts`: the real client entry pulls browser-only DSH
 * packages that cannot load under the node test environment. The tradeoff is
 * that these cases parse SOURCE TEXT; the parser below is written to tolerate
 * quote style and whitespace so ordinary reformatting does not produce noise.
 */

const repoRoot = new URL('../', import.meta.url)
const SRC = fileURLToPath(new URL('src/', repoRoot))

/**
 * Every slot this plugin is allowed to claim, with the reason it exists.
 *
 * Keep in sync with `docs/DESIGN.md` and `docs/DSH-0.2.1-RC5-FOLLOWUP.md` §3.2.
 * Adding an entry here is fine; adding one WITHOUT updating this table is the
 * thing the first case below refuses.
 */
const CLAIMED_SLOTS: Record<string, string> = {
  'settings.section': 'the configuration page itself (list slot, id owned by this plugin, order 35)',
  'settings.section.icon': 'that page\'s nav glyph, addressed by the SAME id (unmatched ids never render)',
  'conversation.input.right': 'composer-row credit capsule (order 4, before the model picker)',
  'conversation.input.model.label': 'load badge in the model picker (single cell; the priority is MODEL_LABEL_PRIORITY, deliberately not repeated here so it cannot go stale)',
  'conversation.composer.dock': 'stats credits row (order 10) and CLI live row (order 11)',
  'shell.quota-notice': 'frame-wide quota notice chain contributor',
  'sidebar.panellist': 'sidebar nav row (order 2) that opens the WorkBuddy full page',
  'main': 'centre-column full page keyed to the sidebar row',
}

/**
 * Slots whose rc.5 owner-props contract carries the `rawText` / `text` split.
 *
 * A contribution to one of these must read `rawText` when it wants the model's
 * own words, and must not feed `text` through display preparation a second
 * time — the host has already done that (`reasoning-text.ts`).
 */
const TEXT_SPLIT_SLOTS = ['conversation.chat.reasoning.body']

/** Every `.ts`/`.tsx` file under `src/`, recursively. */
function sourceFiles(directory: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(path)) out.push(path)
  }
  return out
}

/** Concatenated source of one file, or '' when it does not exist. */
function read(relativePath: string): string {
  try {
    return readFileSync(join(SRC, relativePath), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Slot names passed to `ctx.slots.inject(...)` in the client entry.
 *
 * Tolerates single or double quotes and arbitrary whitespace, because the point
 * is the CLAIM, not the formatting.
 */
function injectedSlots(): string[] {
  const source = read('client/index.tsx')
  const names = new Set<string>()
  for (const match of source.matchAll(/slots\s*\.\s*inject\s*\(\s*(['"])([^'"]+)\1/g)) {
    names.add(match[2] as string)
  }
  return [...names].sort()
}

/** Every source file whose text mentions a given slot name. */
function filesMentioning(slot: string): string[] {
  return sourceFiles(SRC)
    .filter(path => readFileSync(path, 'utf8').includes(slot))
    .map(path => path.slice(SRC.length))
    .sort()
}

describe('the plugin claims a closed, documented set of host slots', () => {
  it('registers exactly the slots the design names', () => {
    // A fifth entry here is not automatically wrong. It means this plugin's
    // "which host surface are we on" answer changed, so the rc.5 review's
    // premise has to be re-read before the slot is added. Failing here is how
    // that becomes a decision instead of an accident.
    expect(injectedSlots()).toEqual(Object.keys(CLAIMED_SLOTS).sort())
  })

  it('every registered seat agrees with the slot it was injected into', () => {
    // A BLIND SPOT this table used to have: `injectedSlots()` reads only the
    // `ctx.slots.inject('…')` argument, so changing the `register({ name })`
    // seat alone left all five cases green (verified by mutation) — while
    // `name` is what the registry actually keys the entry by. The two must
    // agree, or the plugin injects into one seat and registers into another.
    const source = read('client/index.tsx')
    const pairs: Array<{ inject: string; name: string }> = []
    // Each registration has this shape (the `.register(` sits on its own line
    // after a multi-line type annotation, so the pattern must not assume the
    // call and its object are adjacent):
    //
    //   slots.inject('X' as never, () => (ctx.slots as … {
    //     register(options…): () => void
    //   }).register({
    //     name: 'X',
    //
    // Anchoring on `.register({` — with the dot — skips the type-annotation
    // `register(` above it. Walking each `inject(` up to the NEXT `inject(`
    // (or end of file) keeps neighbouring registrations from being paired
    // with the wrong neighbour, without needing a lazy `[\s\S]*?` that can
    // overshoot.
    const injectCalls = [...source.matchAll(/(\w+\.)?slots\s*\.\s*inject\s*\(\s*(['"])([^'"]+)\2/g)]
    for (const [index, call] of injectCalls.entries()) {
      const injected = call[3] as string
      const from = (call.index ?? 0) + call[0].length
      const to = injectCalls[index + 1]?.index ?? source.length
      const segment = source.slice(from, to)
      // The object literal closes as `}, Component)` — the component argument
      // follows the closing brace, so the pattern must not require `)` there.
      const registered = /\.\s*register\s*\(\s*\{([\s\S]*?)\n\s*\}/.exec(segment)?.[1]
      const name = registered === undefined
        ? undefined
        : /\bname\s*:\s*(['"])([^'"]+)\1/.exec(registered)?.[2]
      if (name !== undefined) pairs.push({ inject: injected, name })
    }
    // Guard the guard: a regex that matched nothing would make this vacuous.
    expect(pairs.length).toBeGreaterThanOrEqual(3)
    for (const pair of pairs) {
      expect(pair.name, `injects into "${pair.inject}" but registers into "${pair.name}"`).toBe(pair.inject)
    }
  })

  it('claims nothing in the conversation.chat namespace', () => {
    // This is the rc.5 conclusion, stated as a property: every slot we touch
    // lives in the composer (`conversation.input.*`, `conversation.composer.*`)
    // or the frame (`shell.*`). Nothing under `conversation.chat.*`, which is
    // where the reasoning-body change landed.
    for (const slot of injectedSlots()) {
      expect(slot.startsWith('conversation.chat.'), `${slot} is in the reply transcript namespace`).toBe(false)
    }
  })

  it('does not mention a text-split slot anywhere in src/', () => {
    // The stronger form: not just "we do not REGISTER there" but "we do not
    // reach for it from a component, a hook, or a selector either". If this
    // goes red, the conditional case below is the one to satisfy.
    for (const slot of TEXT_SPLIT_SLOTS) {
      expect(filesMentioning(slot), `${slot} is referenced from src/ — see the rawText contract`).toEqual([])
    }
  })

  it('reads rawText whenever it does touch a text-split slot', () => {
    // The rc.5 migration requirement, made conditional so it stays silent while
    // the surface is unused and becomes mandatory the moment it is not:
    //   - `text` is DISPLAY-READY in rc.5+ (host ran `reasoning-text.ts` over it);
    //   - `rawText` is the model's own output.
    // A renderer that wants the original words must read `rawText`, and must not
    // run display preparation over `text` a second time.
    for (const slot of TEXT_SPLIT_SLOTS) {
      const users = filesMentioning(slot)
      if (users.length === 0) continue
      for (const file of users) {
        expect(read(file), `${file} uses ${slot} but never reads rawText`).toContain('rawText')
      }
    }
  })
})

describe('the rc.5 review stays reachable from the code that depends on it', () => {
  it('keeps the 0.2.2-rc.1 review, and it names the deprecation and the type gap', () => {
    // Same POLICY idea as the rc.5 case below: the rc.1 review concluded "no
    // change needed" and recorded the two things a future upgrade must not
    // forget — the deprecated `stateOf` read and the two profile fields the
    // 0.2.2 type surface made required. If the document disappears, the only
    // place that says so goes with it.
    const doc = readFileSync(fileURLToPath(new URL('docs/DSH-0.2.2-RC1-FOLLOWUP.md', repoRoot)), 'utf8')
    expect(doc).toContain('无需改动')
    expect(doc).toContain('stateOf')
    expect(doc).toContain('maxRequestImages')
    expect(doc).toContain('snapshot(session, [\'workingDirectory\'])')
  })

  it('keeps the 0.2.2-rc.2 review, and it records what the rc.1 one could not see', () => {
    // The rc.2 review is the one that ACTED on the rc.1 items, and it is the
    // only place that explains three facts a future reader cannot recover from
    // the code:
    //
    //   1. why `maxRequestImages` is pinned absurdly high instead of at the
    //      host's 50 (adopting 50 would silently narrow this route);
    //   2. that pi-ai 1.3 DISCARDS a foreign thinking block, so the repair is a
    //      no-op there and the premise tests must measure rather than assume;
    //   3. that pi-ai has to move in lockstep with the dsh line, because
    //      `providers/all` is missing an export in 0.85.1 — a startup failure.
    const doc = readFileSync(fileURLToPath(new URL('docs/DSH-0.2.2-RC2-FOLLOWUP.md', repoRoot)), 'utf8')
    expect(doc).toContain('maxRequestImages')
    expect(doc).toContain('1.3.0')
    expect(doc).toContain('snapshot')
    // The lockstep claim, stated as the failure it causes rather than as a
    // version rule: "启动失败，不是类型错误" is the sentence a reader needs.
    expect(doc).toContain('启动失败')
  })

  it('keeps the rc.5 follow-up document, and it names the reasoning-body change', () => {
    // POLICY assertion, not a behaviour one: nothing fails at runtime if the
    // review is deleted, so the only way it stays findable is that something
    // points at it. §2.1 is where a future contributor learns why the
    // `conversation.chat.*` namespace was left alone on purpose.
    const doc = readFileSync(fileURLToPath(new URL('docs/DSH-0.2.1-RC5-FOLLOWUP.md', repoRoot)), 'utf8')
    expect(doc).toContain('rawText')
    expect(doc).toContain('conversation.chat.reasoning.body')
    // The conclusion has to be legible without reading the whole document.
    expect(doc).toContain('无需改动')
  })

  it('keeps the 0.2.2-rc.3 review, and it records the two facts only that round saw', () => {
    // The rc.3 review concluded "no source change" — which is exactly the kind
    // of conclusion that gets deleted as noise. Two things would be lost with
    // it, and neither is recoverable from the code:
    //
    //   1. `hoc` is a slot kind this plugin deliberately does NOT recognise.
    //      Without this note, the fallback in `declaredSlotKind()` reads like an
    //      oversight rather than the conservative choice it is.
    //   2. `dsh-invariants` was an override pinning a version that was never
    //      published, and it survived a year because nothing resolved it. That
    //      is the check a future upgrade round must repeat, so the document has
    //      to keep the method, not just the outcome.
    const doc = readFileSync(fileURLToPath(new URL('docs/DSH-0.2.2-RC3-FOLLOWUP.md', repoRoot)), 'utf8')
    // The dead-override finding, stated as the package that caused it.
    expect(doc).toContain('dsh-invariants')
    // The `hoc` CONCLUSION, not merely the word: `hoc` also appears in the
    // diff table as `kind: 'hoc'`, so a bare `toContain('hoc')` stays green
    // after the reasoning is deleted. This exact sentence is the part that
    // tells a future reader the fallback is deliberate.
    expect(doc).toContain('遇到 `hoc` 归 `undefined`')
    expect(doc).toContain('declaredSlotKind')
    // The conclusion has to be legible without reading the whole document.
    expect(doc).toContain('无需改')
  })
})

/**
 * THE WIDE PAGE AND THE SIDEBAR ROW ARE INDEPENDENT.
 *
 * They used to share one lifetime, both owned by `syncPanelRegistration`, so the
 * page existed only while the optional sidebar nav row was switched on. The row
 * claims a GLOBAL nav seat and defaults to OFF, so on a default install the page
 * was unreachable — which is what made the composer readout's button impossible
 * to ship (there was nothing to open).
 *
 * The page is what the readout's button opens, via `layout.selectPanel(key)`;
 * that call THROWS for an unregistered key. So the invariant is: `main` is
 * registered unconditionally, and only the nav row is conditional.
 */
describe('the full page is registered independently of the optional sidebar row', () => {
  const source = read('client/index.tsx')

  it('registers main from the always-on slot list', () => {
    // The always-on set is the array literal returned by `registerAllSlots`.
    // If `registerMainPage()` is not in it, the page is back behind the opt-in
    // switch and the readout's button would throw on press.
    const list = /const registerAllSlots = \(\): Array<\(\) => void> => \[([\s\S]*?)\]\.filter/u.exec(source)?.[1] ?? ''
    expect(list, 'registerAllSlots not found').not.toBe('')
    expect(list, 'the full page must be registered unconditionally')
      .toContain('registerMainPage()')
    expect(list, 'the nav ROW must stay conditional, owned by syncPanelRegistration')
      .not.toContain('registerPanelRow()')
  })

  it('registers the nav row only from the opt-in switch', () => {
    const sync = /const syncPanelRegistration = \(\): void => \{([\s\S]*?)\n    \}/u.exec(source)?.[1] ?? ''
    expect(sync, 'syncPanelRegistration not found').not.toBe('')
    expect(sync, 'the opt-in gate must still guard the row').toContain('if (!sidebarPanelWanted()) return')
    expect(sync, 'the gated half is the ROW, not the page').toContain('registerPanelRow()')
    expect(sync, 'the page must NOT be re-registered with the row').not.toContain('registerMainPage()')
  })

  it('opens the page through the host layout service, guarding its throw', () => {
    // `layout.selectPanel` throws when the key is unregistered (a trimmed
    // profile). The catch must be INSIDE the entry: a click handler that throws
    // is a broken button with a console error, not an honest "cannot".
    const fn = /const openFullPage = \(\): boolean => \{([\s\S]*?)\n    \}/u.exec(source)?.[1] ?? ''
    expect(fn, 'openFullPage not found').not.toBe('')
    expect(fn, 'must ask the layout service').toContain('selectPanel(PANEL_ID)')
    expect(fn, 'must survive a refused key').toContain('catch')
    expect(fn, 'must report failure rather than throwing').toContain('return false')
  })

  it('gives BOTH readout seats the same settings opener', () => {
    // The two seats render the SAME component, so a prop wired into one and not
    // the other makes a control appear or vanish depending on a setting that
    // has nothing to do with it. (That is exactly how the button went missing
    // once: the composer seat had it and the stats seat did not.)
    const wired = source.match(/onOpenSettings: openSettingsSection/gu) ?? []
    expect(wired, 'both the composer and stats seats must wire the opener').toHaveLength(2)
    expect(source, 'the readout must be given the settings opener')
      .not.toContain('onOpenSettings: openFullPage')
  })

  it('never leaves the opener undefined, because the button renders only when it exists', () => {
    // A host service probed with `ctx.get` at registration time is `undefined`
    // on a profile whose provider applies later, and the renderer caches
    // `inject()` results by entry identity — so a `undefined` captured then is
    // permanent. The opener must therefore be a value that EXISTS from the
    // start, which is why it drives the shell's chrome instead of a service.
    const decl = /const openSettingsSection = \(\): boolean =>/u.exec(source)
    expect(decl, 'the opener must be a function value, not a late-assigned let').not.toBeNull()
    expect(source, 'the opener must not depend on a probed service to exist')
      .toMatch(/const openSettingsSection = \(\): boolean => openWorkBuddySettingsSection\(\{/u)
  })
})
