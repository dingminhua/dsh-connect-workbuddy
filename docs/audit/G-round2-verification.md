# G — Round-2 verification (adversarial, teammate `round2-verify`)

**Subject revision** — the Lead's frozen round-2 revision. Every hash below was compared
immediately before and after the runs; all eight matched, so nothing here was measured against a
moving tree.

| file | sha256 |
| --- | --- |
| `src/web-status.ts` | `62627e26c65abb9db9c75660ac1000a41d57eefb11f4a08c9e01d5c1846afda4` |
| `src/client/AccountPool.tsx` | `4f70ebbea4c81aa1551ce68a87b706057e492eb7e59b75162eb3f18e6ad3202d` |
| `src/client/pool-state.ts` | `3429b09314ebd9fb36405d1deaa55bbcc67bbcd96141b0888b36193a78d21abd` |
| `src/client/locales.ts` | `2a16b3c0f8efc8351bd65ec58e7304971f99247806312072d48d1b7c13d317cc` |
| `src/account-pool.ts` | `220a6680d26820a4559bbceef4056d871025b52c0f859ea1b62c4279d9696f87` |
| `src/index.ts` | `22f51bbd02f39bba47045255c3527f9804933f976b5e84aca79f8bc6baa3f199` |
| `tests/pool-e2e.spec.ts` | `05362323c6e403302de08d81e9d5c0ce9bae26442317a0e939b6b0a900db72b0` |
| `tests/pool-state.spec.ts` | `b5579c933f650ca40427656eba0803cbf29fb26c9af9d3f3504815195598d929` |

**Method** — falsification, not confirmation. A test that passes on the fixed tree proves nothing,
so for every claimed fix a mutant was built in a throw-away copy of the frozen snapshot
(`/tmp/r2ver/mut`), the mutation was hash-checked to have actually applied
(`NO-OP-PATCH` otherwise), and the new tests had to FAIL on it. Two independent oracles:

* **render oracle** — `/tmp/r2ver/harness`, the real `AccountPool` mounted with React 18.3.1 +
  jsdom, `t` replaced by a key-preserving translator so assertions read locale KEYS, not prose.
  `REPO_ROOT=<tree> ./node_modules/.bin/vitest run` → 14 tests.
* **repo oracle** — the snapshot's own suite, `cd /tmp/r2ver/base && ./node_modules/.bin/vitest run`
  → `Test Files 29 passed (29) / Tests 618 passed (618)`, confirming the Lead's 618/29 claim.

Nothing in the repository was modified by this verification; the only repo write is this file.

---

## 1. Verdicts

| # | Claim under test | Verdict | Discriminating evidence |
| --- | --- | --- | --- |
| 1 | `pool-state.ts` helpers are on the component's **live render path** (highest suspicion) | **CONFIRMED** | M7–M10 (helper internals) and M8a (call-site swap) each kill render tests; all five helpers have a call site in `AccountPool.tsx`; no inline duplicate of their rules remains |
| 2 | H-5 check-in button gated on `effectiveMembers.length === 0` | **CONFIRMED** | M2 → `expected false to be true` in *disables BOTH batch buttons and shows why, on the live render path* |
| 3 | H-5 test button gated the same way | **CONFIRMED** | M1 → same test, same assertion |
| 4 | Route guard `effective ?? saved` → 409 `no-members` / `no-live-members` | **CONFIRMED** | H2 (guard disabled) → `expected 200 to be 409` ×2; H3 (dep returns raw saved) → ghost case `expected 200 to be 409`; H1 (reason collapsed) → `AssertionError: expected 'no-members' to be 'no-live-members'` |
| 5 | The split reason is discriminated by the ghost case and NOT by the companion case | **CONFIRMED** | H1 fails only *H-5: a ghost-only pool is refused…*; the companion (empty list) passes under both |
| 6 | A-12 `saved` base reads `targetModelId \|\| staleTargetModelId \|\| ''` | **CONFIRMED (incl. reachability)** | M5 → 2 failures: `expected '' to be 'model-that-left'` and, in the save test, `expected true to be false`; the clear→save path posts `{field:'regions', value:{<region>:{pool:{targetModelId:''}}}}` |
| 7 | C2-4 both `from` and `to` fall back to `row.accountUnnamed` | **CONFIRMED** | M6a (stopped-`from`), M6b (rotated-`from`), M6c (`to`) each fail one render test |
| 8 | Ghost-only e2e test rewritten to assert 409 | **CONFIRMED** | it fails under H1/H2/H3; before the rewrite it could not have |
| 9 | `createLatestWins` + `rotationGuard.begin(region)` in `applyRotation` | **CONFIRMED (as a pair)** | H4 (token always fresh) → 4 failures; H6 (token + post-await re-read removed) → `expected '9c847c48…' to be undefined` |
| 10 | Lead's negative result: removing ONLY the token still passes the real-plugin race test | **CONFIRMED** | H5 → `Tests 23 passed` on `tests/pool-e2e.spec.ts` |
| 11 | `announcedBatchCount` mirrors the route's `effective ?? saved` and must NOT be draft-aware | **CONFIRMED** | M3 → `expected 'row.poolTitlerow.poolSummary\|count=1\|…' to contain 'row.poolLogCheckinStart\|count=1'`; M4 (draft-aware call site) initially SURVIVED and was closed by strengthening S2b (see §4) |

The Lead's H-5 route comment ("the card localizes from `reason` and never reads `error`") is **false**;
see D2.

---

## 2. Mutation matrix

`bash /tmp/r2ver/mutate.sh` — per mutant: `rsync` the snapshot, apply one `perl -0pi -e` patch,
verify the patch changed the tree (6-file hash guard), run the oracle, print the failing titles and
the first `AssertionError`. Full transcript `/tmp/r2ver/battery.txt`, per-mutant logs in
`/tmp/r2ver/out/<NAME>.log`.

| mutant | change | oracle | result |
| --- | --- | --- | --- |
| M1 | test button → `active.memberAccountIds.length === 0` | render | 1 failed \| 13 passed |
| M2 | check-in button → `saved.memberAccountIds.length === 0` | render | 1 failed |
| M3 | `announcedBatchCount` → `input.savedMembers.length` | render | 1 failed |
| M4 | call site → `savedEffective: effectiveMembers` | render | **survived** → closed by S2b strengthening (§4) |
| M5 | A-12 base → `pool?.targetModelId ?? ''` | render | 2 failed |
| M6a/b/c | `from`/`from`/`to` → bare ids | render | 1 failed each |
| M7 | `rotationLockState` locked reads `active` | render | 1 failed |
| M8a | `effectiveMemberIds` call → `active.memberAccountIds` | render | 1 failed |
| M8b | `ghostMemberIds` → `[]` | render | 1 failed |
| M9 | `usableMemberIds` → whole-table variant | render | 1 failed |
| M10 | `draftBaseFor` → `edit(previous ?? saved)` | render | 1 failed |
| M11 | client `case 'no-live-members'` removed | render | 1 failed |
| H1 | route reason → always `'no-members'` | repo | 1 failed \| 22 passed |
| H2 | `if (runnable.length === 0)` → `if (false)` | repo | 2 failed |
| H3 | host dep → `return [...saved]` | repo | 1 failed |
| H4 | `createLatestWins` token → `() => false` | repo | 4 failed \| 51 passed |
| H5 | delete ONLY `if (stale()) return` | repo | **0 failed (23 passed)** — negative result reproduced |
| H6 | delete the token AND the post-await re-read | repo | 1 failed |
| H7 | client reason case removed, full suite | repo | 618 passed — **not discriminated** (the render oracle catches it) |
| H8a/b | drop `row.poolErrNoLiveMembers` (EN / EN+zh), full suite | repo | 618 passed — **not discriminated** |
| CTRL | unpatched | both | 14 passed / 618 passed |

Two notes on test coverage (not defects):

* **H7/H8** — the repo suite does not pin the client-side reason mapping or its locale text at all;
  H8b deletes the key from BOTH locales and 618 tests still pass. The user-visible recovery sentence
  for a ghost-only pool is guarded by nothing. My render oracle's M11 is currently the only guard.
* **H5** — the `stale()` token is not separately covered, but the post-await re-read makes it
  redundant on the only path that can race, so this is a coverage gap rather than a live defect.

---

## 3. The refactor is not cosmetic (highest-suspicion check)

Read of the frozen `src/client/AccountPool.tsx` — every helper has a call site on the render the user
actually sees, and each one is load-bearing:

| helper | call site | killed by |
| --- | --- | --- |
| `effectiveMemberIds` | `AccountPool.tsx:279-284` → summary count `:695`, both batch buttons `:635-642`, `:643-664`, select-none `:700`, empty warn `:728-731` | M8a |
| `ghostMemberIds` | `:286` → ghost warn `:735-738` | M8b |
| `usableMemberIds` | `:297` → `rotationLocked && usable.length === 0` warn `:680` | M9 |
| `rotationLockState` | `:314-315` → badge `:627`, conflict notice `:1056-1074`, unlock button state | M7 |
| `draftBaseFor` | `:449` inside the `setDraft` updater in `editDraft` | M10 |
| `announcedBatchCount` | `:512-515` → the batch log line `:516-521` | M3 |

`grep` over the component for the five rule names finds no second, inline copy of these rules, so
there is no path where the card keeps its own logic while only the tests use the helpers.

---

## 4. The one mutant that escaped, and why (M4)

M4 replaced the `announcedBatchCount` argument with the *draft-aware* `effectiveMembers` — a plausible
future "simplification". On the first battery it **survived**, so the claim "the announcement is
tested" was, at that moment, false.

Cause (reproduced with a console trace in a hand-built mutant): `runAction` is
`useCallback(async (action) => {…}, [appendLog, pool, region, t])` (`AccountPool.tsx:503-592`). Its
body reads `saved`, `active`, `dirty` and `effectiveMembers`, **none of which are dependencies**, so
the click handler runs with the values of whichever render last changed `pool`. My S2b test toggled a
checkbox and clicked immediately, so the mutant read the pre-toggle closure — the mutant was
invisible until the card's next identity change, which in the real app is the 60-second status
refresh.

Fix to the ORACLE (not to `src/`): S2b now refreshes the `pool` prop (`await m.update({...props, pool: {...poolProp}})`,
exactly what the card's own poll does) before clicking. M4 then fails with

```
× does NOT announce an unsaved draft edit the Host will not run
AssertionError: expected 'row.poolTitlerow.poolSummary|count=2|…' to contain 'row.poolLogCheckinStart|count=1'
Tests  1 failed | 13 passed (14)
```

and the pristine tree stays `Tests 14 passed (14)`. The matrix now has **no surviving mutant**.

Two consequences worth recording:

1. The frozen revision is correct here — the announcement deliberately reads the SAVED pair, which
   mirrors the route's `effective ?? saved` (`src/web-status.ts:833`), and the draft-aware value
   would announce edits the Host will not run. Verified by S2b's positive/negative pair.
2. `runAction`'s dependency array is a latent trap: the only state-derived read in that body today is
   draft-independent, so the stale closure is harmless *now*, but any future draft-aware read inside
   it is silently stale for up to one poll interval. See D5.

---

## 5. New defects found during verification

### D1 (medium) — four different upstream outcomes collapse into one permanent-looking label

`exclusionOf` (`src/account-pool.ts:133-156`) maps `credential-rejected`, `not-found`, `failed` and
`unavailable` all to `'credential-rejected'`, with **no cooldown**; only `rate-limited` and
`out-of-credit` consult `retryDue`/`POOL_UNKNOWN_COOLDOWN_MS`.

`outcomeOfFailure` (`src/probe.ts:290-299`) produces `'unavailable'` for `status === 0 || status >= 500`
— i.e. a timeout or an upstream outage, which is *not* a credential problem.

The card then renders both facts side by side in the same row:

* name column — `exclusionText` → `row.poolExcludedRejected` ("Rejected", zh "被拒绝")
* probe column — `outcomeText` → `row.probeUnavailable` ("✗ The upstream could not be reached — this
  is a network problem, not the model")

Reproduced on a real mount (`/tmp/r2ver/probe/row.spec.tsx`, 4 tests): the row for a member whose
stored probe is `{outcome: 'unavailable'}` contains BOTH keys. Control: a genuine
`credential-rejected` probe shows `row.poolExcludedRejected` + `row.probeCredentialRejected` and no
contradiction. `exclusion.spec.ts` (6 tests) pins the mechanism at the function level:
`exclusionOf({outcome:'unavailable'}, NOW + 365 days)` still returns `'credential-rejected'`, while
`rate-limited` clears at `POOL_UNKNOWN_COOLDOWN_MS` and `out-of-credit` honours a stated `retryAtMs`.

Impact: the user is told to re-sign-in (the natural reading of "Rejected") for what is very often a
five-minute network blip. The fix is a distinct exclusion kind (or no exclusion) for `unavailable`.

**Bounded, though:** the exclusion is not permanent — the next batch re-probes every member
(`poolMemberAccounts` filters on membership only, `src/index.ts:1123-1130`) and a healthy probe clears
it. Verified end-to-end in §6.

### D2 (low) — the route's `reason`-only contract is false; a zh user sees English

`src/web-status.ts:838` states the card "localizes from `reason` and never reads `error`". The card
does read it: `throw new Error(poolErrorText(t, body?.reason) ?? body?.error ?? \`HTTP ${status}\`)`
(`AccountPool.tsx:536`). Every pool-route response that carries no `reason` — the three 503s
(`account pool unavailable`, `pool check-in unavailable`, `pool test unavailable`), the 500
`safeMessage(error)`, and the 403/405/400 refusals — therefore reaches the log verbatim in English.

Reproduced (`row.spec.tsx`): a 503 `{error:'pool check-in unavailable'}` yields
`row.poolLogBatchFailed|message=pool check-in unavailable` with no `row.poolErr*` key anywhere;
control 409 `{reason:'no-live-members'}` yields `row.poolLogBatchFailed|message=row.poolErrNoLiveMembers`.
Not covered by the repo suite (H7/H8).

### D3 (low) — `unavailable` heals only by being re-probed, and three early returns skip the probe

`runScheduledPoolTest` (`src/index.ts:1329-1340`) returns silently when there are no members, when the
saved target no longer exists, or when no free model is offered. `exclusionOf` gives `unavailable` no
clock, so in those states the account stays benched with no way for the timer to notice.

Demonstrated with the REAL plugin and the real scheduler (`/tmp/r2ver/sched/tests/g-heal.spec.ts`,
4 tests, all passing on the frozen tree):

* recovery — a member seeded `{outcome:'unavailable'}` with the upstream healthy is re-probed on the
  next due tick and returns to `ok` with `excludedBy` undefined (`chatCalls` 0 → 1, so the batch
  really ran);
* control — same seed, upstream still 500: re-probed, `unavailable`, still excluded;
* asymmetry — with a stale saved target the batch never runs at all (12 intervals, `chatCalls === 0`,
  probe `atMs` unchanged) and the `unavailable` member stays `credential-rejected`;
* the same stale-target state clears the `rate-limited` member on the clock alone, with the probe
  still untouched — the asymmetry is real and observable.

### D4 (medium, test integrity) — the only e2e test that claims the scheduler acts cannot observe it

`tests/pool-e2e.spec.ts` → *the pool scheduler actually runs a due region → arms on the first tick,
then probes and re-ranks once the interval passes*. Its own comment says "this proves the mounted
plugin ACTS on it". It does not, for two independent reasons:

1. it mounts `pool: {memberAccountIds: []}`, so a woken scheduler has nothing to do — and it then
   asserts `expect(probes).toBe(0)` on both ticks, which is exactly what a dead timer produces;
2. it mounts on REAL timers and only then calls `vi.useFakeTimers()`, but the heartbeat is a
   `setInterval` created inside `apply()` (`src/index.ts:1281`), so the interval belongs to the real
   clock and `vi.advanceTimersByTimeAsync` never fires it.

My first attempt at driving the scheduler reproduced both halves: `chatCalls = 0`, and the control
test "passed" with the batch never running. Only after installing the fake clock **before**
`WorkBuddy.apply(...)` did the batch run (probe `unavailable` → `ok`, `excludedBy` gone), which is
what §6's numbers come from. The same vacuity affects the neighbouring case *does not probe anything
before a full interval has elapsed* (`memberAccountIds: ['x']` is not a local sign-in, so its batch is
a no-op too).

This is the same class as the ghost-only e2e case the Lead already rewrote: an assertion that a
correct implementation and an absent implementation both satisfy. Suggested repair: install fake
timers before mounting, check in a real member, and assert `probes` becomes ≥ 1 after one interval
(and, for re-ranking, that `store.rotatedAccount` was written).

### D5 (low, latent) — `runAction`'s `useCallback` dependencies

Covered in §4. `[appendLog, pool, region, t]` while the body reads `saved`, `active`, `dirty` and
`effectiveMembers`. Harmless in the frozen revision, and the reason a draft-aware variant can hide
behind a stale closure for one poll interval. Adding the missing values would make the coupling
explicit.

### D6 (informational) — five independent implementations of "effective members"

`web-status.ts:636-638` (status document), `web-status.ts:830-833` (route guard), `index.ts:892-898`
(host dep), `index.ts:1123-1130` (`poolMemberAccounts`, deliberately not exclusion-filtered), and
`pool-state.ts:effectiveMemberIds` (card). They agree today; this is the exact shape that produced the
five earlier "fixed one end, missed the other" defects.

---

## 6. What I could NOT verify

* **Prose, not keys.** The render oracle swaps `t` for a key-preserving translator, so it proves the
  right locale KEY is reached; I read both locale tables to confirm the keys exist in EN and zh, but I
  did not assert their text in a mounted component.
* **Browser rendering.** jsdom only; no real browser, CSS, or layout was exercised.
* **The real Host loader.** The scheduler results come from the plugin's own `apply()` inside the test
  process; the volatile/DYNAMIC config lines the DSH Loader uses were not exercised.
* **`row.poolErrNoLiveMembers` text and the client reason mapping** are unguarded by the repo suite
  (H7/H8); my oracle pins the mapping, nothing pins the wording.
* **Documented-unfixed defects** (`M-4`, `L-5`, the `A-8` window) were not re-tested; they are out of
  this round's scope and remain as the fix log leaves them.

---

## 7. Reproduce

```bash
cd /tmp/r2ver/base  && ./node_modules/.bin/vitest run                  # 618 passed (29 files)
cd /tmp/r2ver/harness && REPO_ROOT=/tmp/r2ver/base ./node_modules/.bin/vitest run   # 14 passed
cd /tmp/r2ver/probe   && REPO_ROOT=/tmp/r2ver/base ./node_modules/.bin/vitest run exclusion.spec.ts row.spec.tsx  # 10 passed (exclusion 6, row 4)
cd /tmp/r2ver/sched   && ./node_modules/.bin/vitest run tests/g-heal.spec.ts        # 4 passed
bash /tmp/r2ver/mutate.sh                                             # 21 mutants + 2 controls
```

All four suites isolate `DSH_HOME`, `HOME`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA` and
`XDG_CONFIG_HOME` into per-run temp directories (`vitest.config.ts:39` does the same for the repo
suite), so no real `~/.dsh` state is touched. Every mutation copy lives under `/tmp`; the frozen
revision is byte-identical to §0 after the runs.
