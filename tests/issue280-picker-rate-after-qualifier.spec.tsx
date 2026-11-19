// @vitest-environment jsdom
/**
 * Issue #280, picker side: qualifying a same-name model with its id must not
 * break the multiplier reader added in issue #120.
 *
 * The host renders `workBuddyDisplayName` verbatim, and the picker's
 * `splitCatalogRate` strips a trailing ` · x<rate>` before drawing exactly one
 * number. The id qualifier is deliberately placed BEFORE that suffix, so it
 * survives as part of the base name and the rate is still parsed once — with or
 * without a running promotion.
 */
import { describe, expect, it } from 'vitest'
import { workBuddyDisplayName } from '../src/adapter.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'
import { splitCatalogRate } from '../src/client/WorkBuddyModelLabel.tsx'

const PAID: WorkBuddyModelInfo = {
  id: 'deepseek-v4.1-flash-sg',
  name: 'Deepseek-V4.1-Flash',
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  creditMultiplier: 0.03,
}

const QUALIFIED = 'Deepseek-V4.1-Flash (deepseek-v4.1-flash-sg) · x0.03'

describe('the picker still draws one rate after a same-name qualifier (issue #280)', () => {
  it('keeps the id qualifier as the base and strips exactly one rate', () => {
    const name = workBuddyDisplayName(PAID, new Set([PAID.id]))
    expect(name).toBe(QUALIFIED)
    expect(splitCatalogRate(name, 0.03, undefined)).toEqual({
      base: 'Deepseek-V4.1-Flash (deepseek-v4.1-flash-sg)',
      rate: 0.03,
    })
    expect(name.match(/x\d/gu)).toHaveLength(1)
  })

  it('still shows the discounted rate while a promotion runs', () => {
    expect(splitCatalogRate(QUALIFIED, 0.03, 0.01)).toEqual({
      base: 'Deepseek-V4.1-Flash (deepseek-v4.1-flash-sg)',
      rate: 0.01,
    })
  })
})
