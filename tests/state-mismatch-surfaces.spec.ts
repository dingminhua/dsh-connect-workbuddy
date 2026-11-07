/**
 * 「状态不合拍」—— the pool card and the composer panel must state the SAME thing
 * about the SAME account.
 *
 * The maintainer reported this twice. The first round found the `modelId`
 * read-back loss (a real data-corruption bug, fixed and pinned in
 * `tests/account-pool-store.spec.ts`); it was NOT the whole story, because the
 * mismatched screens came back. Both screenshots in the second report were
 * written at the same second (17:12:47), so this is one moment rendered twice,
 * not two moments being compared:
 *
 *   pool card         dingxiyue       模型繁忙 · 10/15, 17:13 之后可再用 · 约 2 分钟后
 *   composer panel    dingxiyue       (no mark at all)
 *
 * Three separate defects produced that one picture, and each is pinned here.
 *
 * 1. THE PANEL'S SNAPSHOT NEVER MOVED. `fetchAccountCredits` ran only on
 *    `[open, activeRegion]` — so an open panel showed the exclusions as they
 *    were the instant it opened, while the card behind it re-ranked every 60 s
 *    (`POLL_INTERVAL_MS`). dingxiyue's `live-request` failure landed at 17:11:47
 *    and the panel's read had already happened, so it drew no mark. Neither
 *    surface was wrong about ITS OWN data, which is what made the picture so
 *    hard to read.
 *
 * 2. THE BUTTON LABELLED 刷新 REFRESHED THE WRONG HALF. It called `fetchUsage`
 *    alone, so pressing it on the ACCOUNT TABLE refreshed the trigger's balance
 *    and left every row — including its 被限流/模型繁忙 mark — untouched.
 *
 * 3. A STATED TIME WAS DISCARDED, so one of the two rows lied outright.
 *    one account's stored body is the ENGLISH spelling of code 6004:
 *
 *      `usage exceeds frequency limit, but don't worry, your usage will reset at
 *       2026-10-16 11:34:04 UTC+8, …`
 *
 *    `UPSTREAM_RESET_PATTERN` demanded the Chinese keyword 重置, so
 *    `parseUpstreamResetAt` returned `undefined`, `cooldownOf` returned `{}`, and
 *    the record was written with no `retryAtMs` — while its own `message` named
 *    the exact minute. The card then rendered 「被限流 · 上游未给出何时恢复」 about
 *    a body that had just said when, and `retryDue` fell back to 30 minutes
 *    (`POOL_UNKNOWN_COOLDOWN_MS`) instead of the ~18 hours upstream asked for.
 *    This is the honest-absence contract broken in the worse direction: not a
 *    made-up time, but a real one thrown away.
 *
 * The English spelling is not a one-off: issue #63's own body carries it
 * (`will reset at 2026-10-14 23:28:38 UTC+8`), so this service really does use
 * both.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPoolProbes, writePoolProbes } from '../src/account-pool-store.ts'
import { exclusionOf } from '../src/account-pool.ts'
import { parseUpstreamResetAt } from '../src/probe.ts'

/**
 * The maintainer's real stored body, verbatim, from
 * `~/.dsh/.workbuddy-pool.global.json` (account `someone@example.com`).
 * Kept byte-for-byte: the whole bug was that the parser did not recognise this
 * exact wording, so a trimmed fixture would have proved nothing.
 */
const LIVE_ENGLISH_6004
  = '{"code":6004,"msg":"usage exceeds frequency limit, but don\'t worry, your usage will reset at 2026-10-16 11:34:04 UTC+8, alternatively, you can switch to the other models to continue using it.","requestId":"6e9dc068-4340-440a-bcf6-66699f1f8abc"}'

/** The Chinese spelling, already supported — the control for the cases below. */
const LIVE_CHINESE_6004
  = '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-09-30 02:30:30 UTC+8 重置，您也可以切换其他模型继续使用。","requestId":"fd51dd8c-1f48-4a72-a79d-4cf80003f1d4"}'

/** 2026-10-16 11:34:04 UTC+8, the instant the English body names. */
const STATED_RESET = Date.UTC(2026, 9, 16, 3, 34, 4)

/** When the measurement was taken: 2026-10-15 17:02:28 +08. */
const MEASURED_AT = 1792054948128

let home: string
let previousHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-mismatch-'))
  previousHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
})
afterEach(async () => {
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  await rm(home, { force: true, recursive: true })
})

describe('the English 6004 sentence names a time too', () => {
  it('parses the live English body to the exact instant it states', () => {
    // Mutation: restore `UPSTREAM_RESET_PATTERN` (the 重置-only regex) → undefined.
    expect(parseUpstreamResetAt(LIVE_ENGLISH_6004)).toBe(STATED_RESET)
  })

  it('still parses the Chinese body, unchanged', () => {
    // The English support must ADD a spelling, not replace one: the CN gateway
    // is the one that produced this sentence in the first place.
    expect(parseUpstreamResetAt(LIVE_CHINESE_6004)).toBe(Date.UTC(2026, 8, 29, 18, 30, 30))
  })

  it('accepts the other English phrasings the same service could use', () => {
    // Anchored on the marker IMMEDIATELY before the timestamp, so inflections
    // and `refresh` cannot slip past — without loosening it enough to read a
    // timestamp from prose that is not naming a recovery time.
    expect(parseUpstreamResetAt('Your usage resets at 2026-10-16 11:34:04 UTC+8.'))
      .toBe(STATED_RESET)
    expect(parseUpstreamResetAt('Your quota will refresh on 2026-10-16 11:34:04 UTC+8.'))
      .toBe(STATED_RESET)
  })

  it('still refuses English prose that names no offset', () => {
    // The strictness that makes a parsed value trustworthy is unchanged: no
    // UTC offset means no parse, in either language.
    expect(parseUpstreamResetAt('your usage will reset at 2026-10-16 11:34:04.'))
      .toBeUndefined()
  })

  it('does not read a reset time out of the 14003 model-busy envelope', () => {
    // The other outcome that reaches this parser. Its `displayTips` says
    // "Wait about a minute" — prose, no timestamp — and it must stay unparsed:
    // inventing a time here would bench an account for a MODEL's load.
    const busy = '{"code":14003,"msg":"too many requests","retry_policy":{"retry":true},'
      + '"displayTips":{"en":"Wait about a minute before retrying, or switch to another model."}}'
    expect(parseUpstreamResetAt(busy)).toBeUndefined()
  })
})

describe('a stored record whose time was discarded is healed on read', () => {
  /** Write the maintainer's exact stored record: message present, no retryAtMs. */
  const writeStored = async (): Promise<void> => {
    await writeFile(join(home, '.workbuddy-pool.cn.json'), `${JSON.stringify({
      version: 1,
      probes: {
        accountA: {
          outcome: 'rate-limited',
          atMs: MEASURED_AT,
          source: 'test-batch',
          modelId: 'deepseek-v4.1-flash',
          message: LIVE_ENGLISH_6004,
        },
      },
    }, null, 2)}\n`)
  }

  it('recovers the stated time from the body instead of losing it', async () => {
    await writeStored()
    const probes = await readPoolProbes('cn')
    // Mutation: revert the heal in `readPoolProbes`/`retryAtMsOf` → undefined,
    // and the row goes back to claiming 上游未给出何时恢复.
    expect(probes['accountA']?.retryAtMs).toBe(STATED_RESET)
  })

  it('the healed time is what the exclusion rule reads, so both tables agree', async () => {
    // The point of healing on read: `exclusionOf` is the ONE rule behind the
    // pool card's `excludedBy` AND the composer panel's marker. Before the fix
    // the cooldown window was 30 minutes from MEASURED_AT, so the account
    // returned to candidacy at 17:32 — about 18 hours before upstream said.
    await writeStored()
    const probe = (await readPoolProbes('cn'))['accountA']
    const early = MEASURED_AT + 30 * 60_000 + 1_000
    // Still excluded: upstream's stated time has not arrived.
    expect(exclusionOf(probe, early)).toBe('rate-limited')
    // And released once it does.
    expect(exclusionOf(probe, STATED_RESET)).toBeUndefined()
  })

  it('persists the repair, so the parse stops being load-bearing', async () => {
    // Healing on read alone would leave the file wrong forever and re-parse on
    // every read. `writePoolProbes` reads through the healing reader, so the
    // next unrelated write must carry the recovered value to disk.
    await writeStored()
    await writePoolProbes('cn', { unrelated: { outcome: 'ok', atMs: 1 } })
    const disk = JSON.parse(await readFile(join(home, '.workbuddy-pool.cn.json'), 'utf8')) as {
      probes: Record<string, { retryAtMs?: number }>
    }
    expect(disk.probes['accountA']?.retryAtMs).toBe(STATED_RESET)
  })

  it('never invents a time for an outcome that cannot have one', async () => {
    // The narrow scope is the safety property. An `ok` account is not waiting
    // for anything, and `AccountPool.tsx` prints any present `retryAtMs` beside
    // the outcome — so healing an `ok` would render "可用 · <time> 之后可再用"
    // on a perfectly healthy account. `model-busy` is excluded for the opposite
    // reason: its cooldown is a local magnitude, never a body timestamp.
    await writeFile(join(home, '.workbuddy-pool.cn.json'), `${JSON.stringify({
      version: 1,
      probes: {
        healthy: { outcome: 'ok', atMs: 1, message: LIVE_ENGLISH_6004 },
        busy: { outcome: 'model-busy', atMs: 1, message: LIVE_ENGLISH_6004 },
        unknown: { outcome: 'unavailable', atMs: 1, message: LIVE_ENGLISH_6004 },
      },
    }, null, 2)}\n`)
    const probes = await readPoolProbes('cn')
    expect(probes['healthy']?.retryAtMs).toBeUndefined()
    expect(probes['busy']?.retryAtMs).toBeUndefined()
    expect(probes['unknown']?.retryAtMs).toBeUndefined()
  })

  it('lets a stored time win over the body, and reads nothing from no message', async () => {
    // The field, when present, was computed with the FULL input set (Retry-After
    // header, quota-refresh point, body) — re-deriving it could only lose
    // information. And a record with no message stays exactly as it was.
    await writeFile(join(home, '.workbuddy-pool.cn.json'), `${JSON.stringify({
      version: 1,
      probes: {
        explicit: {
          outcome: 'rate-limited',
          atMs: MEASURED_AT,
          retryAtMs: MEASURED_AT + 60_000,
          message: LIVE_ENGLISH_6004,
        },
        silent: { outcome: 'rate-limited', atMs: MEASURED_AT },
      },
    }, null, 2)}\n`)
    const probes = await readPoolProbes('cn')
    expect(probes['explicit']?.retryAtMs).toBe(MEASURED_AT + 60_000)
    expect(probes['silent']?.retryAtMs).toBeUndefined()
  })
})
