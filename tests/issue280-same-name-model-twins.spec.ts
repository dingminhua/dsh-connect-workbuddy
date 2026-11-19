/**
 * Issue #280 — the international catalog showed two rows with the SAME name
 * (`Deepseek-V4.1-Flash`), one free and one paid; the picker/card could not tell
 * which one the user had selected when the personal-centre bill showed the paid
 * twin being charged.
 *
 * The plugin cannot know which rate is correct — that is a fact about the
 * upstream, and it changes (see issue #214). What it CAN do is make the two rows
 * tell themselves apart, using the one fact that is stable and local: their ids.
 * The fix is therefore DATA-DRIVEN: any two rows sharing a name are qualified
 * with their ids in both the DSH-facing display name (`workBuddyDisplayName`)
 * and the card's row rendering (`qualifyName`). No model id is hardcoded, and
 * no rate is guessed or rewritten — routing and billing stay byte-for-byte.
 *
 * The id qualifier is placed BEFORE the ` · x<rate>` suffix that the picker's
 * `splitCatalogRate` strips, so the picker still draws exactly one rate (issue
 * #120) and the qualifier survives as part of the base name.
 *
 * All names/ids below are invented; none refers to a real account or session.
 *
 * @module dsh-connect-workbuddy/tests/issue280-same-name-model-twins
 */

import { describe, expect, it } from 'vitest'
import {
  ambiguousNameIds as hostAmbiguousIds,
  workBuddyDisplayName,
} from '../src/adapter.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'
import {
  ambiguousNameIds as clientAmbiguousIds,
  qualifyName,
} from '../src/client/model-name-collision.ts'

function row(id: string, name: string, rate?: number): WorkBuddyModelInfo {
  return {
    id,
    name,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    ...rate === undefined ? {} : { creditMultiplier: rate },
  }
}

const TWINS = [
  row('deepseek-v4.1-flash', 'Deepseek-V4.1-Flash', 0),
  row('deepseek-v4.1-flash-sg', 'Deepseek-V4.1-Flash', 0.03),
]

describe('same-name twin disambiguation (issue #280)', () => {
  it('detects a name collision by data, for both host and client halves', () => {
    expect([...hostAmbiguousIds(TWINS)].sort()).toEqual([
      'deepseek-v4.1-flash',
      'deepseek-v4.1-flash-sg',
    ])
    expect([...clientAmbiguousIds(TWINS)].sort()).toEqual([
      'deepseek-v4.1-flash',
      'deepseek-v4.1-flash-sg',
    ])
  })

  it('leaves unique names alone', () => {
    const roster = [row('hy3', 'Hy3', 0), row('glm-5.3', 'GLM-5.3', 0.69)]
    expect(hostAmbiguousIds(roster).size).toBe(0)
    expect(clientAmbiguousIds(roster).size).toBe(0)
  })

  it('qualifies BOTH colliding rows in the DSH-facing name', () => {
    const ids = hostAmbiguousIds(TWINS)
    const names = TWINS.map(model => workBuddyDisplayName(model, ids))
    expect(names[0]).toBe('Deepseek-V4.1-Flash (deepseek-v4.1-flash) · x0.00')
    expect(names[1]).toBe('Deepseek-V4.1-Flash (deepseek-v4.1-flash-sg) · x0.03')
    expect(names[0]).not.toBe(names[1])
  })

  it('keeps the historical name when no collision set is supplied', () => {
    // Single-model callers and every pre-existing test keep the old shape.
    expect(workBuddyDisplayName(TWINS[0]!)).toBe('Deepseek-V4.1-Flash · x0.00')
  })

  it('qualifies the card row without mutating the persisted name', () => {
    const ids = clientAmbiguousIds(TWINS)
    const model = TWINS[1]!
    const drawn = qualifyName(model.name, model.id, ids)
    expect(drawn).toBe('Deepseek-V4.1-Flash (deepseek-v4.1-flash-sg)')
    // The catalog name itself is untouched, so a card Save cannot persist the
    // draw-time suffix into `lastCatalog`.
    expect(model.name).toBe('Deepseek-V4.1-Flash')
  })

  it('detects a collision introduced by the upstream later, not a frozen id pair', () => {
    // A brand-new pair of rows that happen to share a name must be qualified
    // without any code change — the point of "data-driven, not a hardcoded id".
    const future = [row('a-new-free', 'Future-Flash'), row('a-new-paid', 'Future-Flash', 0.5)]
    const ids = hostAmbiguousIds(future)
    expect(future.map(model => workBuddyDisplayName(model, ids))).toEqual([
      'Future-Flash (a-new-free)',
      'Future-Flash (a-new-paid) · x0.50',
    ])
  })
})
