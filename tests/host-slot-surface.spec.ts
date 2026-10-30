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
 *    exactly the four the design names. A fifth one is not forbidden — but it
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
  'conversation.input.right': 'composer-row credit capsule (order 4, before the model picker)',
  'conversation.input.model.label': 'load badge in the model picker (single, priority -0.5)',
  'conversation.composer.dock': 'stats credits row (order 10) and CLI live row (order 11)',
  'shell.quota-notice': 'frame-wide quota notice chain contributor',
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
  it('registers exactly the four slots the design names', () => {
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
})
