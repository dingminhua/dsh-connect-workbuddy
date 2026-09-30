import { describe, expect, it } from 'vitest'
import {
  announcedBatchCount,
  draftBaseFor,
  effectiveMemberIds,
  ghostMemberIds,
  intervalEditOnInput,
  POOL_INTERVAL_MAX,
  POOL_INTERVAL_MIN,
  parseIntervalInput,
  poolErrorText,
  poolFailureText,
  rotationLockState,
  usableMemberIds,
} from '../src/client/pool-state.ts'
import { en, zh } from '../src/client/locales.ts'

const saved = {
  enabled: true,
  rotateByCredits: true,
  autoTestIntervalMinutes: 30,
  targetModelId: '',
  memberAccountIds: ['a'] as readonly string[],
}

describe('rotationLockState (H-2)', () => {
  it('locks from the COMMITTED state, not the draft', () => {
    // The defect: a draft-based lock let one click of "turn off rotation"
    // re-enable the manual dropdown while the Host kept rotating — so the user
    // could pick an account, see it marked current, and have a DIFFERENT one
    // billed.
    const draft = { ...saved, rotateByCredits: false }
    const state = rotationLockState(saved, draft)
    expect(state.locked).toBe(true)
  })

  it('reports the pending unlock so the UI explains why it is still disabled', () => {
    // Without this the still-disabled dropdown reads as "the button did
    // nothing".
    const draft = { ...saved, rotateByCredits: false }
    expect(rotationLockState(saved, draft).unlockPending).toBe(true)
  })

  it('unlocks only once the change is committed', () => {
    const committed = { ...saved, rotateByCredits: false }
    const state = rotationLockState(committed, committed)
    expect(state.locked).toBe(false)
    expect(state.unlockPending).toBe(false)
  })

  it('does not lock when the pool itself is off', () => {
    // Rotation cannot own the choice if the pool is not running at all.
    const off = { ...saved, enabled: false }
    expect(rotationLockState(off, off).locked).toBe(false)
  })

  it('does not lock when rotation is off', () => {
    const noRotate = { ...saved, rotateByCredits: false }
    expect(rotationLockState(noRotate, noRotate).locked).toBe(false)
  })

  it('reports no pending unlock when the draft turns the POOL off instead', () => {
    // Turning the whole pool off also stops rotation, so the pending state is
    // still reported (the lock applies until saved) — but it must not claim the
    // user is only mid-unlock if they are not.
    const draft = { ...saved, enabled: false }
    const state = rotationLockState(saved, draft)
    expect(state.locked).toBe(true)
    expect(state.unlockPending).toBe(true)
  })

  it('is not pending while the draft still matches the committed state', () => {
    expect(rotationLockState(saved, saved).unlockPending).toBe(false)
  })
})

describe('draftBaseFor (H-1)', () => {
  it('uses the FRESH saved preferences when no draft exists', () => {
    // The defect: the callback captured `saved` when it was built, and its
    // dependency list omitted a field added later (`memberAccountIds`), so
    // checking one account silently dropped another saved in between.
    const fresh = { ...saved, memberAccountIds: ['a', 'b'] }
    expect(draftBaseFor(null, undefined, 'cn', fresh)).toEqual(fresh)
  })

  it('keeps an existing draft for the SAME region', () => {
    const draft = { ...saved, memberAccountIds: ['x'] }
    expect(draftBaseFor(draft, 'cn', 'cn', saved)).toEqual(draft)
  })

  it('ignores a draft made on the OTHER region', () => {
    // The two pools are independent; one region's unsaved edits must never seed
    // the other's.
    const draft = { ...saved, memberAccountIds: ['from-global'] }
    const globalSaved = { ...saved, memberAccountIds: ['cn-account'] }
    expect(draftBaseFor(draft, 'global', 'cn', globalSaved)).toEqual(globalSaved)
  })

  it('preserves a member added by an earlier edit', () => {
    // The end-to-end shape of the original bug: two sequential checks.
    let base = draftBaseFor(null, undefined, 'cn', { ...saved, memberAccountIds: ['a'] })
    base = { ...base, memberAccountIds: [...base.memberAccountIds, 'b'] }
    const next = draftBaseFor(base, 'cn', 'cn', { ...saved, memberAccountIds: ['a'] })
    expect(next.memberAccountIds).toEqual(['a', 'b'])
  })
})

describe('effectiveMemberIds (H-5)', () => {
  const listed = new Set(['a', 'b'])
  it('trusts the Host answer while the draft is clean', () => {
    expect(effectiveMemberIds({
      savedEffective: ['a'],
      draftMembers: ['a'],
      listedIds: listed,
      dirty: false,
    })).toEqual(['a'])
  })

  it('derives from the draft while the draft is dirty', () => {
    // The Host's answer describes the SAVED state, so it would ignore the edit
    // the user is looking at.
    expect(effectiveMemberIds({
      savedEffective: ['a'],
      draftMembers: ['a', 'b'],
      listedIds: listed,
      dirty: true,
    })).toEqual(['a', 'b'])
  })

  it('drops a ghost id from the derived answer', () => {
    expect(effectiveMemberIds({
      savedEffective: [],
      draftMembers: ['a', 'ghost'],
      listedIds: listed,
      dirty: true,
    })).toEqual(['a'])
  })

  it('reports NOTHING for a ghost-only pool', () => {
    // This is the case that enabled both buttons over zero real accounts.
    expect(effectiveMemberIds({
      savedEffective: [],
      draftMembers: ['ghost'],
      listedIds: listed,
      dirty: true,
    })).toEqual([])
  })

  it('returns a copy, so a caller cannot mutate the Host answer', () => {
    const savedEffective = ['a']
    const result = effectiveMemberIds({ savedEffective, draftMembers: [], listedIds: listed, dirty: false })
    result.push('x')
    expect(savedEffective).toEqual(['a'])
  })
})

describe('ghostMemberIds (H-5)', () => {
  it('names saved ids with no sign-in', () => {
    expect(ghostMemberIds(['a', 'ghost'], new Set(['a']))).toEqual(['ghost'])
  })

  it('is empty when every saved id resolves', () => {
    expect(ghostMemberIds(['a'], new Set(['a']))).toEqual([])
  })
})

describe('announcedBatchCount (H-5, last exit)', () => {
  it('counts the RESOLVABLE members, not the raw saved list', () => {
    // The defect: the log counted `saved.memberAccountIds`, so a ghost-only pool
    // announced "checking in 1 account(s)" and the Host then refused with 409
    // having touched nothing. The announcement must match the Host's resolution.
    expect(announcedBatchCount({
      savedEffective: [],
      savedMembers: ['ghost'],
    })).toBe(0)
  })

  it('counts every saved member when all of them resolve', () => {
    expect(announcedBatchCount({
      savedEffective: ['a', 'b'],
      savedMembers: ['a', 'b'],
    })).toBe(2)
  })

  it('falls back to the saved list for a Host that does not send the field', () => {
    // Same fallback the route uses (`effective ?? saved`): an old Host is no
    // worse than before, and the count still describes what will run.
    expect(announcedBatchCount({
      savedEffective: undefined,
      savedMembers: ['a', 'b'],
    })).toBe(2)
  })

  it('does NOT count a draft-only edit, which the Host would not run', () => {
    // The opposite error: `effectiveMembers` is draft-aware, so using it here
    // would announce unsaved edits. This helper deliberately reads the SAVED
    // pair only.
    expect(announcedBatchCount({
      savedEffective: ['a'],
      savedMembers: ['a'],
    })).toBe(1)
  })
})

describe('usableMemberIds (M-9 / C4-3)', () => {
  const accounts = [
    { accountId: 'member-ok' },
    { accountId: 'member-limited', excludedBy: 'rate-limited' },
    { accountId: 'unchecked' },
  ]

  it('counts only MEMBERS, so the warning is reachable', () => {
    // The defect: judging over the whole table meant any unchecked sign-in kept
    // the count above zero, so "no usable account" never appeared — exactly
    // when every member was limited and the explanation was needed.
    expect(usableMemberIds(accounts, ['member-limited'], ['member-limited'])).toEqual([])
  })

  it('reports a usable member', () => {
    expect(usableMemberIds(accounts, ['member-ok'], ['member-ok'])).toEqual(['member-ok'])
  })

  it('never counts an unchecked account, however healthy', () => {
    // `unchecked` has no `excludedBy`, so the old whole-table logic counted it.
    expect(usableMemberIds(accounts, [], [])).toEqual([])
  })
})
describe('parseIntervalInput (M-2 / A-4: the field must be typeable)', () => {
  it('passes a value inside the range through unchanged', () => {
    // The defect this pins: clamping on every keystroke and writing the result
    // back into a controlled value turned "120" into "520" — typing the second
    // digit appended to the already-clamped 5 the first digit produced.
    expect(parseIntervalInput('120')).toBe(120)
  })

  it('accepts every intermediate prefix of a longer number', () => {
    // Typing "120" passes through "1" and "12". If either were rejected or
    // rewritten, the field would fight the user; the helper must return the
    // CLAMPED value while still letting the text stand, so the caller decides.
    expect(parseIntervalInput('1')).toBe(5)
    expect(parseIntervalInput('12')).toBe(12)
  })

  it('clamps below the minimum and above the maximum', () => {
    expect(parseIntervalInput('0')).toBe(5)
    expect(parseIntervalInput('3')).toBe(5)
    expect(parseIntervalInput('9999')).toBe(1440)
  })

  it('reports undefined for text that is not a whole number', () => {
    // undefined means "leave the user's text alone" — the caller must NOT fold
    // a number into the draft, and must not rewrite the control.
    expect(parseIntervalInput('')).toBeUndefined()
    expect(parseIntervalInput('-')).toBeUndefined()
    expect(parseIntervalInput('1.5')).toBeUndefined()
    expect(parseIntervalInput('12e')).toBeUndefined()
    expect(parseIntervalInput('abc')).toBeUndefined()
  })

  it('agrees with the Host schema bounds', () => {
    // src/index.ts:390 declares min(5).max(1440); a card that allowed anything
    // else would save a value the Host rejects.
    expect(POOL_INTERVAL_MIN).toBe(5)
    expect(POOL_INTERVAL_MAX).toBe(1440)
  })
})

describe('intervalEditOnInput (M-2 wiring: the field must not rewrite what was typed)', () => {
  it('keeps the raw keystroke as the text, never a re-serialized number', () => {
    // The pure helper alone did not protect the field: the verification reverted
    // the CARD's wiring (display `String(parsed)` instead of the raw entry) and
    // the whole suite stayed green. This pins the pairing that makes `120`
    // typeable: text === what the user typed, even when the commit is clamped.
    expect(intervalEditOnInput('120').text).toBe('120')
    // The trap case: '1' commits as 5 (below the minimum) but MUST still display
    // '1', or the next keystroke appends to the 5 and '120' becomes '520'.
    expect(intervalEditOnInput('1')).toEqual({ text: '1', commit: 5 })
    expect(intervalEditOnInput('12')).toEqual({ text: '12', commit: 12 })
    expect(intervalEditOnInput('120')).toEqual({ text: '120', commit: 120 })
  })

  it('keeps an unparseable entry on screen and commits nothing', () => {
    // Clearing the field must NOT snap it to 5 while the user is mid-edit.
    expect(intervalEditOnInput('')).toEqual({ text: '', commit: undefined })
    expect(intervalEditOnInput('12e')).toEqual({ text: '12e', commit: undefined })
  })
})

/**
 * A `t` that returns the KEY, so a test asserts which copy was chosen rather
 * than what it says. Locale PROSE is covered separately below by checking the
 * tables directly — that split is deliberate: the branch rule and the copy can
 * each break on their own.
 */
const keyT = ((key: string) => key) as never

describe('poolErrorText (H7/H8: the client branch had no guard at all)', () => {
  it('maps every structured cause to its own key', () => {
    // The independent verification deleted the `no-live-members` branch and the
    // whole 618-test suite still passed, because this function lived inside the
    // browser-only `.tsx` card. Each cause is spelled out so a branch deleted
    // from the switch is a failure rather than a silent fallback.
    expect(poolErrorText(keyT, 'pool-disabled')).toBe('row.poolErrDisabled')
    expect(poolErrorText(keyT, 'no-members')).toBe('row.poolErrNoMembers')
    expect(poolErrorText(keyT, 'no-live-members')).toBe('row.poolErrNoLiveMembers')
    expect(poolErrorText(keyT, 'no-free-model')).toBe('row.poolErrNoFreeModel')
    expect(poolErrorText(keyT, 'target-model-stale')).toBe('row.poolErrStaleModel')
    expect(poolErrorText(keyT, 'pool-unavailable')).toBe('row.poolErrUnavailable')
  })

  it('falls back to undefined for a cause it does not know', () => {
    // undefined is the contract: the caller then shows the Host's own words, so
    // a cause added upstream stays visible instead of being swallowed.
    expect(poolErrorText(keyT, 'some-future-reason')).toBeUndefined()
    expect(poolErrorText(keyT, undefined)).toBeUndefined()
  })

  it('does not mistake the empty string for a known cause', () => {
    expect(poolErrorText(keyT, '')).toBeUndefined()
  })
})

describe('the locale tables carry every pool error key (H8)', () => {
  /**
   * Every key `poolErrorText` can return, spelled out rather than derived: a
   * self-updating list would hide a key that was added to the switch but never
   * written into the tables — which is exactly the failure being guarded.
   */
  const REQUIRED = [
    'row.poolErrDisabled',
    'row.poolErrNoMembers',
    'row.poolErrNoLiveMembers',
    'row.poolErrNoFreeModel',
    'row.poolErrStaleModel',
    'row.poolErrUnavailable',
    'row.poolErrFailed',
    'row.poolErrHttp',
  ] as const

  it('has each key in BOTH tables, in both languages', () => {
    // The verification deleted both locale copies of `row.poolErrNoLiveMembers`
    // and the suite stayed green. Deleting either language is a real defect: an
    // English user would see a missing key, a Chinese user untranslated prose.
    for (const key of REQUIRED) {
      expect(en[key], `en missing ${key}`).toBeTypeOf('string')
      expect(zh[key], `zh missing ${key}`).toBeTypeOf('string')
      expect(en[key].length).toBeGreaterThan(0)
      expect(zh[key].length).toBeGreaterThan(0)
    }
  })

  it('actually translates the pool errors, rather than copying English into zh', () => {
    // A placeholder `zh` entry equal to the English one is the cheapest way to
    // satisfy a key-presence check while shipping English to a Chinese user.
    for (const key of REQUIRED) {
      expect(zh[key], `zh ${key} is identical to en`).not.toBe(en[key])
    }
  })

  it('keeps the two languages in exact key parity', () => {
    // `zh` is typed `Record<WorkBuddySettingsKey, string>` so TypeScript
    // enforces this — but a type error is not a test failure in a build that
    // does not typecheck before bundling, so it is asserted here too.
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})

describe('poolFailureText (the three-tier resolution, incl. the unguarded status tier)', () => {
  it('prefers the localized structured cause over the Host English', () => {
    expect(poolFailureText(keyT, {
      status: 409,
      reason: 'no-live-members',
      error: 'no checked account still has a local sign-in',
    })).toBe('row.poolErrNoLiveMembers')
  })

  it('falls back to the Host text for a cause it does not know', () => {
    // A cause added upstream must stay visible rather than being swallowed into
    // a generic message.
    expect(poolFailureText(keyT, {
      status: 500,
      reason: 'some-future-reason',
      error: 'upstream exploded',
    })).toBe('upstream exploded')
  })

  it('localizes by STATUS when there is no reason and no error at all', () => {
    // The tier that had no guard: reverting the card to `` `HTTP ${status}` ``
    // left all 633 tests green. Every pool exit with no reason — 405, 403, 400,
    // and the generic 500 — reached a Chinese user as bare English.
    expect(poolFailureText(keyT, { status: 405 })).toBe('row.poolErrHttp')
  })

  it('passes the status through so the message can name it', () => {
    // The key alone is not enough: the rendered sentence interpolates the
    // status, so the substitution must carry the REAL code, not a placeholder.
    const seen: Record<string, unknown>[] = []
    const spy = ((key: string, params?: Record<string, unknown>) => {
      seen.push({ key, ...params })
      return key
    }) as never
    poolFailureText(spy, { status: 403 })
    expect(seen[0]?.['key']).toBe('row.poolErrHttp')
    expect(seen[0]?.['status']).toBe('403')
  })

  it('never returns an empty string', () => {
    // An empty message would render as a blank error line.
    expect(poolFailureText(keyT, { status: 500 }).length).toBeGreaterThan(0)
  })

  it('treats a reason with no matching branch as unknown, not as the reason text', () => {
    expect(poolFailureText(keyT, { status: 409, reason: 'unmapped' })).toBe('row.poolErrHttp')
  })
})
