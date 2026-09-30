# H — Round-3 verification (adversarial, teammate `round3-verify`)

> Verifier: `round3-verify` (shared task `task-6`), independent of the Lead who wrote the fixes.
> Subject: the ten third-round account-pool fixes (M-2/A-4, D1, D2, D4, H7/H8, D5, M-4, L-5, A-8, D6),
> as claimed in [E-fix-log.md](E-fix-log.md) §十一.
> **Only reproduction counts, never the claim.** For every fix I built a mutant in a `/tmp` copy and
> asked whether the suite notices. A claim is CONFIRMED only when (i) I can point at the implementing
> code AND (ii) a mutant makes a test fail. Everything else is reported as a gap, not as a pass.
>
> **This file is the only write this session made to the repository.** `src/` and `tests/` were never
> touched (all eight frozen hashes verified identical before and after — see §9).

## 1. Method and discipline

- Repo copied to `/tmp/r3v-mut` (`rsync -a --exclude .git --exclude .pnpm-store --exclude .dsh-npm-cache`).
  **Every mutation happened in the copy**, always as `apply_py <name> <file>` whose python body asserts
  the target text exists exactly once, prints a unified diff, and returns **NO-OP-PATCH** (rc 3) when the
  file is unchanged. Six of the 27 runs were rejected as no-ops and are not reported as results.
- Every harness sources `/tmp/r3v-env.sh`, which creates a fresh `mktemp -d` and points
  `DSH_HOME` / `HOME` / `USERPROFILE` / `LOCALAPPDATA` / `APPDATA` / `XDG_CONFIG_HOME` at it
  (matching `vitest.config.ts:39`) and unsets `WORKBUDDY_AUTH_FILE`.
- Real-home sentinel checked **before** any run and **after** every mutant:
  `/Users/dmh2002/.dsh/.workbuddy-pool.cn.json` stayed at `size=35`, `mtime=1790723631`,
  `sha256=35c8297fb847b93e45c075d2bc2dacadad43f7ca37affedb0b0c54c4650678f4`,
  content `{"version":1,"probes":{}}`. **No probe was ever injected into the real home.**
- One harness bug was found and corrected mid-campaign: an early A-8 mutant reported two failures
  because the previous mutant's file had not been reverted. After `unmut` of both files it reported
  exactly one, and the contaminated run was discarded rather than reported.
- 27 suite runs, one output file each, at `/tmp/r3v-out-*.txt`.

### Baseline (acceptance A)

```
cd /tmp/r3v-mut && source /tmp/r3v-env.sh && npx pnpm run check   # EXIT=0
```
Full `check` (typecheck + test + build) exits 0 in the copy. Individually: `npx vitest run` →
**Test Files 29 passed (29), Tests 651 passed (651)**; `npx tsc --noEmit -p tsconfig.json` and
`-p tsconfig.client.json` both exit 0. Baseline reproduced exactly as stated.

## 2. Verdict summary

| # | Claim | Verdict | One-line reason |
| --- | --- | --- | --- |
| 1 | M-2/A-4 interval no longer clamps per keystroke | **PARTIALLY CONFIRMED** | Helper pinned; the card wiring that caused A-4 has **no test** (mutant green) |
| 2 | D1 `exclusionOf` no longer flattens outcomes | **CONFIRMED** | 3 tests fail on the fold-back mutant |
| 3 | D2 routes carry `reason`; `poolFailureText` localizes status | **PARTIALLY CONFIRMED** | Client tier pinned (3 fail); Host `reason` emission **untested** (mutant green) |
| 4 | D4 scheduler e2e no longer vacuous | **CONFIRMED** | Emptied due-loop fails it; first-sight mutant fails 2 suites |
| 5 | H7/H8 reason mapping + bilingual keys pinned | **CONFIRMED** | H7 → 1 fail, H8 → 2 fails |
| 6 | D5 callbacks declare every prop they read | **CONFIRMED (narrower than stated)** | Both guards fire on naive mutants; prop-**object** reads uncovered (mutant green) |
| 7 | M-4 refreshes on the SUCCESS path only | **CONFIRMED** / **guard REFUTED** | Naive move → 1 fail; a duplicate call inside `finally` → **651 green** |
| 8 | L-5 per-region token on BOTH write paths | **CONFIRMED** / **guard REFUTED** | Naive delete → 1 fail; moving the guard → **651 green** |
| 9 | A-8 awaits re-read, discards only after verified write | **REFUTED (in part)** | `let committed = true` → **651 green**; and the flag is set even when the re-read fails (§6 N1) |
| 10 | D6 five copies collapsed into `effectiveMembersOf` | **CONFIRMED** / **guard REFUTED** | Exhaustive survey: 5/5 delegate, no leftover copy; but a **comment** satisfies the guard |

Tally: **5 fully confirmed** (2, 4, 5, 6, 10-as-refactor) — the refactor in 10 is real even though its guard is not;
**3 partially confirmed** (1, 3) ; **2 whose code is right but whose advertised guard I defeated** (7, 8);
**1 partially refuted** (9). No claim was left unverified.

## 3. Per-claim evidence

### Claim 1 — M-2/A-4: no per-keystroke clamping — PARTIALLY CONFIRMED

**Implementing code.** `parseIntervalInput` at `src/client/pool-state.ts:220-236` clamps only a complete
number (`return Math.min(POOL_INTERVAL_MAX, Math.max(POOL_INTERVAL_MIN, Math.round(parsed)))`, bounds
`POOL_INTERVAL_MIN=5` / `POOL_INTERVAL_MAX=1440` at `src/client/pool-state.ts:139-140`). The card keeps
the typed text in `intervalText` (`src/client/AccountPool.tsx:266`), folds a valid value into the draft in
`onIntervalInput` (`:563`), forces the text back on blur/Enter in `onIntervalCommit` (`:570`), renders
`value: intervalText ?? String(active.autoTestIntervalMinutes)` with `onChange`/`onBlur`/`onKeyDown`
(`:1062-1070`), and clears the text on discard (`:495`).

**Mutant that fails (helper half).** `M-M2-drop-clamp` — `parseIntervalInput` returns `parsed` unclamped:
```
× accepts every intermediate prefix of a longer number        tests/pool-state.spec.ts:235
× clamps below the minimum and above the maximum              tests/pool-state.spec.ts:243
```
2 failed / 649 passed.

**Mutant that does NOT fail (the user-visible half).** `M-2-wiring-revert` — restore exactly the A-4
defect: `value: String(active.autoTestIntervalMinutes)` and `setIntervalText(undefined)` in
`onIntervalInput`. Typing `120` then re-renders `5 → 52 → 520`. **651 passed / 29 files green.**
The pure helper is covered; the behaviour the user actually reported is not.

### Claim 2 — D1 `exclusionOf` — CONFIRMED

**Implementing code.** `src/account-pool.ts:144` `exclusionOf` keeps `credential-rejected`, `not-found`,
`failed` and `unavailable` as distinct values instead of folding them into one.

**Mutant.** `M-D1-foldback` (all three folded back to `credential-rejected`):
```
× no longer folds a network outage into "your sign-in was rejected"   tests/account-pool.spec.ts:523
× keeps the name column and the probe column telling one story        tests/account-pool.spec.ts:534
× still gives no cooldown to an unreachable upstream                  tests/account-pool.spec.ts:550
```
3 failed. The claim stands.

### Claim 3 — D2 route `reason` + `poolFailureText` status tier — PARTIALLY CONFIRMED

**Implementing code (client).** `poolFailureText` at `src/client/pool-state.ts:197-204` resolves in three
tiers: `poolErrorText(t, input.reason, input.error) ?? input.error ?? t('row.poolErrHttp', {status})`.
`poolErrorText` (`:161-176`) is a 7-case switch over the structured causes with `default → undefined`.

**Mutant (client).** `M-D2-drop-status-tier` (`t('row.poolErrHttp', …)` → `` `HTTP ${status}` ``):
```
× localizes by STATUS when there is no reason and no error at all   tests/pool-state.spec.ts:365
× passes the status through so the message can name it             tests/pool-state.spec.ts:372
× treats a reason with no matching branch as unknown               tests/pool-state.spec.ts:390
```
3 failed. This half is genuinely pinned.

**Implementing code (Host).** `reason` is emitted at `src/web-status.ts:808` (`pool-unavailable`),
`:819` (`pool-disabled`), `:848` (`no-members` / `no-live-members`), `:856`, `:862` (both
`pool-unavailable`), `:878` (`target-model-stale` / `no-free-model`), `:890` (`pool-failed`).

**Mutant that does NOT fail.** `M-D2-drop-reason` — delete `reason:` from **all four** 503/500 bodies
(`:808`, `:856`, `:862`, `:890`): **651 passed / 29 files green.** `grep -c reason tests/pool-route.spec.ts`
= **0**: the route suite asserts status codes and `body()['error']` strings but never the reason. The
claim that "the pool routes' 503/500 carry a `reason`" is true of the source and **not defended by any
test on the Host side**; only the client half is pinned (and it is pinned against the client's own
literals, not against what the Host actually sends).

### Claim 4 — D4 scheduler e2e not vacuous — CONFIRMED

**Implementing code.** `src/index.ts:1311` `for (const region of schedule.due)`, fed by
`duePoolRegions` (`src/account-pool.ts:412`), which ARMS a region on first sight rather than running it.
The e2e installs `vi.useFakeTimers({toFake:['setInterval','clearInterval','Date']})` **before** mount
(`tests/pool-e2e.spec.ts:402-480`) and drains real fs I/O with `flushRealWork()` (`:490-494`, 60 ×
`setImmediate`, which is deliberately not faked).

**Mutant A — the decisive one for criterion C(b).** `M-D4-scheduler-disabled`
(`for (const region of schedule.due)` → `for (const region of [] as WorkBuddyRegion[])`):
```
× arms on the first tick, then probes and re-ranks once the interval passes
    tests/pool-e2e.spec.ts:403  ("the pool scheduler actually runs a due region")
```
**The test fails with the scheduler disabled, so it does observe the scheduler acting.** It is not vacuous.

**Mutant B.** `M-D4-run-on-first-sight` (push to `due` instead of arming): 2 failed —
`tests/account-pool.spec.ts:373` `ARMS a region on first sight instead of running it` **and**
`tests/pool-e2e.spec.ts:347` `does not probe anything before a full interval has elapsed`. Both the unit
and the e2e independently catch it.

### Claim 5 — H7/H8 — CONFIRMED

**Mutant H7.** `M-H7-drop-pool-unavailable-case` (delete `case 'pool-unavailable'` from `poolErrorText`):
`× maps every structured cause to its own key` — `tests/pool-state.spec.ts:276`, 1 failed.

**Mutant H8.** `M-H8-drop-zh-key` (delete the `row.poolErrFailed` line from the zh table,
`src/client/locales.ts:243-250`):
```
× has each key in BOTH tables, in both languages   tests/pool-state.spec.ts:318
× keeps the two languages in exact key parity      tests/pool-state.spec.ts:338
```
2 failed — matching E-fix-log §十一's claim precisely. En keys are at `src/client/locales.ts:48-55`.

### Claim 6 — D5: callbacks declare what they read — CONFIRMED, but narrower than stated

**Implementing code.** `runAction` at `src/client/AccountPool.tsx:575` with dependency array
`[appendLog, onRefresh, pool, region, t]`; the structural guard at `tests/pool-e2e.spec.ts:282-311`.

**Positive control 1.** `M-D5-runAction-reads-dirty` (insert `if (dirty && false) return` right after
`setBusy(action)`): `× keeps the batch callback reading only what it declares as a dependency`
(`tests/pool-e2e.spec.ts:282`), 1 failed. The guard is real.

**Positive control 2.** `M-D5-drop-onRefresh-dep` (`onRefresh` removed from the dep array):
`× declares every prop callback its useCallbacks read (D5, generalised)`
(`tests/pool-e2e.spec.ts:1082`), 1 failed. Also real.

**Mutant that does NOT fail.** `M-D5-save-reads-pool-undeclared` — make `save` read the `pool` **prop**
with no dependency entry: **651 green.** The generalised guard only looks for the four names
`onSaved`/`onRefresh`/`onRotationChange`/`onBusyChange` inside each `useCallback` body, so the stated
class ("every prop callback they read") is pinned only for those four names, not for prop-object reads.

### Claim 7 — M-4: refresh on the SUCCESS path only — CONFIRMED code, guard REFUTED

**Implementing code.** `onRefresh?.()` is called at `src/client/AccountPool.tsx:670` **inside the try**,
above `} finally {`; `onRefresh?: () => void` is declared at `:115` and wired at
`src/client/WorkBuddyCard.tsx:1285`.

**Positive control.** `M-M4-moved-into-finally` (move the call into `finally`) →
`× re-reads usage after a batch action, not only after a save (M-4)`,
`tests/pool-e2e.spec.ts:980`, 1 failed.

**Mutant that does NOT fail — the guard is text, not behaviour.** `M-M4-refresh-also-in-finally` (keep the
success-path call and add a **second** `onRefresh?.()` as the first statement of `finally`): **651 green.**
The guard uses `indexOf` (first occurrence) and asserts `callAt < finallyAt`, so the duplicate is
invisible — while the exact behaviour M-4 exists to prevent (a refresh on the FAILURE path) is back.

### Claim 8 — L-5: per-region latest-wins on both paths — CONFIRMED code, guard REFUTED

**Implementing code.** `createLatestWins` token begun at `src/client/WorkBuddyCard.tsx:386`
(`usageGuard.current.begin(region)`), guarded on the **success** path at `:397` before
`setStatusByRegion` (`:399`) and on the **error** path at `:405` before `:407`. `usageGuard` is created
at `:378`.

**Positive control.** `M-L5-guard-deleted` (delete the success-path `if (!fresh()) return undefined`):
`× guards the usage fetch with a PER-REGION latest-wins token (L-5)`, `tests/pool-e2e.spec.ts:1000`, 1 failed.

**Mutant that does NOT fail.** `M-L5-success-guard-moved` (delete the success-path guard and insert a
**duplicate** on the error path): **651 green**, `grep -c` still returns 2. The guard's only count
assertion is `expect(count of /if \(!fresh\(\)\) return undefined/gu).toBe(2)`, which "one path guarded
twice" satisfies; every other clause (`begin(region)`, `createLatestWins<WorkBuddyWebRegion>()`) also
still holds. The L-5 defect — a stale **success** response clobbering a newer snapshot — is fully
reintroduced with the suite green.

### Claim 9 — A-8: await the re-read, discard only after a verified write — REFUTED in part

**Implementing code (the ordering is real).** `src/client/AccountPool.tsx:507` `let committed = false`;
`:509` `await writePoolPreferences(...)`; `:520` `await onSaved?.()` **before** `:521 committed = true`
and `:531 if (committed) discard()`.

**Positive control.** `M-A8-old-order-clean` (bare `discard()` immediately before `await onSaved?.()`):
`× awaits the re-read before discarding the draft, and only after a verified write (A-8)`,
`tests/pool-e2e.spec.ts:1058`, 1 failed. The ordering is defended.

**Mutant that does NOT fail — "only after a verified write" is not defended.** `M-A8-committed-true`
(`let committed = false` → `true`): **651 green.** The guard checks that the `discard()` call sits after
`await onSaved?.()`, but never that `committed` **starts** false — so a failed write still discards the
only copy of the user's edits with the suite green.

This is also a live runtime gap, not merely a guard weakness — see **N1** in §6.

### Claim 10 — D6: five copies collapsed into one — CONFIRMED; guard REFUTED

**Exhaustive source survey (criterion C(a)).** I enumerated every `memberAccountIds` mention in `src/`
and every `filter(...has(...))` intersection:

| Site | Verdict |
| --- | --- |
| `src/account-pool.ts:263` `saved.filter(id => listedIds.has(id))` | the shared rule itself |
| `src/index.ts:899` `effectiveMembersOf(saved, new Set(accounts.map(a => a.id)))` | delegates (SAVED order) |
| `src/index.ts:1132` `new Set(effectiveMembersOf(saved, new Set(accounts.map(a => a.id))))` | delegates |
| `src/web-status.ts:636` `effectiveMembersOf(accounts.map(a => a.accountId), new Set(preferences.memberAccountIds))` | delegates |
| `src/client/pool-state.ts:111` `ghostMemberIds` | different rule (ghosts, not members) |
| `src/client/pool-state.ts:244` `usableMemberIds` | **not a copy** — takes `effectiveMembers` as an already-derived input |
| `src/web-status.ts:590`, `src/index.ts:911` | complements (the *other* accounts), not membership rules |
| `src/client/account-selection.ts:374-377` | a set-equality check on the saved list inside the read-back write verifier — a different concern |

**No leftover semantically-equivalent copy exists.** All five effective-member paths delegate. The claim
is accurate.

**Mutant that does NOT fail the guard.** `M-D6a` — replace the whole `web-status.ts:636-639` block with
`// Derived here rather than through effectiveMembersOf.` + `effectiveMemberAccountIds: [...preferences.memberAccountIds],`.
The D6 guard **passes**: its check is `expect(source).toContain('effectiveMembersOf')` on **unstripped**
source, so a **comment** satisfies it. (The mutant does fail the behavioural H-5 e2e,
`tests/pool-e2e.spec.ts:497` `H-5: reports EFFECTIVE membership so the card cannot overcount`, which
asserts `effectiveMemberAccountIds === []` while `memberAccountIds === ['ghost-account-id']` for a
ghost-only pool.) So the site is covered **behaviourally by H-5**, not by its own guard.

## 4. Criterion C — the three self-serving-claim attacks

**(a) Is `effectiveMembersOf` on all five paths, or is a copy hidden from the string match?**
**All five delegate.** The exhaustive survey above found no semantically-equivalent leftover; the two
near-misses (`usableMemberIds`, `account-selection.ts:374-377`) are respectively an input-consuming
helper and an unrelated write-verification check. **But the guard itself does not prove this**: it is a
raw-substring `toContain('effectiveMembersOf')` on unstripped source, and my `M-D6a` comment mutant
passes it. The real protection is the behavioural H-5 test at `tests/pool-e2e.spec.ts:497`.

**(b) Does the D4 e2e observe the scheduler acting, or does it pass with the scheduler disabled?**
**It observes it.** `M-D4-scheduler-disabled` empties the due-loop at `src/index.ts:1311` and the test at
`tests/pool-e2e.spec.ts:403` fails. The fake clock is installed before mount and `flushRealWork()` drains
the real fs I/O, so the test is not passing on a lucky ordering. Round 3 genuinely fixed the vacuity.

**(c) Are the D5/M-4/L-5/A-8 guards asserting BEHAVIOUR or only text?**
**All five are source-text guards.** None of them imports and executes the code under test. Three of the
four I attacked were **defeated by a text-preserving mutation**:

| Guard | Naive regression | Text-preserving evasion that stays green |
| --- | --- | --- |
| M-4 (`:980-998`) | caught (1 fail) | **duplicate `onRefresh?.()` in `finally`** |
| L-5 (`:1000-1019`) | caught (1 fail) | **move the guard, keep the count at 2** |
| A-8 (`:1058-1080`) | caught (1 fail) | **`let committed = true`** |
| D6 (`:1021-1056`) | — | **the token inside a comment** (behaviourally backed by H-5) |
| D5 general (`:1082-1105`) | caught (1 fail) | prop-**object** read with no dep (out of scope by construction) |

The M-4 guard (`:980-998`) is the only one of the five that does not strip comments at all; the others
strip comments but are still satisfiable by text-preserving edits of a different kind.

## 5. Coverage gaps (criterion D)

Deleting/reverting each fix and asking whether the suite notices. Six mutants changed behaviour
meaningfully and the suite stayed at **651/29 green**:

| Mutant | Defect restored | Suite | Exact suite that fails to notice |
| --- | --- | --- | --- |
| `M-2-wiring-revert` | per-keystroke clamping in the interval field | 651 green | `tests/pool-state.spec.ts` covers the helper; nothing covers `AccountPool.tsx` |
| `M-D2-drop-reason` | Host 503/500 lose `reason` | 651 green | `tests/pool-route.spec.ts` (0 occurrences of `reason`) |
| `M-D5-save-reads-pool-undeclared` | `save` reads a prop with no dep | 651 green | `tests/pool-e2e.spec.ts:1082` (name-scoped) |
| `M-M4-refresh-also-in-finally` | refresh on the FAILURE path | 651 green | `tests/pool-e2e.spec.ts:980` (first-occurrence only) |
| `M-L5-success-guard-moved` | stale success clobbers a newer snapshot | 651 green | `tests/pool-e2e.spec.ts:1000` (counts, does not locate) |
| `M-A8-committed-true` | a failed write discards the user's edits | 651 green | `tests/pool-e2e.spec.ts:1058` (never reads the initial value) |

Deliberately one-sided mutants (a guard deleted while the fix stays) **do** fail — the guards are not
inert; they are simply satisfiable by text that does not implement the behaviour.

## 6. New findings (criterion E)

New findings are numbered `N1..` (not `D1..`) because `D1`, `D2`, `D4`, `D5`, `D6` are already the case's
defect identifiers; reusing them would make the report ambiguous.

### N1 (LOW–MEDIUM) — A-8 discards the draft after a FAILED re-read, showing the stale panel it exists to prevent

`await onSaved?.()` (`src/client/AccountPool.tsx:520`) invokes `onSaved={() => refreshUsage(activeRegion)}`
(`src/client/WorkBuddyCard.tsx:1284-1286`), and `refreshUsage` **never rejects** — on a non-OK response
or a network error it returns `undefined` (`src/client/WorkBuddyCard.tsx:397, 405`). So when the write
verifies but the **re-read fails**, execution still reaches `committed = true` (`:521`) and
`discard()` (`:531`). `discard()` nulls the draft, so `active` falls back to the **stale** `saved` prop
and the panel shows the pre-edit values with the controls live again — precisely the window the comment
at `:512-519` says the fix closes ("the discard that follows is then invisible: the draft and the new
`saved` agree"). They do not agree on this path. The code comment at `:523-526` correctly observes that
`onSaved` reports failure by returning `undefined` rather than throwing, but draws the wrong conclusion
from it: that fact is exactly why `committed` cannot be inferred from the absence of a throw.

*Severity:* LOW–MEDIUM. Not data loss — the write itself verified, so the Host has the new preferences
and the next poll (60 s, `src/client/WorkBuddyCard.tsx:433-441`) or any refresh repairs the display. The
cost is a confusing silent revert that A-8 was specifically written to eliminate.
*Repro:* `M-A8-committed-true`-style reasoning plus a stubbed `refreshUsage` that fails: set the usage
route to 500 and save; the draft is dropped and the panel renders the old membership with no error
message. No test covers it — `M-A8-committed-true` is green.

### N2 (LOW) — `effectiveMembersOf` called with reversed arguments at `src/web-status.ts:636`

The call is `effectiveMembersOf(accounts.map(a => a.accountId), new Set(preferences.memberAccountIds))`,
i.e. **roster first, saved-set second**, the reverse of the declared `effectiveMembersOf(saved, listedIds)`
(`src/account-pool.ts`, used correctly at `src/index.ts:899`). It happens to be correct because the
operation is commutative, but the site returns **roster order** where `index.ts:899` returns **saved
order**. The roster at that point (`src/web-status.ts:637`) is the whole displayed account table, so the
*membership* answers agree today; `sameIds` and `announcedBatchCount` are order-insensitive. It is a
latent trap for any future caller that assumes saved order.

### N3 (INFO) — the delegation at `src/index.ts:1132` is behaviourally a no-op

`const live = new Set(effectiveMembersOf(saved, new Set(accounts.map(a => a.id))))` followed by
`return accounts.filter(account => live.has(account.id))` produces `accounts ∩ saved` whichever way
`live` is computed, because the outer `filter` iterates `accounts`. The D6 refactor is still right to
delegate, but this site contributes no behaviour the text guard can distinguish — so "five paths" is
really four paths plus one cosmetic.

### N4 (LOW) — the D5 "generalised" guard is scoped to four callback names

`tests/pool-e2e.spec.ts:1082-1105` matches `const (\w+) = useCallback(` and flags a missing dependency
only when the body contains one of `onSaved`/`onRefresh`/`onRotationChange`/`onBusyChange`. A `useCallback`
reading any other prop (e.g. `pool`) with no dependency entry stays green (proved by
`M-D5-save-reads-pool-undeclared`). The claim "declares every prop callback its useCallbacks read" is
true as written but narrower than the staleness class it is meant to prevent.

### Seams between the ten fixes (criterion E) — checked, no defect found

- **A-8 reordering vs L-5's token.** `AccountPool` is always mounted as `region={activeRegion}`
  (`src/client/WorkBuddyCard.tsx:1273`), so `onSaved`/`onRefresh` always refresh the same region the
  draft is being saved into. There is no cross-region mismatch seam. The A-8 `void` fix is documented at
  `:1280-1283`.
- **M-4's refresh vs A-8's discard.** `onRefresh` fires from `runAction` (batch actions), `onSaved` from
  `save`; both call `refreshUsage`, which is now token-guarded and idempotent. A batch action cannot race
  the save discard because `siblingBusy`/`poolBusy` gate the buttons (`src/client/WorkBuddyCard.tsx:1277`).
- **L-5 token vs the discard path.** `refreshUsage` returning `undefined` on failure is what makes N1
  reachable, but it does not break the token semantics themselves.

## 7. What I could NOT verify

- **No committed pre-fix baseline exists.** The whole feature is uncommitted (`git show HEAD:src/web-status.ts`
  has no `effectiveMemberAccountIds`), so "before/after" rests on the Lead's E-fix-log §十一 and on my own
  mutants, not on git history.
- **No real Host process or real network.** Every probe goes through the suite's stubbed `globalThis.fetch`;
  I verified the *tests*, not live upstream behaviour.
- **No real browser.** The A-4 typing defect is reasoned from the `value`/`onChange` wiring at
  `src/client/AccountPool.tsx:1062-1070`, not observed in a DOM.
- **The `tsdown` build step** of `pnpm run check` was verified only for exit 0; I did not audit `lib/*` output.
- **Claims 3 and 1's Host/UI halves** are therefore UNTESTED rather than disproved — the code looks right;
  nothing defends it.

## 8. Reproduce

```bash
SRC=/Users/dmh2002/DshProject/dsh-connect-workbuddy
MUT=/tmp/r3v-mut
rsync -a --exclude .git --exclude .pnpm-store --exclude .dsh-npm-cache "$SRC/" "$MUT/"

# isolated env (matching vitest.config.ts:39) — never test against the real home
source /tmp/r3v-env.sh
cd "$MUT" && npx pnpm run check            # EXIT=0, 651 tests / 29 files

# one mutant, e.g. the M-4 guard evasion
( cd "$MUT" && python3 - src/client/AccountPool.tsx <<'PY'
import sys,pathlib
p=pathlib.Path(sys.argv[1]); s=p.read_text()
a="    } finally {\n"
assert s.count(a)==1
p.write_text(s.replace(a,a+"      onRefresh?.()\n"))
PY
)
cd "$MUT" && npx vitest run                # 651 green -> the guard does not see it
```
Per-mutant outputs: `/tmp/r3v-out-*.txt` (27 files). Harness: `/tmp/r3v-lib.sh` (`unmut`, `apply_py`,
`run_suite`), `/tmp/r3v-env.sh`, `/tmp/r3v-run.sh`.

## 9. Frozen hashes and final state

All eight verified with `shasum -a 256` **before and after** every run, and again at the end — identical:

```
6656c2a2d21319d93214499683b4bb1c02a954c3e5a03a5e6d5bd1cfd0156f96  src/account-pool.ts
291b88614c27d884a6640866fb830c0a310998c74112b1d28f7c46c1120eced9  src/client/pool-state.ts
a608ea4e24ff38cd9a573f29463adde2bc65b35813c6ddfaa57c62cc2a15a602  src/client/AccountPool.tsx
b3b0307c36c71b5aa8b816581496a7caa369eca19d08d183d9affd2383df09e4  src/index.ts
c81c7388d0d09c6a3cf6f7bab95ab9ea0cf2f3fb91b5d84f380482d22c041d0a  src/web-status.ts
f95258d7ad708c61404c44e0140f443d1c3db8268d81f7f4481a994f12d79d91  tests/pool-e2e.spec.ts
dadc075bcbcc2f46ac03c86ab69b93932c26ed5521fc568593ae419a420af08e  tests/account-pool.spec.ts
46542d4705229cefaba393ce7661f3949ad6fbe6713cd1a2cfa85e3c2d3b9e37  tests/pool-state.spec.ts
```

- `diff -rq "$SRC/src" "$MUT/src"` and `.../tests` → identical (all mutants reverted).
- `git status --porcelain` in the repo shows only the pre-existing modifications and untracked files; the
  only addition from this session is this report.
- Real-home sentinel unchanged: `size=35`, `mtime=1790723631`,
  `sha256=35c8297fb847b93e45c075d2bc2dacadad43f7ca37affedb0b0c54c4650678f4`.
