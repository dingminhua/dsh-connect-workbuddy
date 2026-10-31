import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

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

describe('WORKBUDDY_CARD_CSS template literal', () => {
  /**
   * The stylesheet is a template literal, so a stray backtick inside it
   * TERMINATES the string early — and TypeScript does not complain, because
   * what follows still parses as valid syntax. The result is a silently
   * truncated CSS bundle: every rule after the backtick is gone, so those
   * elements fall back to browser defaults with no error anywhere.
   *
   * That is not hypothetical. It happened while reworking the busy veil's
   * colours: the new comments quoted CSS tokens in backticks (the file's
   * convention for TS comments ABOVE the literal, which is harmless), the
   * literal split at the first one, and the veil block vanished. typecheck
   * and the build both passed; only the "every class is styled" guard noticed,
   * and only because it happened to cover those classes.
   *
   * So the check is on the SOURCE, not the extracted string: require the
   * literal's body to hold no backtick. A regex extraction cannot catch this —
   * it would simply match the shorter, broken literal.
   */
  it('leaves no stray statements behind, which is what truncation produces', () => {
    // A stray backtick inside the literal ends the string early, and the rest
    // of the stylesheet is then parsed as UNRELATED SYNTAX rather than as CSS.
    // Neither typecheck nor the build complains: the file is still valid TS,
    // it just exports a stub stylesheet and a pile of junk expression
    // statements. That is exactly what happened while reworking the veil.
    //
    // So count the file's top-level statements. A healthy styles.ts declares
    // its CSS exports and nothing else; truncation turns the remainder into
    // dozens of expression statements, one per token.
    const source = readFileSync(fileURLToPath(new URL('src/client/styles.ts', repoRoot)), 'utf8')
    const sf = ts.createSourceFile('styles.ts', source, ts.ScriptTarget.ESNext, true)
    const strays = sf.statements.filter(st => !ts.isVariableStatement(st))
    expect(strays.map(st => ts.SyntaxKind[st.kind])).toEqual([])
    expect(sf.statements.length).toBe(2)
  })

  it('still carries the veil rules the shared busy overlay depends on', () => {
    // Belt and braces for the same defect: if the literal is ever truncated
    // again, these selectors disappear from the extracted CSS.
    const css = cardCss()
    expect(css).toContain('.dsm-workbuddy-veil{')
    expect(css).toContain('.dsm-workbuddy-veil-card{')
    expect(css).toContain('.dsm-workbuddy-veil-spinner{')
  })

  it('paints both "current" badges as solid green with white ink', () => {
    // The defect this guards, in two steps.
    //
    // 1. Both badges used a HARDCODED pale-blue tint (rgba(86,134,254,.16)) but
    //    took their ink from --dsw-alias-brand-primary, the host's CONTRAST
    //    colour — near-BLACK on light themes. The badge read as a disabled label
    //    instead of the one row that is actually serving.
    // 2. Green TEXT on that pale-blue pill was still a quiet annotation, so the
    //    pill was filled instead: white ink on the success green itself.
    //
    // What must not come back: brand-primary (the contrast colour), and the
    // tinted-blue backdrop that made the green look accidental.
    //
    // Asserted per selector, on the extracted rule, because a blanket "the file
    // mentions success-primary" check would still pass if the other badge
    // quietly reverted.
    const css = cardCss()
    for (const selector of [
      '.dsm-workbuddy-pool-current-badge{',
      '.dsm-workbuddy-pool-account-name .dsm-workbuddy-pool-current-tag{',
    ]) {
      const start = css.indexOf(selector)
      expect(start, `${selector} disappeared from the stylesheet`).toBeGreaterThanOrEqual(0)
      const rule = css.slice(start, css.indexOf('}', start))
      // Filled pill: the success green IS the backdrop now.
      expect(rule, `${selector} lost its filled green pill`).toContain('background:var(--dsw-alias-state-success-primary')
      // White ink, stated literally: a token here would re-open the exact
      // drift between ink and backdrop this test exists to prevent.
      expect(rule, `${selector} ink is not white`).toContain('color:#fff')
      // The regression itself.
      expect(rule, `${selector} went back to the contrast colour`).not.toContain('brand-primary')
      // The old tinted-blue backdrop must be gone, not merely supplemented.
      expect(rule, `${selector} still carries the pale-blue tint`).not.toContain('rgba(86,134,254,.16)')
    }
  })
})

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

describe('card class names are styled', () => {
  /**
   * A class the stylesheet does not define does not merely look wrong — it
   * renders with BROWSER DEFAULTS. The card already shipped that defect once
   * (`Points` → `Credits` renamed the component but left two `trigger` rules
   * behind, so the credits readout fell back to a default button), and the
   * bar classes here replaced two per-feature blocks in one edit.
   *
   * The check is deliberately source-level rather than a render assertion: a
   * component that only renders inside a dialog is hard to reach, while a
   * missing rule is exactly the failure this guards.
   */
  // DeviceProfileDialog / DeviceSdkPanel are here because they were NOT, and that
  // is exactly how P2.5/P3 shipped 25 selectors into the wrong template literal:
  // the guard only ever looked at these five files, so the two new components'
  // classes went unchecked while `AccountPool`'s three happened to be caught.
  // A component rendered by the card belongs in this list.
  const components = [
    'OAuthSignIn.tsx',
    'AccountTransfer.tsx',
    'BusyOverlay.tsx',
    'WorkBuddyCard.tsx',
    'AccountPool.tsx',
    'DeviceProfileDialog.tsx',
    'DeviceSdkPanel.tsx',
  ] as const

  it('keeps the row action buttons on one line', () => {
    // Reported with a screenshot: the row's two action buttons broke into one
    // character per line (测 / 试). The immediate cause was a per-row model
    // picker that has since been REMOVED (issue #61 follow-up) — but the
    // underlying truth stands on its own: this row's action track is a fraction
    // of the table, and a fixed two-character label must never be broken
    // mid-word. Clipping is the right failure here.
    //
    // The picker's grid floor was deliberately removed with the picker: keeping
    // a `minmax(...)` sized for a control that no longer exists would reserve
    // dead width on every row.
    const css = cardCss()
    expect(css).toContain('.dsm-workbuddy-pool-row-actions .dsm-workbuddy-pool-small-btn{white-space:nowrap}')
    // …and nothing reserves width for the removed picker any more.
    expect(css).not.toContain('dsm-workbuddy-pool-row-model')
    expect(css).not.toContain('minmax(260px')
  })

  it('defines every class those components render', () => {
    const css = cardCss()
    const missing: string[] = []
    for (const file of components) {
      const source = readFileSync(fileURLToPath(new URL(`src/client/${file}`, repoRoot)), 'utf8')
      // Two authoring styles reach a class attribute in this client half:
      // JSX (`className="a b"`) and the `h()` calls the pool module uses
      // (`h('div', { className: 'a b' })`). Matching only the first let a
      // renamed pool class pass unstyled — the exact failure this guards.
      for (const match of source.matchAll(/className\s*[:=]\s*("[^"]*"|'[^']*')/g)) {
        // Template-literal classes (`className={`a ${cond ? 'b' : 'c'}`}`) are
        // deliberately out of scope: their pieces are single tokens spliced at
        // runtime, and matching the raw source would report `?` and `${` as
        // missing class names. The static forms below are the ones a rename
        // can silently orphan.
        for (const token of (match[1] ?? '').replace(/^["']|["']$/g, '').split(/\s+/)) {
          if (token === '' || token.startsWith('dsm-btn')) continue
          // A compound like `dsm-workbuddy-bar-status dsm-workbuddy-bar-ok`
          // is checked token by token, which is what makes the two-class
          // error/ok colouring survive a rename of either half.
          // Substring matching is not enough: `.dsm-x-RENAMED` still contains
          // `.dsm-x`, so a renamed class would read as present. Require the
          // token to be the WHOLE selector — the class must be followed by a
          // delimiter, never by more of its own name.
          if (!new RegExp(`\\.${token}(?![\\w-])`).test(css)) missing.push(`${file}: ${token}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('lets the model list be as tall as its rows, with no inner scrollbar', () => {
    // The picker's whole job is "let me see every model and tick it". A
    // `max-height` + `overflow-y: auto` here showed roughly seven of the
    // twenty-odd rows and hid the rest behind a second scrollbar inside a panel
    // that already scrolls — the user had to discover the inner one, then drag
    // it, to find out that a model even existed.
    //
    // `overflow:hidden` MUST stay even though nothing overflows any more: the
    // rounded corners are drawn by this bordered box, so without clipping the
    // first and last row would paint square corners over the radius. Asserting
    // the absence of a cap alone would let that be "cleaned up" later.
    const css = cardCss()
    const start = css.indexOf('.dsm-workbuddy-model-list{')
    expect(start, '.dsm-workbuddy-model-list disappeared from the stylesheet').toBeGreaterThanOrEqual(0)
    const rule = css.slice(start, css.indexOf('}', start))
    expect(rule, 'the model list must not cap its own height').not.toContain('max-height')
    expect(rule, 'the model list must not scroll inside the panel').not.toContain('overflow-y')
    expect(rule).toContain('overflow:hidden')
  })

  it('keeps the bar classes the resting layout depends on', () => {
    // Named explicitly because the one-line layout is carried by these
    // specific properties, not by the class merely existing: without
    // `nowrap`+`ellipsis` a long status would wrap the bar back to two rows.
    const css = cardCss()
    expect(css).toMatch(/\.dsm-workbuddy-bar\{[^}]*display:flex/)
    expect(css).toMatch(/\.dsm-workbuddy-bar\{[^}]*flex-wrap:wrap/)
    expect(css).toMatch(/\.dsm-workbuddy-bar-status\{[^}]*text-overflow:ellipsis/)
    expect(css).toMatch(/\.dsm-workbuddy-bar-actions\{[^}]*margin-left:auto/)
  })
})
