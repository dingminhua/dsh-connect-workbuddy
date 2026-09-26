import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regression suite for two defects that shipped together and share one root
 * cause: a declaration that outlived the code it described.
 *
 * 1. `dsh.client.inject` still listed `@deepseek-ai/dsh-client-ui-primitives`
 *    after `ddd11ed` (the upstream-review commit whose item 6 replaced the
 *    host chevron icon with a pure-CSS caret) deleted the last import from
 *    that package. The loader treats every `inject` entry as a LOAD
 *    DEPENDENCY — `client-modules` walks it in `arriveDependency`
 *    (`packages/client/modules/src/client/system.ts:268`) and keeps it alive
 *    in `prune` (`:448`) — so the stale entry made the card's arrival depend
 *    on a package the plugin never touches, and a failure there would cascade
 *    into "not loaded because dependency failed" for this plugin. The blast
 *    radius is not hypothetical: `dsh-client-ui-primitives` is the single
 *    churn-heaviest package on the plugin's whole client surface (75 files,
 *    ~1500 insertions across rc.1→rc.2) and the only one that DELETED an
 *    export in that window (`OnboardingSurface`, 268→279 symbols).
 *
 * 2. The card styled the encrypted-credential reason with
 *    `--dsw-alias-state-warning-primary`, which is not a token the host has
 *    ever defined — on EITHER 0.1.7 tag. The real token is the abbreviated
 *    `--dsw-alias-state-warn-primary`. Because the declaration carried a
 *    hex fallback, the rule never went blank; instead the fallback won
 *    silently on every render, in both themes, so the colour was frozen at a
 *    hard-coded value and stopped tracking the host palette. The kernel's own
 *    decision record names this exact confusion as the reason a shipped
 *    component was corrected (`.agents/notes/implemented/architecture/
 *    2026-09-05-shared-client-control-primitives.md:71`: "rather than the
 *    nonexistent `--dsw-alias-state-warning-primary` alias").
 *
 * Both are declarative, so both are checked by reading the FILES rather than
 * by importing them: `package.json` and `src/client/styles.ts` are the
 * authoritative copies, and reading them keeps this suite free of the
 * browser-only DSH client packages the real client entry pulls in.
 *
 * These tests are mutation-checked by construction: restore either defect and
 * the corresponding case goes red.
 */

const repoRoot = new URL('../', import.meta.url)

/** Parsed `package.json` of the published bundle. */
function manifest(): { dsh?: { client?: { inject?: string[] } } } {
  return JSON.parse(readFileSync(fileURLToPath(new URL('package.json', repoRoot)), 'utf8'))
}

/**
 * Every host package the client half references at all — value OR type-only.
 *
 * Both kinds count, and that is deliberate: `inject` is not a mirror of value
 * imports. The kernel's own convention proves it in both directions, so this
 * suite asserts neither:
 *
 * - `@deepseek-ai/dsh-client-ui-settings-plugins` imports `dsh-client-locale`
 *   and `dsh-client-ui-settings` as bare `import type {}` augmentation and
 *   still injects both (`packages/client/ui-settings-plugins/src/client/index.ts:11,15`).
 * - `@deepseek-ai/dsh-client-ui-theme` imports real `ui-primitives` COMPONENTS
 *   (`AppearanceRow.tsx:11`) and does NOT inject it.
 *
 * What the manifest actually promises is narrower: "`inject` names package
 * rows whose factories must arrive before this row materializes" plus Cordis'
 * use of the same edges to compose entries (`manifest.ts:47`). So the one
 * direction that holds — and the one this regression violated — is that an
 * `inject` entry must name something the plugin genuinely references. An entry
 * with zero references anywhere in the client half is a dependency the card
 * pays for and never uses.
 */
function clientReferencedPackages(): string[] {
  const files = ['index.tsx', 'WorkBuddyCard.tsx', 'account-selection.ts', 'searched-paths.ts', 'styles.ts', 'icon.ts', 'locales.ts']
  const found = new Set<string>()
  for (const file of files) {
    const source = readFileSync(fileURLToPath(new URL(`src/client/${file}`, repoRoot)), 'utf8')
    for (const match of source.matchAll(/from\s+'(@deepseek-ai\/[^']+)'/g)) {
      const specifier = match[1]
      const root = specifier === undefined ? undefined : packageRootOf(specifier)
      if (root !== undefined) found.add(root)
    }
  }
  return [...found]
}

/** The card stylesheet, as shipped inside the client bundle. */
function cardCss(): string {
  const source = readFileSync(fileURLToPath(new URL('src/client/styles.ts', repoRoot)), 'utf8')
  const match = /export const WORKBUDDY_CARD_CSS\s*=\s*`([\s\S]*?)`/.exec(source)
  if (match?.[1] === undefined) throw new Error('WORKBUDDY_CARD_CSS template literal not found in src/client/styles.ts')
  return match[1]
}

/** The bare package name a client specifier names, or undefined for a subpath/relative one. */
function packageRootOf(specifier: string): string | undefined {
  if (!specifier.startsWith('@')) return undefined
  const [scope, name] = specifier.split('/')
  return scope === undefined || name === undefined ? undefined : `${scope}/${name}`
}

describe('dsh.client.inject', () => {
  it('never names a package the client half does not reference', () => {
    const injected = manifest().dsh?.client?.inject ?? []
    const referenced = new Set(clientReferencedPackages())

    // The regression this guards: `ui-primitives` stayed listed after the last
    // import from it was deleted, making the card's factory arrival depend on
    // a package it never touches.
    const unreferenced = injected.filter(name => !referenced.has(name))
    expect(unreferenced).toEqual([])
  })

  it('does not depend on the client primitives package', () => {
    // Stated separately from the general rule above so this specific
    // regression gets its own named failure rather than a set diff.
    expect(manifest().dsh?.client?.inject ?? []).not.toContain('@deepseek-ai/dsh-client-ui-primitives')
    expect(clientReferencedPackages()).not.toContain('@deepseek-ai/dsh-client-ui-primitives')
  })

  it('keeps the four client packages the card genuinely composes against', () => {
    // The positive direction: these are the slots/settings/locale seats the
    // card registers into, so losing one from `inject` is also a defect.
    expect(manifest().dsh?.client?.inject ?? []).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-settings-plugins',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-locale',
    ]))
  })
})

describe('card theme tokens', () => {
  /**
   * The alias tokens the host actually defines at 0.1.7, read from the running
   * kernel where available and from the sibling checkout otherwise. The
   * `state-*` family is the one this suite guards, because that is where the
   * long/short form trap lives (`warn` vs `warning`).
   */
  const KERNEL_STATE_TOKENS = [
    '--dsw-alias-state-business-primary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-idle-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary',
  ] as const

  it('uses the abbreviated state-warn token, never the nonexistent state-warning alias', () => {
    const css = cardCss()
    expect(css).not.toContain('--dsw-alias-state-warning-primary')
    expect(css).toContain('--dsw-alias-state-warn-primary')
  })

  it('only references state tokens the host defines', () => {
    const css = cardCss()
    const used = [...css.matchAll(/var\((--dsw-alias-state-[a-z0-9-]+)/g)]
      .map(match => match[1])
      .filter((token): token is string => token !== undefined)
    expect(used.length).toBeGreaterThan(0)
    for (const token of new Set(used)) expect(KERNEL_STATE_TOKENS).toContain(token)
  })

  it('falls back to the host amber, not an unrelated hard-coded colour', () => {
    // `--dsw-alias-state-warn-primary` resolves to `--dsw-static-amber-500`
    // (#f59e0b) on BOTH the light and dark lines, so the fallback matches what
    // the token yields. This guards the value that was actually being painted.
    const rule = /\.dsm-workbuddy-searched-reason-encrypted\{([^}]*)\}/.exec(cardCss())
    expect(rule?.[1]).toBeDefined()
    expect(rule?.[1]).toContain('var(--dsw-alias-state-warn-primary,#f59e0b)')
    expect(rule?.[1]).not.toContain('#e0a13a')
  })
})
