# I — Round-4 verification (adversarial, teammate `round4-verify`)

> Verifier: `round4-verify` (shared task `task-7`), independent of the Lead who wrote the fixes.
> Subject: the fourth-round fixes recorded in [E-fix-log.md](E-fix-log.md) §十二 — N1, N2, N3, N4,
> the M-2 card wiring, the D2 host-side `reason`, and the five guards hardened from "text exists"
> to "structure/position/value".
> **A green suite is the thing under test, not the thing to be trusted.** Every claim below is
> settled by a mutant that restores the defect, never by reading the fix.
>
> **This file is the only write this session made to the repository.** `src/` and `tests/` were
> never touched: all 11 frozen hashes verified identical before and after, and the shared tree's
> own digest is unchanged (see §7).

---

## 0. Headline

§12.7 claims **13/13 KILLED**. That table is **accurate about the 13 mutants it names** — I
reproduced 12 of them exactly, and the one that did not reproduce (#1) is a different mutant with
the same name.

But the claim that matters is the one §12.1 makes: that each guard was upgraded from
"文本存在" to "结构/位置/取值", so that a text-preserving mutation can no longer satisfy it.
**That claim is REFUTED for 6 of the 8 source-text guards.** I restored 18 real defects with the
suite at `Tests 655 passed (655)`, `Test Files 29 passed (29)` — and **all 18 also survive the full
`pnpm run check` gate** (`tsc -p tsconfig.json` and `tsc -p tsconfig.client.json` both exit 0), so
they are invisible to CI, not merely to vitest.

The eighteenth (**M41**, §3.2) was found after this report's first draft, while testing the guards'
*seams* rather than their assertions. It is worth naming here because of its shape: it re-opens the
exact defect the D5 guard's headline kill (M12) exists to close, by adding a decoy lambda parameter
that makes the guard **skip its own check for the name it is checking**. The guard's false-positive
suppression is applied body-wide, so the suppression is itself the bypass — and the same file shows
the mirror image: **M43** (N17), where the guard fails *legitimate* code because a name appears
inside a string literal.

The two most important results:

| | mutant | restored defect | suite |
| --- | --- | --- | --- |
| **M01** | `setIntervalText(text)` → `setIntervalText(commit === undefined ? text : String(commit))` | the user-reported A-4 `120`→`520` per-keystroke clamp | **655 green** |
| **M41** | `…, savedRef.current))` → add `const shadow = (saved: PoolPreferences) => saved.memberAccountIds`, then `…, saved))` | **M12's own defect**, verbatim, hidden behind a decoy lambda parameter that makes the D5 guard skip its check for `saved` | **655 green** |

This is the **user-reported** gap of the round — §12.3's "M-2 是本轮唯一需要改产品的缺口" — and it is
the mutant §12.7 lists as #1 `M-2-wiring-revert-v2`, **KILLED**. It survives. (The other product
defect fixed this round, N1 at §12.2, is also restored by mutants below: M15, M16.)

---

## 1. Method and discipline

- Five full copies, all verified byte-identical to the shared tree before and after every campaign:
  `/tmp/r4-mut`, `/tmp/r4-mut2`, `/tmp/r4-mut3`, `/tmp/r4-mut4`, `/tmp/r4-flake`
  (`rsync -a --exclude node_modules --exclude .git` + `ln -s` `node_modules`). Each digests to
  `e83f23752da73b1475abe4c2ec9bffd06b4b15808e901fe91215dd500871548a`.
- `/tmp/r4-run.sh <label> <patch-cmd>`: hashes `$MUT/src+tests` and the shared tree's `src+tests`
  **before and after**, runs the patch **inside** that window as
  `( cd "$MUT" && eval "$patch" )`, exits 5 if the shared tree changed, exits 4 on
  **NO-OP-PATCH** (identical hash = an error, never a pass), else runs `npx vitest run` and writes
  `/tmp/r4-out-<label>.txt`, then restores from `/tmp/r4-pristine` with `rsync --delete`.
- `/tmp/r4-patch.py` refuses any cwd that is not a `/tmp/r4-*` copy, and explicitly refuses
  `/tmp/r4-pristine` and the shared tree (both refusals re-verified live).
- Six environment variables isolated per `vitest.config.ts:39`
  (`DSH_HOME`/`HOME`/`USERPROFILE`/`LOCALAPPDATA`/`APPDATA`/`XDG_CONFIG_HOME` → `/tmp/r4-iso-home`).
- `/tmp/r4-typecheck.sh <label>` runs both `tsc` projects in the copy after patching, to separate
  "survives the tests" from "survives `pnpm run check`".

### 1.1 Three harness bugs I found and fixed (all three produced FALSE results first)

1. **Malformed patch → false survivor.** My generator's `SAVE_RET_A/B = 1140,1146` swallowed
   `src/index.ts:1145`, the closing `}` of `poolMemberAccounts`. Five mutants then produced
   `Transform failed with 1 error: [PARSE_ERROR] ... src/index.ts:1144:5 const wanted = new Set(saved)`,
   so 6 of 29 test files failed to load and 158 tests never ran. My kill criterion grepped only
   `Tests +[0-9]+ failed` and read that as GREEN. **Corrected range: `1138,1144`.**
   *Lesson: a collection/transform failure is an INVALID MUTANT, never a green suite.*
2. **The INVALID-MUTANT detector was itself wrong** — it matched `Test Files +[0-9]+ failed`, the
   exact string a normal kill prints (`Test Files 1 failed | 28 passed`), so it flagged 22 healthy
   kills as invalid. Replaced with the load-error signature only:
   `Transform failed|PARSE_ERROR|Failed to load|SyntaxError`.
3. **Load-induced flake contaminates parallel runs.** `tests/pool-e2e.spec.ts:403`
   (`arms on the first tick, then probes and re-ranks once the interval passes`) fails
   intermittently under CPU contention at `tests/pool-e2e.spec.ts:474`
   `expect(probes).toBeGreaterThanOrEqual(1)` → `AssertionError: expected 0 to be greater than or
   equal to 1`. The test's own comment (`tests/pool-e2e.spec.ts:468-473`) says it needs
   `await flushRealWork()` macrotask turns after `vi.advanceTimersByTimeAsync(5 * 60_000)`.
   **Measured: 10/10 pristine serial runs green** on the dedicated copy; the same test failed inside
   unrelated mutants under 4-way parallelism. **All verdicts below come from SERIAL runs**; the
   first 4-way parallel campaign (22 KILLED / 12 SURVIVED) is discarded as contaminated.
   *Lesson for the next verifier: `vitest run` on this repo is only a verdict when run serially.*

**Accounting.** 44 vitest runs, in two waves.

- **41 mutants restore a real defect.** Of those: **23 KILLED, 18 SURVIVED**. (The first wave was 34
  mutants → 21/13; the second added M35–M40, of which M37 and M40 died, M35/M36/M38b/M39 lived.)
- **M38** is not one of them: it duplicated a `catch` clause, so it is an **INVALID MUTANT** for the
  suite and is counted separately. Its repaired twin **M38b** is a real survivor.
- **M42 and M43** are not defect restorations either — they are *guard-robustness probes* of the D5
  derived-binding guard, run to test the seam between "the guard catches things" and "the guard is
  right". M42 is a control (green, inconclusive) and **M43 is a guard FALSE POSITIVE**: it is
  legitimate code that the guard rejects. Both are reported in §3.2 and N17.

### 1.2 Corrections I made to this report after writing it

Recorded because a verifier's own claims deserve the same treatment as the ones it audits. Each was
found by re-reading the cited source rather than trusting my first note:

1. **M24's mechanism was wrong in the first draft.** I had written that `poolErrorText` has no
   `pool-failed` case, so the rename would fall back to raw English. It *does* have one
   (`src/client/pool-state.ts:173`). The mutant is still a real defect, but a worse-shaped one: the
   card renders a confident, localized, **wrong** sentence ("a batch failed") for a check-in route
   that is merely missing. §N11 and §3 corrected.
2. **Line numbers in the §3 patch table were transcribed from patch offsets, not from the patched
   file.** M14 `539`→`542`, M16 `546`→`545`, M17 `1091`→`1090`, M20 `281,552`→`297,575`,
   M21 `568`→`561-563`, M22 `281,706`→`297,385`, M35 `477,494`→`478-479,496`. Each was re-derived by
   applying the patch in a scratch copy and grepping the result.
3. **"Sixteen of 17 also pass `pnpm run check`" was wrong — all of them do.** The sixteenth was M38,
   the malformed form that is not in the 17 at all; its twin M38b is typecheck-clean. (At the time
   of this correction the count was 17; it is 18 after M41 — and M41 is typecheck-clean too.)
4. **The §4 coverage table's guard line for M18/M19 was off by one to three lines** (`986`→`985`,
   `1025`→`1022`, and the M-2 wiring pair `1243-1246`→`1249-1250`).
5. **The D6 guard has two distinct negative messages and I conflated them.** `:1096` is
   `'poolMemberAccounts re-inlined the filter'` and `:1107` is
   `'poolMemberAccounts re-inlined the membership test'`. The report now attributes each assertion
   to its own site.
6. **The report originally stopped at the guards' *assertions* and never tested their *seams*.**
   That is where **M41** (the D5 skip rules are body-wide, so a decoy lambda parameter disables the
   check for that name — §3.2) and **M43** (rule 2 matches a name inside a string literal, so the
   guard fails legitimate code — N17) came from. A guard can be defeated by what it ignores just
   as easily as by what it fails to assert, and the two failure modes have opposite fixes: N5–N13
   need *more* checking, N16/N17 need *less*.

---

## 2. Verdict table

### 2.1 The 13 mutants named in §12.7

| # | §12.7 claim | My verdict | Evidence |
| --- | --- | --- | --- |
| 1 | `M-2-wiring-revert-v2` KILLED | **REFUTED** | **M01 SURVIVED**, 655 green. The guard's regex requires `String(` immediately after `setIntervalText(`; a ternary wrapper defeats it. §12.7 also quotes the assertion as `to contain 'const { text, commit } = intervalEdit…'` — that assertion is present, and M01 keeps it. |
| 2 | `M-D2-drop-reason` KILLED | **PARTIALLY CONFIRMED** | M02 (no-pool-support branch) KILLED. But §12.7 says "**四处** 503/500 全部断言 `body()['reason']`" — only **three** of the four are. `src/web-status.ts:857` (the `checkin` branch) is asserted by nothing: **M36 SURVIVED** (delete the field), **M24 SURVIVED** (rename it). |
| 3 | `M-D5-save-reads-pool-undeclared` KILLED | **CONFIRMED** | M03 KILLED — `declares every prop callback its useCallbacks read (D5, generalised)`. |
| 4 | `M-M4-refresh-also-in-finally` KILLED | **PARTIALLY CONFIRMED** | M04 KILLED (`expected 2 to be 1`). The *guard* is defeated by respelling the call: **M39 SURVIVED** (`onRefresh?.call(undefined)` in `finally`). |
| 5 | `M-L5-success-guard-moved` KILLED | **PARTIALLY CONFIRMED** | M05, M31 KILLED (positions are now checked). The *guard* is defeated by neutering the token instead of moving the check: **M19 SURVIVED**. |
| 6 | `M-A8-committed-true` KILLED | **PARTIALLY CONFIRMED** | M06 KILLED (`expected 'let committed = true' to be 'let committed = false'`). The initialiser is read now — but nothing checks the **catch** block: **M16 SURVIVED** (`committed = true` inside `catch`). |
| 7 | `M-D6-comment-only` KILLED | **CONFIRMED** (verdict) / **stale evidence** | M07 KILLED, but the decisive assertion §12.7 quotes (`to match /const live = new Set\(effectiveMembe…/u`) **does not exist in `tests/`** — it is the *first* version's assertion, retained only as a comment at `tests/pool-e2e.spec.ts:1099`. The assertion that actually kills M07 is `poolMemberAccounts re-inlined the filter` (`:1096`). The verdict is right; the citation is from a superseded guard. |
| 8 | `M-N1-bailout-removed` KILLED | **PARTIALLY CONFIRMED** | M08 KILLED. The guard asserts the bail-out *precedes* the commit, but not that it *returns*: **M14 SURVIVED** (drop the `return`, keep the text). |
| 9 | `N3a-deceptive-shape-restored` KILLED | **CONFIRMED** | M09 KILLED — `does not return the shared rule's answer`. |
| 10 | `N3b-rule-body-emptied` KILLED | **CONFIRMED** | M10 KILLED, 9 tests — including the behavioural `expected [] to deeply equal [ 'a', 'c' ]`. |
| 11 | `N3c-inlined-saved-filter` KILLED | **CONFIRMED** | M11 KILLED. |
| 12 | `N4a-editDraft-reads-saved` KILLED | **PARTIALLY CONFIRMED** | M12 KILLED. The *guard* is defeated by aliasing: **M35 SURVIVED** (`const { memberAccountIds: aliasedIds } = saved`). |
| 13 | `N4b-runAction-reads-savedEffective` KILLED | **CONFIRMED** | M13 KILLED. |

Tally: **7 CONFIRMED**, **6 PARTIALLY CONFIRMED** (the named mutant dies, but the guard is defeated
by a nearby respelling), **1 REFUTED**. One of the 7 confirmations carries a *citation* defect rather
than a verdict defect (#7 — see the table).

### 2.2 The five hardened guards + the new N1/N3/N4 guards, judged as guards

| Guard | Site | Kind | Verdict | Defeating mutant |
| --- | --- | --- | --- | --- |
| M-4 exactly-once | `tests/pool-e2e.spec.ts:980` | source-text | **DEFEATED** | M39 `onRefresh?.call(undefined)` |
| L-5 positional | `tests/pool-e2e.spec.ts:1011` | source-text | **DEFEATED** | M19 `const fresh = () => usageGuard.current.begin(region)()` |
| D6 call-shape | `tests/pool-e2e.spec.ts:1055` | source-text | **DEFEATED** | M28 string literal + renamed filter |
| A-8 initialiser + precedence | `tests/pool-e2e.spec.ts:1111` | source-text | **DEFEATED** | M16 (commit in `catch`), M14 (bail-out without `return`) |
| D5 generalised | `tests/pool-e2e.spec.ts:1158` | source-text | **DEFEATED** | M35, M20, M21, M22 (four distinct aliases) |
| M-2 wiring | `tests/pool-e2e.spec.ts:1235` | source-text | **DEFEATED** | M01 (ternary), M38b (`void text` + recompute) |
| batch-callback deps | `tests/pool-e2e.spec.ts:282` | source-text | **HELD** | M13 died; no defeat found |
| latest-wins import | `tests/pool-e2e.spec.ts:1229` | source-text | **NOT ATTACKED** | — |
| D2 host `reason` (3 of 4 sites) | `tests/pool-route.spec.ts:229/276/341/387/399/407/417` | **behavioural** | **HELD** | M40 (all four deleted) → 3 failures; M37 → 1; M25, M27 died |
| `effectiveMembersOf` rule | `tests/account-pool.spec.ts:559` | **behavioural** | **HELD** | M10 → 9 failures |
| `effectiveMemberIds` (H-5) | `tests/pool-state.spec.ts:108` | **behavioural** | **HELD** | M10 |
| `poolErrorText` | `tests/pool-state.spec.ts:297` | **behavioural** | **HELD** | M27 |

**Six of the eight source-text guards were defeated.** Every guard that actually *drives* the code
held. That is the whole finding: the discriminator is not how clever the regex is, it is whether
the assertion executes the behaviour.

---

## 3. The 18 surviving mutants

All 18: `Test Files 29 passed (29)`, `Tests 655 passed (655)`, **and** `tsc -p tsconfig.json` exit 0
**and** `tsc -p tsconfig.client.json` exit 0. They defeat the whole `pnpm run check` gate, not merely
`vitest`. The only mutant in the campaign that a typecheck caught was the *malformed first form* of
the M-2 bypass (M38, `error TS2552: Cannot find name 'parseIntervalInput'`) — it is not one of the
18, and its corrected twin **M38b** is.

| Label | File | Patch (exact) | Restored defect | tsc |
| --- | --- | --- | --- | --- |
| **M01** | `src/client/AccountPool.tsx:593` | `setIntervalText(text)` → `setIntervalText(commit === undefined ? text : String(commit))` | A-4: the field renders the re-serialized clamped number, so typing `120` shows `5 → 52 → 520` | clean |
| **M14** | `src/client/AccountPool.tsx:542` | the bare `return` inside `if (refreshed === false) {` → `if (mounted.current) setSaveError(t('row.poolSavedStaleRefresh'))` | N1: a failed re-read falls through to `committed = true` + `discard()`, so the draft is thrown away against a stale `saved` prop | clean |
| **M15** | `src/client/WorkBuddyCard.tsx:412` | `return undefined` (in `catch`) → `return {} as WorkBuddyWebUsage` | N1 at the source: a failed re-read reports success, so `onSaved` resolves `true` | clean |
| **M16** | `src/client/AccountPool.tsx:545` | `} catch (error: unknown) {` + `committed = true` as the first statement of the handler | A-8: a **failed WRITE** discards the draft — real data loss (the draft is the only copy) | clean |
| **M17** | `src/client/AccountPool.tsx:1090` | `value: intervalText ?? String(active.autoTestIntervalMinutes),` → that line commented out + `value: String(active.autoTestIntervalMinutes),` | the displayed value ignores the raw keystroke entirely | clean |
| **M18** | `src/client/WorkBuddyCard.tsx:1292` | `onRefresh={() => { void refreshUsage(activeRegion) }}` → `onRefresh={() => {}}` | M-4: the panel never re-reads usage after a batch; pre-check-in credits stay on screen | clean |
| **M19** | `src/client/WorkBuddyCard.tsx:386` | `const fresh = usageGuard.current.begin(region)` → `const fresh = () => usageGuard.current.begin(region)()` | L-5: every freshness check returns `true`, so a slow stale response always wins | clean |
| **M20** | `src/client/AccountPool.tsx:297,575` | `const savedNow = saved` at render scope; select-all also writes `targetModelId: savedNow.targetModelId,` | D5/H-1: a `useCallback` reads the render-scoped `saved` with no dependency | clean |
| **M21** | `src/client/AccountPool.tsx:561-563` | `const meta = { saved: saved.memberAccountIds }` then `new Set(meta.saved)` in `editDraft` | D5/H-1 through an object-literal value | clean |
| **M22** | `src/client/AccountPool.tsx:297,385` | `const regionNow = region` at render scope; `logStore.set(region, next)` → `logStore.set(regionNow, next)` | D5: `runAction` reads the `region` prop with no dependency | clean |
| **M23** | `src/web-status.ts:637-640` | swap the two arguments of `effectiveMembersOf` | N2: the status document's `effectiveMemberAccountIds` returns **saved order**, not roster order | clean |
| **M24** | `src/web-status.ts:857` | `reason: 'pool-unavailable'` → `reason: 'pool-failed'` | D2: the checkin 503 is mislabelled as a *batch* failure, so the user is told "批量操作在宿主侧失败：pool check-in unavailable" (a batch failed) when the truth is "this build has no check-in route" | clean |
| **M28** | `src/index.ts:1138-1144` | `const shape = 'return effectiveMembersOf('` + `void shape` + `const keep = new Set(saved)` + `return accounts.filter(account => keep.has(account.id))` | N3: `poolMemberAccounts` no longer delegates; the rule is decorative | clean |
| **M35** | `src/client/AccountPool.tsx:478-479,496` | `const { memberAccountIds: aliasedIds, targetModelId: aliasedTarget } = saved` + `const aliasedBase = {...}`; `editDraft` passes `{ ...savedRef.current, ...aliasedBase }` | D5/H-1: `editDraft` again reads the render-scoped `saved`, through a **destructure alias** | clean |
| **M36** | `src/web-status.ts:857` | delete `reason: 'pool-unavailable',` from the `checkin` 503 body | D2: the checkin path sends no reason at all | clean |
| **M38b** | `src/client/AccountPool.tsx:592` | keep `const { text, commit } = intervalEditOnInput(raw)`, add `void text`, then `setIntervalText(String(parseIntervalInput(raw) ?? POOL_INTERVAL_MIN))` (+ import) | A-4: the shared rule is *called* but its `text` is discarded and the clamp re-derived by hand | clean |
| **M39** | `src/client/AccountPool.tsx:709` | `onRefresh?.call(undefined)` added inside `finally` | M-4: `onRefresh` fires on a **failed** batch too, masking the error | clean |
| **M41** | `src/client/AccountPool.tsx:494-496` | `return edit(draftBaseFor(previous, draftRegion, region, savedRef.current))` → `const shadow = (saved: PoolPreferences): readonly string[] => saved.memberAccountIds` + `void shadow` + `return edit(draftBaseFor(previous, draftRegion, region, saved))` | D5/H-1 — **M12's defect verbatim** (a `useCallback` reads the render-scoped `saved` with no dependency), masked by a decoy lambda parameter named `saved` | clean |

### 3.1 The four survivors that matter most, in full

**M01 — the round's only product change, reverted.** The guard is
```js
expect(body, 'the field re-serializes a parsed number into the display')
  .not.toMatch(/setIntervalText\(\s*String\(/u)
```
The regex is anchored on the *first token after the paren*. `commit === undefined ? text :
String(commit)` puts a ternary there instead, and the string `String(` is still present — just not
first. Nothing in the guard ever asserts that `text` is what reaches `setIntervalText`. The
behaviour restored is exactly the one the JSDoc at `src/client/pool-state.ts:228-240` was written
to prevent: *"each keystroke's clamped `5` is rendered, and the next digit appends to it
(`120` → `520`)"*.

**M38b — the same defect without the ternary.** `const { text, commit } = intervalEditOnInput(raw)`
is kept verbatim (the guard's `toContain` is satisfied), the shared rule is still *called*, and
`void text` throws its answer away. The clamp is recomputed with `parseIntervalInput`. The
import is added so `tsc` is clean. This variant matters because it shows the guard cannot be
fixed by tightening the regex — a `toContain` on a destructuring pattern proves a call, never a
use.

**M16 — data loss, and the reason the A-8 guard is not enough.** The guard now reads the
initialiser verbatim (`expect(...).toBe('let committed = false')`) and asserts the bail-out
precedes `committed = true`. Both hold. But the *only* thing that keeps a failed write from
discarding the user's draft is that `committed` is never set on the `catch` path — and nothing
checks the `catch` path. Adding one line there restores the exact defect A-8 exists to close, with
the user's only copy of their edits destroyed.

**M35 — the alias that defeats the "generalised" guard.** §12.6 explicitly advertises this guard as
generalised beyond a hardcoded list. It is, for *props* — it reads them from the component's own
destructuring. But the derived-binding half is still the literal list
`['saved','active','dirty','listedIds','savedEffective','effectiveMembers','ghostMembers','usable',
'usableMemberSet','current']`, matched by word boundary. An alias introduces a name that is in
neither list, and all three of the guard's skip rules (lambda param, property read, object-literal
key) pass it through. M12 (the direct form) dies; M35, M20, M21 and M22 (four different spellings
of the same read) all live.

---

### 3.2 M41 — the eighteenth survivor, and the one that shows the guard defeating itself

M41 exists only to answer the question the rest of the campaign did not ask: **not "what does the
guard assert?" but "what makes the guard stop asserting?"** The D5 guard
(`tests/pool-e2e.spec.ts:1158-1226`) suppresses false positives with three skip rules, applied in
order to each derived binding name:

```js
if (new RegExp(`\\(\\s*${binding}\\b`, 'u').test(body)) continue        // (1) looks like a lambda parameter
if (!new RegExp(`(^|[^.\\w])${binding}\\b`, 'u').test(body)) continue   // (2) must be a free-variable read
if (new RegExp(`(^|[^.\\w])${binding}\\s*:`, 'u').test(body)) continue  // (3) object-literal key
```

Rule 1 is tested against `body` — the **entire** callback — not against the site where `binding` is
actually read. So one decoy lambda anywhere in the callback turns the check off for that name
everywhere in the callback. M41 supplies exactly that decoy:

```ts
const shadow = (saved: PoolPreferences): readonly string[] => saved.memberAccountIds
void shadow
return edit(draftBaseFor(previous, draftRegion, region, saved))   // ← the real read, now unchecked
```

`Tests 655 passed (655)`, `Test Files 29 passed (29)`, `client-tsc=0 node-tsc=0`, **3/3 runs**.

**Why this is worse than the other four D5 defeats (M20/M21/M22/M35).** Those need an *alias*: they
introduce a name that is on neither the guard's list nor the component's destructuring. M41 uses
**the listed name itself** — it would survive any amount of list-hardening, because the guard is
correctly told that `saved` may legitimately appear as a lambda parameter. The read that M12 is
killed for is restored *verbatim*, in the same statement position, and the guard does not look.

**Fix direction.** Rule 1 should be scoped to the read it is excusing, not to the callback: find
each `binding` occurrence in the body, discard those inside a parameter list, and require the
remainder to be declared. Equivalently: parse the callback and compare against the *bindings in
scope at each read site* rather than against a body-wide substring test. Rule 2 has the mirror
problem — see **N17**.

---

## 4. Coverage-gap table

| Mutant | Restored defect | Guard that should have caught it | Why it missed | Suite |
| --- | --- | --- | --- | --- |
| M01 | A-4 per-keystroke clamp | `tests/pool-e2e.spec.ts:1249-1250` | regex anchored on the first token after `setIntervalText(`; `toContain` on the destructure at `:1252` proves a call, not a use | 655 green |
| M38b | A-4 per-keystroke clamp | same | asserts the *call* exists, never that `text` is used | 655 green |
| M17 | field ignores the raw keystroke | `tests/pool-e2e.spec.ts:1255` | `expect(pool).toContain('value: intervalText ?? …')` — the asserted text survives **as a comment**; this guard does not `strip()` | 655 green |
| M14 | N1 draft loss on failed re-read | `tests/pool-e2e.spec.ts:1136-1144` | asserts the bail-out text and its precedence, never that it returns | 655 green |
| M15 | N1 at the source | `tests/pool-e2e.spec.ts:1153` | asserts the *card's* `onSaved` text; `refreshUsage`'s own failure contract is never asserted | 655 green |
| M16 | A-8 data loss on failed write | `tests/pool-e2e.spec.ts:1111-1155` | the `catch` block is never inspected | 655 green |
| M18 | M-4 no refresh after batch | `tests/pool-e2e.spec.ts:985` | `toContain('onRefresh={')` — the attribute exists, its body is not read | 655 green |
| M19 | L-5 latest-wins neutered | `tests/pool-e2e.spec.ts:1022` | `toContain('usageGuard.current.begin(region)')` — satisfied by `() => begin(region)()` | 655 green |
| M20 | D5 render-scoped read | `tests/pool-e2e.spec.ts:1158-1226` | alias name absent from the hardcoded derived list | 655 green |
| M21 | D5 render-scoped read | same | object-literal **value** (skip rule 3 only covers keys) | 655 green |
| M22 | D5 prop read, no dep | same | alias name absent from both lists | 655 green |
| M35 | D5 render-scoped read | same | destructure alias | 655 green |
| M23 | N2 wrong order in the status document | `tests/pool-e2e.spec.ts:522,634` | the only two assertions on `effectiveMemberAccountIds` are single-element, hence order-blind | 655 green |
| M24 | D2 checkin 503 mislabelled as a batch failure | `tests/pool-route.spec.ts:399,407` | both assert **other** branches (`:809`, `:863`); `:857` is asserted nowhere | 655 green |
| M36 | D2 missing reason | same | same | 655 green |
| M28 | N3 delegation is decorative | `tests/pool-e2e.spec.ts:1096,1105` | `strip()` removes comments but not **string literals**; the negative check names `wanted` | 655 green |
| M39 | M-4 refresh on failure | `tests/pool-e2e.spec.ts:995` | counts the literal `onRefresh?.()`, defeated by `.call(undefined)` | 655 green |
| M41 | D5/H-1 render-scoped read (**M12's exact defect**) | `tests/pool-e2e.spec.ts:1213` (skip rule 1) | rule 1 tests `\(\s*saved\b` against the **whole callback body**, so a decoy lambda parameter named `saved` disables the check for `saved` everywhere in that callback | 655 green |

---

## 5. New findings

### N5 — HIGH — the D5 derived-binding guard is defeated by aliasing
**File:** `tests/pool-e2e.spec.ts:1158-1226` (guard) vs `src/client/AccountPool.tsx:281-323,476-494`.
**Mechanism.** The prop half of the guard reads the component's own destructuring
(`const destructure = code.match(/const \{([^}]*)\} = props/u)`) and word-boundary-matches each
name in every `useCallback` body. The derived half is a **hardcoded list**:
`['saved','active','dirty','listedIds','savedEffective','effectiveMembers','ghostMembers','usable',
'usableMemberSet','current']`. A `useCallback` that reads the render-scoped value through a new
name is invisible to both halves. Four spellings all survive: `const savedNow = saved` (M20),
`const meta = { saved: saved.memberAccountIds }` (M21), `const regionNow = region` (M22), and
`const { memberAccountIds: aliasedIds } = saved` (M35). §12.6's claim that the guard is
"generalised" is true for props and false for derived bindings.
**Repro.** Apply `/tmp/r4-patches/M35-D5D-destructure-alias.json` in a `/tmp` copy and run
`npx vitest run` → 655 green.
**Fix direction.** Either scope the guard by *lifetime* rather than by name (find every
render-scope `const`/`let` and require it in the deps of any callback that reads it — an alias is
then just another name in the set), or stop trying: `src/client/AccountPool.tsx` and
`src/client/WorkBuddyCard.tsx` need a real renderer.

### N6 — HIGH — the M-2 wiring guard proves a call, never a use
**File:** `tests/pool-e2e.spec.ts:1235-1257`; defect site `src/client/AccountPool.tsx:592-593`.
**Mechanism.** Three assertions: `toContain('intervalEditOnInput(raw)')`,
`not.toMatch(/setIntervalText\(\s*String\(/u)`, and
`toContain('const { text, commit } = intervalEditOnInput(raw)')`. None of them connects `text` to
`setIntervalText`. M01 wraps the argument in a ternary; M38b keeps the destructure, adds
`void text`, and recomputes the clamp. Both restore the exact user-visible A-4 defect and both are
`tsc`-clean. The `not.toMatch` is a **shape** check — the very thing §12.1 says it replaced.
**Repro.** `/tmp/r4-patches/M01-M2-wiring-revert.json` → 655 green.
**Fix direction.** This one is cheap and worth doing: assert the positive form instead of the
negative — `expect(body).toContain('setIntervalText(text)')` plus
`expect(body).not.toMatch(/String\(/)` inside the `onIntervalInput` body. A guard that names what
must happen is strictly stronger than one that names what must not.

### N7 — HIGH — the L-5 guard checks where the guards sit, never what `fresh` is
**File:** `tests/pool-e2e.spec.ts:1011-1052`; defect site `src/client/WorkBuddyCard.tsx:386`.
**Mechanism.** The guard asserts the substring `usageGuard.current.begin(region)`, counts
`if (!fresh()) return undefined` (must be 2), and checks both occurrences precede their respective
`setStatusByRegion(` and are split by `} catch`. Every one of those holds under
`const fresh = () => usageGuard.current.begin(region)()`, which begins a fresh generation on each
call and therefore returns `true` always. The guard verifies the *call sites* of a predicate it
never evaluates.
**Repro.** `/tmp/r4-patches/M19-L5B-guard-neutered.json` → 655 green. Note this is a *different*
defect from M05 (which the guard does catch): M05 moves the check, M19 disables it.
**Fix direction.** `createLatestWins` is already exported and unit-tested
(`src/account-pool.ts:333-344`). Assert that the card's `fresh` is bound to the *result* of
`begin`, e.g. `expect(code).toMatch(/const fresh = usageGuard\.current\.begin\(region\)\s*$/mu)`
and forbid `fresh` from being a function: `expect(code).not.toMatch(/const fresh = \(\)/)`.

### N8 — MEDIUM-HIGH — the A-8 guard reads the initialiser but not the `catch`
**File:** `tests/pool-e2e.spec.ts:1111-1155`; defect sites `src/client/AccountPool.tsx:535-551`.
**Mechanism.** The guard now asserts `let committed = false` verbatim and that
`if (refreshed === false)` precedes `committed = true` — both genuine improvements over round 3.
But `committed` has two write sites and the guard only looks at one. Adding `committed = true` as
the first statement of the `catch` restores the *original* A-8 defect (a failed write discards the
only copy of the user's edits) with the guard fully satisfied. Relatedly, M14 keeps the bail-out
line but drops its `return`, so control falls through to `committed = true` anyway.
**Repro.** `/tmp/r4-patches/M16-A8C-commit-in-catch.json` → 655 green.
**Fix direction.** Extract the `save` body's control flow and assert the property directly:
`committed` must be assigned `true` exactly once in the whole callback, and that assignment must
come after the bail-out and not inside `catch`.

### N9 — MEDIUM-HIGH — the D6 guard strips comments but not string literals
**File:** `tests/pool-e2e.spec.ts:1071-1073,1096-1097,1105-1108`; defect site
`src/index.ts:1138-1144`.
**Mechanism.** `strip()` removes `/* */` and `//`, which kills the round-3 comment attack. It does
not remove string literals. `const shape = 'return effectiveMembersOf('` satisfies
`:1105-1106` `.toMatch(/return effectiveMembersOf\s*\(/u)`, and the negative check at `:1096-1097`
`not.toMatch(/accounts\.filter\(account => wanted\.has\(account\.id\)\)/u)` is defeated by renaming
the set (`wanted` → `keep`). The second negative check at `:1107-1108`
(`not.toMatch(/\.filter\(account => live\.has\(/u)`) names `live`, which the renamed form does not
use. So a string constant plus a renamed inline filter restores N3 — the rule is called nowhere and
decides nothing.
**Repro.** `/tmp/r4-patches/M28-D6-string-literal.json` → 655 green.
**Fix direction.** Extend `strip()` to also drop `'…'`, `"…"`, and `` `…` `` before matching, and
make the negative check name the *shape* rather than the variable
(`/accounts\.filter\(account => \w+\.has\(account\.id\)\)/u`).

### N10 — MEDIUM — "exactly once" is defeated by respelling the call
**File:** `tests/pool-e2e.spec.ts:993-997`; defect site `src/client/AccountPool.tsx:709`.
**Mechanism.** The guard counts `(pool.match(/onRefresh\?\.\(\)/gu) ?? []).length === 1`. Adding
`onRefresh?.call(undefined)` inside `finally` fires the refresh on a failed batch — the exact thing
the test's own comment forbids — while the count stays 1.
**Repro.** `/tmp/r4-patches/M39-M4E-duplicate-call-respelled.json` → 655 green.
**Fix direction.** Count calls to the *identifier*: `/\bonRefresh\s*\??\.\s*(?:\(|call|apply)/gu`.

### N11 — MEDIUM — one of the four host `reason` sites is asserted by nothing
**File:** `src/web-status.ts:857` (uncovered) vs `tests/pool-route.spec.ts:399,407` (which assert
`:809` and `:863`).
**Mechanism.** §12.6 and §12.7 claim all four 503/500 sites now assert `body()['reason']`. The
`checkin` branch at `:857` is not asserted. `grep -n "checkin: undefined" tests/` returns nothing —
the second 503 test is *named* "answers 503 when **only the requested action** is unavailable" but
only ever disables `test`. Deleting the field (M36) or renaming it to `pool-failed` (M24) both
leave the suite green. The rename is the more damaging of the two, because `pool-failed` **is** a
known cause (`src/client/pool-state.ts:173` → `row.poolErrFailed` = *"批量操作在宿主侧失败：{message}"*),
so the card renders a confident, localized, and **wrong** sentence — it tells the user a batch
failed when no batch was ever attempted — instead of falling back to the Host's own
`pool check-in unavailable` (`src/client/pool-state.ts:197-204`, the three-tier rule). The
distinction the comment at `src/web-status.ts:840-846` insists on ("they must be separate REASONS,
not merely separate English sentences") is defeated from the other direction: the reason is present
and well-formed, just attached to the wrong cause.
**Repro.** `/tmp/r4-patches/M36-D2B-delete-checkin-reason.json` → 655 green.
**Fix direction.** Parameterise the existing test over `['test', 'checkin']`; it is a two-line
change and closes the gap exactly.

### N12 — MEDIUM — `effectiveMemberAccountIds` order is untested
**File:** `src/web-status.ts:637-640`; assertions at `tests/pool-e2e.spec.ts:522,634`.
**Mechanism.** N2 renamed the parameter to `orderedIds` and documented that "ORDER IS THE
CALLER'S". The only two assertions on the field are `toEqual([])` and `toEqual([realId])` — both
single-element, so both order-blind. Swapping the two arguments at `:637` makes the status document
report the **saved** order where the roster order is intended, which silently changes which account
a batch runs on first. Nothing notices.
**Repro.** `/tmp/r4-patches/M23-N2A-arg-order-swap.json` → 655 green.
**Fix direction.** Add one test with a 3-account roster whose order differs from the saved order,
asserting the roster order.

### N13 — MEDIUM — the N1 three-state contract is pinned only by source text
**File:** `src/client/WorkBuddyCard.tsx:405-412` and `:1292`.
**Mechanism.** The contract "resolve `false` when the re-read did not deliver fresh props" is the
whole of §12.2. It is asserted only by
`toContain('onSaved={async () => (await refreshUsage(activeRegion)) !== undefined}')`
(`tests/pool-e2e.spec.ts:1153`). Making `refreshUsage`'s `catch` return a truthy object (M15)
restores N1 at its source; making `onRefresh` a no-op (M18) restores M-4. Both green.
**Repro.** `/tmp/r4-patches/M15-N1B-card-catch-truthy.json`,
`/tmp/r4-patches/M18-M4A-card-onRefresh-noop.json` → 655 green.

### N14 — STRUCTURAL (restates and extends §12.1) — all 18 survivors pass `pnpm run check`
**Files:** `package.json:56-57`, `tsconfig.json`, `tsconfig.client.json`, `vitest.config.ts:55`.
**Mechanism.** `node_modules` contains only `@deepseek-ai`, `@earendil-works`, `@types`, `react`,
`tsdown`, `typescript`, `vitest` — **no jsdom, no react-dom, no @testing-library** — and
`vitest.config.ts:55` sets `environment: 'node'`. `tsconfig.json` excludes `src/client`, so the
`.tsx` files are only typechecked by `tsconfig.client.json`, which validates *types*, not
*wiring*. Neither project sets `noUnusedLocals`/`noUnusedParameters`, so dead values
(`void text`, `void shape`, `void aliasedIds`) are invisible to the compiler too. Consequently no
test imports a `.tsx` module: `grep -rn "from '\.\./src" tests/ | grep tsx` is empty, and both
`AccountPool.tsx` and `WorkBuddyCard.tsx` are only ever read as text via
`tests/pool-e2e.spec.ts:197` `sourceOf`. **This is the root cause of N5–N10 and N13**, and it
cannot be fixed by better regexes: a source-text assertion can always be satisfied by a program
that does not do the thing.
**Fix direction.** The one change that ends this entire class: add `jsdom` (or `happy-dom`) and
`react-dom/test-utils` as devDependencies and render `AccountPool` with a fake `pool` prop,
asserting the interval input's displayed `value` after a keystroke sequence. Everything in
N5–N10, N13 becomes behavioural at once.

### N15 — METHODOLOGY — `tests/pool-e2e.spec.ts:403` is load-sensitive
**File:** `tests/pool-e2e.spec.ts:403`, assertion at `:474`.
**Mechanism.** Under CPU contention the real-fs drain after
`await vi.advanceTimersByTimeAsync(5 * 60_000)` (`flushRealWork()`, `:490-494`) does not always
complete, and `expect(probes).toBeGreaterThanOrEqual(1)` fails with `expected 0 to be greater than
or equal to 1`. 10/10 serial pristine runs green; reproducible under 4-way parallelism. This
matters beyond my own harness: **any future verification that runs mutants in parallel will
produce false kills**, and it is exactly the kind of failure that gets misread as a guard working.
**Fix direction.** Loop `flushRealWork()` until a condition holds (with a bounded turn count)
rather than a fixed 60 `setImmediate`s, or make the assertion `expect(probes).toBeGreaterThanOrEqual(0)`
with a separate deterministic probe-count test.

### N16 — HIGH — the D5 guard's false-positive suppression is body-wide, so a decoy lambda disables the check for the name it is checking
**File:** `tests/pool-e2e.spec.ts:1216` (the skip rule) and `:1199-1202` (the hardcoded list);
defect site `src/client/AccountPool.tsx:494-496`. **Decisive mutant: M41** (§3.2), SURVIVED 3/3,
`Tests 655 passed (655)`, `client-tsc=0 node-tsc=0`.
**Mechanism.** The guard excuses a binding name for a whole callback when the callback merely
*contains* `(` + name anywhere:

```js
if (new RegExp(`\\(\\s*${binding}\\b`, 'u').test(body)) continue   // tests the WHOLE body
```

The rule is right in intent — `(current) => …` updaters and `(saved) => …` callbacks genuinely
declare their own parameter, and flagging them would be a false positive. But it is evaluated
against the callback body, not against the read it is excusing. One decoy lambda parameter named
`saved` therefore switches off the `saved` check for that entire callback, and the real
free-variable read of the render-scoped `saved` — **M12's defect, which on its own is KILLED** —
goes through. See §3.2 for the patch and the reasoning.

**Why it is a separate finding from N5 (aliasing).** N5's defeats (M20/M21/M22/M35) all hide behind
a name that the guard has never heard of. M41 uses the name the guard is explicitly looking for.
No extension of the derived list can help; the fix has to change the *scope* of the skip.
**Fix direction.** Resolve each `binding` occurrence in the body individually: drop the occurrences
that are parameter declarations (or property reads/object keys) and require the remaining ones to be
declared in `deps`. A body-wide `continue` cannot express "this read is excused but that one is not".

### N17 — LOW-MEDIUM — the D5 guard rejects legitimate code that merely mentions a derived name in a string literal
**File:** `tests/pool-e2e.spec.ts:1217`; probe at `src/client/AccountPool.tsx:598-600`. **Evidence:
M43**, `Tests 1 failed | 654 passed (655)`:
```
AssertionError: onIntervalCommit reads the render-scoped saved but does not declare it (H-1 shape):
                expected '\n  }, [' to contain 'saved'
```
**Mechanism.** Rule 2 is `if (!new RegExp(`(^|[^.\\w])${binding}\\b`, 'u').test(body)) continue`. The
character class `[^.\w]` matches a quote, so the word `saved` inside a **string literal** counts as
a free-variable read. M43's callback is legitimate — it sets an error message — and the guard
demands a `saved` dependency that does not exist and should not. Same root cause as **N9**
(`strip()` removes comments but not string literals), now demonstrated on the D5 half instead of
the D6 half.
**Why it matters more than "the guard is a bit strict".** A guard that fails correct code gets
edited by whoever hits it. The cheapest edit is to satisfy rule 2 — add `saved` to the deps array —
which silences the failure *and* leaves the real staleness class (N5, N16) exactly as open as
before, now with a visibly "passing" guard. A guard that can be wrong in the direction of a false
positive is a guard whose next maintainer will neuter it.
**Fix direction.** `strip()` the body (string literals included, not just comments) before running
rules 1–3, or at minimum require the match to be a genuine identifier position.

### 5.1 The seams, probed (acceptance criterion E)

Beyond asserting that each guard's own mutant dies, I probed the **seams**: the boundaries where a
guard stops looking, and where it looks too hard. Four seams were named; two produced findings.

| # | Seam | Probe | Result |
| --- | --- | --- | --- |
| 1 | **N1 vs A-8** — the bail-out that is never checked for *returning* | M14 (drop the `return`, keep the text) + M16 (`committed = true` inside `catch`) | **Both SURVIVED.** A-8 pins the initialiser and the precedence, never the `catch` path (N8). M16 is real data loss: the draft is the only copy. |
| 2 | **N1 vs L-5** — the token is checked for *placement*, never for *identity* | M19 (`const fresh = () => usageGuard.current.begin(region)()`) | **SURVIVED.** `:1022` `toContain('usageGuard.current.begin(region)')` is satisfied by a wrapper that discards the token and mints a new one per call (N7). Both L-5 write sites still sit behind a call to `fresh`, so all four positional assertions pass. |
| 3 | **N3 vs the route's `effectiveMemberAccountIds` dependency** — the rule is shared, but is its *contract* (order) shared? | M23 (swap `effectiveMembersOf`'s two arguments at `src/web-status.ts:637-640`) | **SURVIVED.** The rule itself is well tested (`tests/account-pool.spec.ts:559` asserts order at `:569-576`), and the shared call site is structurally enforced by D6. But the *only* two assertions on the resulting field (`tests/pool-e2e.spec.ts:522` `toEqual([])`, `:634` `toEqual([realId])`) are single-element, so inverting the argument order changes nothing observable (N12). |
| 4 | **The derived-binding guard vs false positives** — does it flag legitimate code? | M42 (control: a name in a **key** position with `t` declared) → green; M43 (a name inside a **string literal**) → FAILED | **M43 is a guard FALSE POSITIVE** (N17). M42 shows the skip rules do their intended job for object keys; M43 shows the same mechanism fails for string literals. A parser replay of all nine callbacks (`/tmp/r4-seam.mjs`) confirms the guard produces **no** false positive on the current tree — the flaw is latent, not yet triggered. |

**The symmetric lesson.** N5/N6/N7/N8/N9/N10/N11/N13 are *false negatives*: the guard should have
fired and did not. N16 and N17 are the opposite: N16 is a false negative **created by** a
false-positive defence, and N17 is a false positive that will *manufacture* false negatives the
moment someone "fixes" it the cheap way. Both directions come from the same design choice — testing
prose patterns body-wide instead of resolving the specific read — and neither is fixable by making
the patterns longer.

---

## 6. What I could NOT verify, and why

1. **Whether the fixed code actually behaves correctly in a browser.** No renderer exists
   (N14), so `AccountPool.tsx` and `WorkBuddyCard.tsx` were never executed. Every statement I make
   about them is about source text. This is the largest unverified area and it is not closable
   within this round's dependency set.
2. **The user-visible A-4/A-1 defect end-to-end.** I can show that M01 restores the *documented*
   mechanism (`String(commit)` reaches the display) and that nothing fails. I cannot execute the
   keystroke sequence in a real component to observe `5 → 52 → 520`.
3. **`poolMemberAccounts`' observable output.** It is a closure inside the plugin factory and is
   never called by a test — `tests/` mentions it only in comments and in the D6 source guard. The
   D6 claim is therefore still structural, and the guard's own comment
   (`tests/pool-e2e.spec.ts:1069`) concedes the point. I did not attempt to mount the full plugin
   for it.
4. **The `latest-wins` guard's real behaviour** under two overlapping fetches — `WorkBuddyCard.tsx`
   is not renderable, so M19's effect is reasoned from `createLatestWins`'s source
   (`src/account-pool.ts:333-344`), not observed.
5. **Two guards I did not attack at all:** `tests/pool-e2e.spec.ts:282` (batch-callback deps — it
   killed M13, and I found no defeat, but absence of a defeat is not a proof) and
   `tests/pool-e2e.spec.ts:1229` (latest-wins import). They are reported as untested, not as held.
6. **Whether any of the 18 mutants would be caught by a *different* consumer** (the real DSH Host,
   the desktop app). Out of scope; the question asked was about this repository's suite.
7. **The seams are probed, not exhausted.** §5.1 names four; I found defeats at two of them (M41,
   M43) and a control at a third (M42). The other five guards' seam structure — where their skip
   rules, word boundaries and slice anchors stop looking — was reviewed but **not** attacked with
   mutants the way the D5 guard was. M41 in particular suggests the general shape to look for
   ("does this guard excuse a name body-wide?"), and I did not complete that sweep over the M-4,
   L-5, D6, A-8 and M-2 wiring guards. Count the guards as *not yet having survived* a seam probe,
   rather than as having passed one.
8. **That M43 is the only false positive.** It is the only one I constructed; I did not fuzz the D5
   guard for other shapes that legitimate code can take (template literals, `import` aliases,
   parameter destructuring, comments inside the sliced region are stripped but strings are not).
   N17 states the mechanism precisely; the *population* of instances is unknown.

---

## 7. Frozen hashes and sentinel

### 7.1 The 11 frozen hashes — `shasum -a 256 -c /tmp/r4-frozen.txt`, before and after

```
src/account-pool.ts: OK
src/client/pool-state.ts: OK
src/client/AccountPool.tsx: OK
src/client/WorkBuddyCard.tsx: OK
src/client/locales.ts: OK
src/index.ts: OK
src/web-status.ts: OK
tests/pool-e2e.spec.ts: OK
tests/pool-state.spec.ts: OK
tests/pool-route.spec.ts: OK
tests/account-pool.spec.ts: OK
```
11/11 OK, identical before and after the campaign.

### 7.2 Real-home sentinel — byte-identical before and after

```
-rw-------  1 dmh2002  staff  35 Sep 30 07:13 /Users/dmh2002/.dsh/.workbuddy-pool.cn.json
35c8297fb847b93e45c075d2bc2dacadad43f7ca37affedb0b0c54c4650678f4
size 35 bytes, mtime 1790723631, mode -rw-------
```
Unchanged throughout. No probe was ever written to the real home.

### 7.3 Shared tree untouched

```
( find src tests -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 )
e83f23752da73b1475abe4c2ec9bffd06b4b15808e901fe91215dd500871548a
```
Identical to the pre-campaign value and to all five `/tmp/r4-*` copies after restoration.
`git status --porcelain | wc -l` = **27**, the pre-existing baseline (12 modified + 15 untracked),
unchanged by this session.

> Hash-method note for the next verifier: hash with **relative** paths
> (`find src tests -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256`). Hashing
> absolute paths gives a different digest per directory (`a9a51b68…` / `c8e478af…` / `7d0bfced…`)
> because the path text is part of the input — that is not a content difference, and mistaking it
> for one produces phantom mismatches.

---

## 8. Verdict

§12.7's table is honest about its 13 mutants: 12 reproduce exactly, and #1 is a real, verified
kill of the *old* wording. But the claim that the round replaced "文本存在" with "行为存在" is
**not supported for the source-text guards** — six of the eight were defeated, and the round's
user-reported product gap (M-2 wiring) can be reverted in two different ways with the suite at 655
green and `pnpm run check` exiting 0.

The pattern is consistent and worth stating plainly, because it is the same pattern round 3 found:
**every defeat is a respelling of an identifier or a wrapper around an expression.** A ternary
around the asserted argument, a `.call()` instead of `()`, an alias instead of the name, a
destructure instead of a property read, a string literal instead of a call, a `void` instead of a
use. Source-text guards on a file that cannot be executed will keep losing this arms race, because
the guard can only enumerate the spellings its author thought of, and the compiler is not helping
(`noUnusedLocals` is off, so dead values are legal).

The seam probes (M41, M43) add the converse half, and it is the more useful half for whoever fixes
these guards. **A guard has two ways to be wrong, and the fixes point in opposite directions.** A
guard that is too narrow needs more checking (N5–N13); a guard that is too eager needs less. M41 is
a false negative that exists *because* the guard defends against a false positive: the body-wide
lambda-param skip at `tests/pool-e2e.spec.ts:1216` suppresses a check the author was right to
suppress, and it suppresses it for the whole callback, which is what lets M12's defect back in.
M43 is the reverse — rule 2 at `:1217` treats an identifier inside a string literal as a read, so
the guard fails code that is correct. Neither is fixable by extending the derived list or by
tightening a regex; both need the same thing, which is to resolve the individual read site instead
of pattern-matching the callback body.

That is also why N17 deserves attention out of proportion to its LOW-MEDIUM severity. M43's failure
message tells the developer to declare a `saved` dependency that does not exist. The obvious
response is to add it — the suite goes green, the guard looks satisfied, and N5/N16 remain exactly
as open as before. A guard that can be wrong in the false-positive direction is one that eventually
gets neutralised by the person it inconvenienced.

The fix is not more regexes. It is one dependency: `jsdom` plus `react-dom`, so that
`AccountPool.tsx` can be rendered and the interval field's displayed value can be read after a
keystroke. That single change converts N5–N10, N13, N16 and N17 from "guard defects" into
behavioural tests — including M43, which a renderer would never report, because legitimate code
renders correctly whatever a regex thinks of it. It is the only recommendation in this report that
ends a class of defect rather than one instance of it.
