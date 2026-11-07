/**
 * The stylesheets are TEMPLATE LITERALS, so a mistake in them is a runtime error
 * or a silently broken cascade rather than a compile error.
 *
 * THE DEFECT THIS EXISTS FOR: while rewriting the pool row's narrow layout, one
 * extra `}` closed the `@container` block twice. `tsc` passed, the build passed,
 * and every unit test passed — then the running app's Settings panel came up
 * unusable: one stray brace makes the parser skip the rules that follow, and the
 * page rendered as a huge black circle over itself.
 *
 * Neither type checking nor a "does the string contain X" assertion can catch
 * that, because the string is still a valid string. What CAN catch it is counting:
 * braces must balance, and every selector block must close.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'styles.ts'),
  'utf8',
)

/** Every `const NAME = \`…\`` stylesheet in the file. */
function sheets(): { name: string, css: string }[] {
  const out: { name: string, css: string }[] = []
  for (const match of source.matchAll(/(\w+)\s*=\s*`([\s\S]*?)`/g)) {
    const name = match[1]
    const css = match[2]
    // Only stylesheets: the module also builds tiny class-name strings.
    if (name === undefined || css === undefined) continue
    if (css.includes('{')) out.push({ name, css })
  }
  return out
}

describe('the style template literals are structurally sound', () => {
  it('finds the stylesheets at all', () => {
    // A guard on the guard: a refactor that renames the constants would make
    // every assertion below vacuously true over an empty list.
    expect(sheets().length, 'no stylesheet template literals found').toBeGreaterThan(0)
  })

  for (const { name } of sheets()) {
    it(`${name} balances its braces`, () => {
      const css = sheets().find(sheet => sheet.name === name)!.css
      const open = (css.match(/\{/g) ?? []).length
      const close = (css.match(/\}/g) ?? []).length
      // A surplus `}` is the exact shape of the Settings-panel breakage; a
      // missing one silently swallows every rule after it.
      expect(close, `${name} has ${open} '{' but ${close} '}'`).toBe(open)
    })

    it(`${name} never lets its depth go negative`, () => {
      const css = sheets().find(sheet => sheet.name === name)!.css
      let depth = 0
      let line = 1
      for (const character of css) {
        if (character === '\n') line += 1
        else if (character === '{') depth += 1
        else if (character === '}') {
          depth -= 1
          // Going negative means a rule closed before it opened: from here on the
          // parser and the author disagree about where blocks begin, which is
          // what turned the Settings panel into one black circle.
          expect(depth, `${name} closes a block that was never opened, near line ${line}`)
            .toBeGreaterThanOrEqual(0)
        }
      }
    })
  }

  it('contains no backtick inside a stylesheet', () => {
    // The other way this file breaks: a backtick in a CSS comment ENDS the
    // template literal, and the remainder becomes JavaScript. It bit this project
    // three times in one session. The regex above splits on backticks, so a stray
    // one shows up as a stylesheet that suddenly fails to balance — this test
    // names the cause instead.
    for (const { name, css } of sheets()) {
      expect(css.includes('`'), `${name} contains a backtick, which ends the literal`)
        .toBe(false)
    }
  })
})
