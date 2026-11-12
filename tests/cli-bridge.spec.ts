/**
 * The CLI route: settings, credentials, the working-directory ladder, both
 * host entrances, and the message handed back to the session's model.
 *
 * Why these are tests and not "it works on my machine": the route's whole claim
 * is that it is SAFE TO ADD. Three properties carry that claim and each one is
 * a single line away from being silently false —
 *
 * 1. it is off unless the user turns it on (`enabled`), and it registers
 *    NOTHING when it is off or when the Host publishes no tools/commands;
 * 2. it never picks a directory on the user's behalf (an agent that can edit
 *    files must not be pointed at a tree nobody chose);
 * 3. its tool schema stays inside the Host's CLOSED JSON-Schema subset — a
 *    single array-typed `type` makes `apply()` throw and the WHOLE plugin stop
 *    loading, which is a failure mode with no visible cause.
 *
 * Every one of those is asserted below rather than described.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  CLI_BRIDGE_DEFAULTS,
  createCliBridgeRuntime,
  mountCliBridge,
  normalizeCliBridgeOptions,
} from '../src/cli-bridge/mount.ts'
import { TurnGate } from '../src/cli-bridge/gate.ts'
import type { CliBridgeSettings } from '../src/cli-bridge/mount.ts'
import { AUTH_TOKEN_ENV, resolveCredentials } from '../src/cli-bridge/credentials.ts'
import type { BridgeCredentialRegion } from '../src/cli-bridge/credentials.ts'
import {
  COMMAND_NAME,
  EDIT_FLAG,
  commandScopeLabel,
  composeCommandPrompt,
  formatCommandOutcome,
  isReviewInvocation,
  mountCodebuddyCommand,
  parseCommandInput,
  permissionModeForInvocation,
} from '../src/cli-bridge/command.ts'
import { composeContinuation, formatInjection, injectOutcome, INJECT_TEXT_LIMIT } from '../src/cli-bridge/inject.ts'
import type { BridgeAgent } from '../src/cli-bridge/inject.ts'
import { readProjectedState } from '../src/cli-bridge/services.ts'
import type { BridgeCommandDefinition, BridgeToolDefinition, BridgeToolExecution } from '../src/cli-bridge/services.ts'
import type { DirectoryOf } from '../src/cli-bridge/tool.ts'
import {
  EFFORT_LEVELS,
  MAX_REPLY_CHARS_CAP,
  MAX_TURNS_CAP,
  PERMISSION_MODES,
  SESSION_CONTINUITY_MODES,
  TIMEOUT_SECS_CAP,
  forgetCliSession,
  mountAskTool,
  recallCliSession,
  rememberCliSession,
  resolveWorkingDir,
  runAsk,
} from '../src/cli-bridge/tool.ts'
import type { AskResult, BridgeOptions } from '../src/cli-bridge/tool.ts'

/** A fully-defaulted options object, so each test names only what it changes. */
function options(overrides: Partial<BridgeOptions> = {}): BridgeOptions {
  return {
    enabled: true,
    binary: '',
    model: '',
    permissionMode: CLI_BRIDGE_DEFAULTS.permissionMode,
    effort: '',
    maxTurns: 10,
    timeoutSecs: 900,
    regionOrder: ['cn', 'global'],
    workingDir: '',
    allowedDirs: [],
    appendSystemPrompt: '',
    allowUnattended: false,
    maxReplyChars: 60_000,
    injectResult: true,
  sessionContinuity: 'auto',
    maxTurnsPerSessionHour: 6,
    maxTurnsPerHour: 20,
    ...overrides,
  }
}

/** A result object with every field at its neutral value. */
const empty: AskResult = {
  ok: true,
  reply: '',
  session_id: '',
  tools: [],
  denied_tools: [],
  tool_calls: 0,
  num_turns: 0,
  tokens_in: 0,
  tokens_out: 0,
  cache_read_tokens: 0,
  credential_region: '',
  working_dir: '',
  unattended: false,
  elapsed_ms: 0,
  truncated: false,
  error: '',
}

/** A store that answers from a literal table, so ordering is observable. */function region(regionName: string, accounts: ReadonlyArray<{ id: string, expiresAtMs: number }>): BridgeCredentialRegion {
  return {
    region: regionName,
    store: {
      async accounts() {
        return accounts.map(account => ({ id: account.id, tokenExpiresAtMs: account.expiresAtMs }))
      },
      async credentialFor(accountId: string) {
        const found = accounts.find(account => account.id === accountId)
        return found === undefined ? undefined : { accessToken: `token-${accountId}`, expiresAtMs: found.expiresAtMs }
      },
    },
  }
}

/** The smallest live agent the injection path touches. */
function agent(status: string | undefined): BridgeAgent & { calls: string[] } {
  const calls: string[] = []
  return {
    ...status === undefined ? {} : { status },
    calls,
    inject() { calls.push('inject') },
    steer() { calls.push('steer') },
  }
}

describe('normalizeCliBridgeOptions', () => {
  it('is OFF when the settings are absent, so an existing install is unchanged', () => {
    const resolved = normalizeCliBridgeOptions(undefined)
    expect(resolved.enabled).toBe(false)
    expect(resolved.permissionMode).toBe(CLI_BRIDGE_DEFAULTS.permissionMode)
    expect(resolved.maxTurns).toBe(CLI_BRIDGE_DEFAULTS.maxTurns)
  })

  it('is OFF for every value except a literal true', () => {
    // A config file is user-editable text. `"enabled": "true"` must not turn on
    // a route that runs a file-editing agent.
    for (const value of ['true', 1, 'yes', null] as unknown[]) {
      expect(normalizeCliBridgeOptions({ enabled: value as boolean }).enabled).toBe(false)
    }
    expect(normalizeCliBridgeOptions({ enabled: true }).enabled).toBe(true)
  })

  it('clamps the turn budget and the wall clock to their hard ceilings', () => {
    const high = normalizeCliBridgeOptions({ maxTurns: 9_999, timeoutSecs: 99_999 })
    expect(high.maxTurns).toBe(MAX_TURNS_CAP)
    expect(high.timeoutSecs).toBe(TIMEOUT_SECS_CAP)
    // Zero and negatives are floored at 1 rather than disabling the bound.
    const low = normalizeCliBridgeOptions({ maxTurns: 0, timeoutSecs: -5 })
    expect(low.maxTurns).toBe(1)
    expect(low.timeoutSecs).toBe(1)
    const capped = normalizeCliBridgeOptions({ maxReplyChars: 10_000_000 })
    expect(capped.maxReplyChars).toBe(MAX_REPLY_CHARS_CAP)
  })

  it('replaces an out-of-range enum with the default AND says so', () => {
    const rejected: string[] = []
    const resolved = normalizeCliBridgeOptions(
      { permissionMode: 'yolo', effort: 'turbo' },
      message => rejected.push(message),
    )
    expect(resolved.permissionMode).toBe(CLI_BRIDGE_DEFAULTS.permissionMode)
    expect(resolved.effort).toBe('')
    // Silently running under a permission level the user did not choose is the
    // failure this guards: a typo must be visible, not absorbed.
    expect(rejected).toHaveLength(2)
    expect(rejected[0]).toContain('yolo')
    expect(rejected[1]).toContain('turbo')
  })

  it('accepts every documented enum value without complaining', () => {
    for (const mode of PERMISSION_MODES) {
      const rejected: string[] = []
      expect(normalizeCliBridgeOptions({ permissionMode: mode }, m => rejected.push(m)).permissionMode).toBe(mode)
      expect(rejected).toEqual([])
    }
    for (const level of EFFORT_LEVELS) {
      const rejected: string[] = []
      expect(normalizeCliBridgeOptions({ effort: level }, m => rejected.push(m)).effort).toBe(level)
      expect(rejected).toEqual([])
    }
  })

  it('turns the region order into a list, dropping blanks', () => {
    expect(normalizeCliBridgeOptions({ regionOrder: ' global , cn ,,' }).regionOrder).toEqual(['global', 'cn'])
    expect(normalizeCliBridgeOptions({ regionOrder: '   ' }).regionOrder).toEqual([])
  })

  it('keeps injection on unless it was explicitly turned off', () => {
    expect(normalizeCliBridgeOptions({}).injectResult).toBe(true)
    expect(normalizeCliBridgeOptions({ injectResult: false }).injectResult).toBe(false)
  })
})

describe('resolveCredentials', () => {
  const original = process.env[AUTH_TOKEN_ENV]
  afterEach(() => {
    if (original === undefined) delete process.env[AUTH_TOKEN_ENV]
    else process.env[AUTH_TOKEN_ENV] = original
  })

  it('lets the environment variable short-circuit the vault', async () => {
    process.env[AUTH_TOKEN_ENV] = '  env-token  '
    const found = await resolveCredentials([region('cn', [{ id: 'a', expiresAtMs: 1 }])], ['cn'], () => {})
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ token: 'env-token', region: 'env' })
  })

  it('ranks REGION before freshness, because a later expiry is not a live token', async () => {
    // The real machine's shape: the global backup claims a later expiry than the
    // domestic sign-in, and the domestic endpoint 401s the global token. Ranking
    // by expiry alone picks the wrong one on every start.
    const found = await resolveCredentials(
      [
        region('global', [{ id: 'g', expiresAtMs: 9_999_999_999_999 }]),
        region('cn', [{ id: 'c', expiresAtMs: 1_000 }]),
      ],
      ['cn', 'global'],
      () => {},
    )
    expect(found.map(credential => credential.region)).toEqual(['cn', 'global'])
  })

  it('sorts within one region by freshness', async () => {
    const found = await resolveCredentials(
      [region('cn', [{ id: 'old', expiresAtMs: 1 }, { id: 'new', expiresAtMs: 2 }])],
      ['cn'],
      () => {},
    )
    expect(found.map(credential => credential.source)).toEqual(['cn 账号 new', 'cn 账号 old'])
  })

  it('keeps an expired token, last, instead of reporting "not signed in"', async () => {
    const found = await resolveCredentials(
      [region('cn', [{ id: 'dead', expiresAtMs: 1 }])],
      ['cn'],
      () => {},
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.expired).toBe(true)
  })

  it('names the fix when nothing is available', async () => {
    delete process.env[AUTH_TOKEN_ENV]
    await expect(resolveCredentials([], ['cn'], () => {})).rejects.toThrow(AUTH_TOKEN_ENV)
  })
})

/**
 * Real directories for the working-directory tests.
 *
 * This block used to assert `resolveWorkingDir` on invented paths like `C:/repo`,
 * which pinned the behaviour the maintainer had to reject: the function returned
 * whatever the caller named. It now demands that the directory exists, is a
 * directory, and resolves inside an allowed root — so the tests need a real tree
 * with an inside, a child, an allowed-but-separate root, and an outside.
 */
let base = ''
let sessionDir = ''
let sessionChild = ''
let allowedDir = ''
let outsideDir = ''

beforeAll(async () => {
  // Canonicalise the root before deriving anything from it: on macOS `tmpdir()` is
  // `/var/folders/...`, which is a symlink to `/private/var/...`, while
  // `resolveWorkingDir` returns realpaths — comparing the two spellings fails.
  base = await realpath(await mkdtemp(join(tmpdir(), 'wb-bridge-dir-')))
  sessionDir = join(base, 'session')
  sessionChild = join(sessionDir, 'packages', 'app')
  allowedDir = join(base, 'allowed')
  outsideDir = join(base, 'outside')
  for (const dir of [sessionChild, allowedDir, outsideDir]) await mkdir(dir, { recursive: true })
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

/** The execution handle a tool call arrives with on a real Host. */
function executionIn(dir: string): BridgeToolExecution {
  return { agent: { id: 'session-1', session: { header: { cwd: dir } } } }
}

/**
 * An execution whose session carries a LIVE working directory as well as a header.
 *
 * The Host's `workingDirectory` projection is not the session header — it is separate
 * state that starts from the header and then moves on every `/cd`. This is what a
 * session looks like after the human changed directory at least once, which is
 * exactly the case the header cannot answer.
 */
function executionInProjected(headerDir: string, liveDir: string | null): BridgeToolExecution {
  return {
    agent: { id: 'session-1', session: { header: { cwd: headerDir }, workingDirectory: liveDir } },
  }
}

/**
 * A `DirectoryOf` shaped like the Host's reader: it answers with the projection
 * held by the session it is handed, and `null` when that session never committed
 * one. Every other answer — a relative path, a non-string — is a Host bug, and
 * the tests for that pass the bad value through the session object directly.
 */
function projectionOf(): DirectoryOf {
  return (session: unknown) => {
    const live = (session as { workingDirectory?: unknown } | undefined)?.workingDirectory
    return typeof live === 'string' && live.trim() !== '' ? live : null
  }
}

describe('resolveWorkingDir', () => {
  it('prefers the explicit argument over the session and the configured default', () => {
    // Inside the session tree, so it is allowed — and it is still the argument
    // that wins, not the session root or the configured default.
    const choice = resolveWorkingDir(
      { working_dir: ` ${sessionChild} ` },
      options({ workingDir: allowedDir }),
      executionIn(sessionDir),
    )
    expect(choice).toMatchObject({ ok: true, unattended: false })
    expect(choice.dir).toContain('packages')
  })

  it('uses the session directory when the call did not name one', () => {
    expect(resolveWorkingDir({}, options(), executionIn(sessionDir))).toMatchObject({
      ok: true,
      unattended: false,
    })
  })

  // The three tests below pin the one behaviour this change is about: where a
  // turn's directory comes from when the human has moved the session somewhere
  // since it was opened.
  //
  // `sessionDir` is the header (the directory the session was OPENED with) and
  // `allowedDir` is the live projection (where the human `cd`'d to). They are two
  // different real directories in this block, so a test can tell them apart.
  it('prefers the live projection over the session header', () => {
    const choice = resolveWorkingDir(
      {},
      options(),
      executionInProjected(sessionDir, allowedDir),
      projectionOf(),
    )
    expect(choice).toMatchObject({ ok: true, unattended: false })
    // The header would have produced `sessionDir`; the projection wins, so the
    // assertion is on the projection's path and nothing else.
    expect(choice.dir).toBe(realpathSync(allowedDir))
  })

  it('falls back to the session header when the projection is empty', () => {
    // A Host that has no committed directory for this session is the ordinary
    // state of a freshly opened session, and the header is still the right answer
    // for it.
    const choice = resolveWorkingDir(
      {},
      options(),
      executionInProjected(sessionDir, null),
      projectionOf(),
    )
    expect(choice).toMatchObject({ ok: true, unattended: false })
    expect(choice.dir).toBe(realpathSync(sessionDir))
  })

  it('ignores a projection that is not an absolute path', () => {
    // The Host validates its own projections, but this plugin reads a structure it
    // does not own. A relative value must not reach the CLI's cwd.
    const choice = resolveWorkingDir(
      {},
      options(),
      executionInProjected(sessionDir, 'packages/app'),
      projectionOf(),
    )
    expect(choice).toMatchObject({ ok: true, unattended: false })
    expect(choice.dir).toBe(realpathSync(sessionDir))
  })

  // The projection is the live answer, but it can go STALE — the directory was
  // deleted, moved, or is an offline mount — while the creation-time header
  // still names a directory that exists. The ladder falls back to the header in
  // that case instead of refusing, and says so when even the header is gone.
  it('falls back to the header when the projection directory no longer exists', () => {
    const stale = join(base, 'deleted-by-cd')
    const choice = resolveWorkingDir(
      {},
      options(),
      executionInProjected(sessionDir, stale),
      projectionOf(),
    )
    expect(choice).toMatchObject({ ok: true, unattended: false })
    expect(choice.dir).toBe(realpathSync(sessionDir))
  })

  it('refuses, naming both sources, when the projection and the header are both unusable', () => {
    // Two DIFFERENT stale paths: an equal projection/header pair collapses into
    // one candidate, and the fallback message is about the pair disagreeing.
    const staleProjection = join(base, 'deleted-by-cd')
    const staleHeader = join(base, 'deleted-before-open')
    const choice = resolveWorkingDir(
      {},
      options(),
      executionInProjected(staleHeader, staleProjection),
      projectionOf(),
    )
    expect(choice.ok).toBe(false)
    expect(choice.dir).toBe('')
    // The refusal must implicate BOTH sources, so the next reader does not have
    // to guess which of the two the message is about.
    expect(choice.reason).toContain(staleProjection)
    expect(choice.reason).toContain(staleHeader)
    expect(choice.reason).toContain('都失效')
  })

  it('does not fall back from an explicit argument that fails validation', () => {
    // The fallback exists for a source nobody chose THIS turn (the projection).
    // An explicit working_dir is the caller's own statement; swapping it for the
    // session header would hide a caller mistake.
    const stale = join(base, 'deleted-by-cd')
    const choice = resolveWorkingDir(
      { working_dir: stale },
      options(),
      executionInProjected(sessionDir, stale),
      projectionOf(),
    )
    expect(choice.ok).toBe(false)
    expect(choice.reason).toBe(`working_dir "${stale}" 不存在。`)
  })
  it('degrades to the configured default, not to the Host process directory', () => {
    // THE TEST THAT PINS THE WHOLE DESIGN. The Host's own reader answers
    // `stateOf(...) ?? defaultDirectory`, and `defaultDirectory` is the Host process's
    // cwd — a directory nobody chose. A bridge that copied that behaviour would
    // answer every "where are we" question with the Host's own install directory.
    // So: no projection AND no header must land on the CONFIGURED default, and
    // when there is no configured default either, it must refuse.
    const withConfigured = resolveWorkingDir(
      {},
      options({ workingDir: allowedDir }),
      executionInProjected('', null),
      projectionOf(),
    )
    expect(withConfigured).toMatchObject({ ok: true, dir: allowedDir, unattended: false })

    const withoutAnything = resolveWorkingDir(
      {},
      options(),
      executionInProjected('', null),
      projectionOf(),
    )
    // A refusal carries an empty `dir` by construction, so "dir !==
    // process.cwd()" would pass unconditionally. Pin the refusal itself: an
    // empty dir, and a reason that never names the Host process directory.
    expect(withoutAnything.ok).toBe(false)
    expect(withoutAnything.dir).toBe('')
    expect(withoutAnything.reason).not.toContain(realpathSync(process.cwd()))
  })

  it('falls back to the configured default', () => {
    expect(resolveWorkingDir({}, options({ workingDir: allowedDir }), undefined)).toMatchObject({
      ok: true,
      dir: allowedDir,
      unattended: false,
    })
  })

  it('refuses rather than guessing a directory, and names all three ways out', () => {
    const choice = resolveWorkingDir({}, options(), undefined)
    expect(choice.ok).toBe(false)
    expect(choice.dir).toBe('')
    // The message is the user-facing documentation of this failure; each escape
    // hatch has to be discoverable from it.
    expect(choice.reason).toContain('working_dir')
    expect(choice.reason).toContain('allow_unattended')
    expect(choice.reason).toContain('插件配置')
  })

  it('uses a scratch directory only when the caller explicitly allowed it', () => {
    const viaArg = resolveWorkingDir({ allow_unattended: true }, options(), undefined)
    expect(viaArg).toMatchObject({ ok: true, unattended: true })
    expect(viaArg.dir).not.toBe('')

    const viaConfig = resolveWorkingDir({}, options({ allowUnattended: true }), undefined)
    expect(viaConfig).toMatchObject({ ok: true, unattended: true })
  })

  // The four checks below are the whole reason this ladder is safe to ship. Each
  // one used to "pass" by being absent — the function simply returned the path.
  it('refuses an absolute path that does not exist', () => {
    const choice = resolveWorkingDir({ working_dir: join(base, 'gone') }, options(), executionIn(sessionDir))
    expect(choice.ok).toBe(false)
    expect(choice.reason).toContain('不存在')
  })

  it('refuses a path that exists but is a file, not a directory', async () => {
    const file = join(sessionDir, 'notes.txt')
    await writeFile(file, 'x')
    const choice = resolveWorkingDir({ working_dir: file }, options(), executionIn(sessionDir))
    expect(choice.ok).toBe(false)
    expect(choice.reason).toContain('不是一个目录')
  })

  it('refuses a relative path, because the CLI cwd must be absolute', () => {
    const choice = resolveWorkingDir({ working_dir: 'repo' }, options(), executionIn(sessionDir))
    expect(choice.ok).toBe(false)
    expect(choice.reason).toContain('绝对路径')
  })

  it('refuses an existing directory outside every allowed root', () => {
    // This is the maintainer's exact example: `~/.ssh` exists and is a
    // directory, so existence alone is not a guard.
    const choice = resolveWorkingDir({ working_dir: outsideDir }, options(), executionIn(sessionDir))
    expect(choice.ok).toBe(false)
    expect(choice.reason).toContain('不在本回合允许的范围内')
    // A refusal that does not say how to widen the scope is a dead end.
    expect(choice.reason).toContain('allowedDirs')
  })

  it('accepts an outside directory once it is listed in allowedDirs', () => {
    const choice = resolveWorkingDir(
      { working_dir: outsideDir },
      options({ allowedDirs: [outsideDir] }),
      executionIn(sessionDir),
    )
    expect(choice).toMatchObject({ ok: true, unattended: false })
  })

  it('accepts a subdirectory of an allowed root but not a sibling sharing a prefix', () => {
    const nested = resolveWorkingDir({ working_dir: sessionChild }, options(), executionIn(sessionDir))
    expect(nested.ok).toBe(true)
    // `.../session-evil` must not be read as inside `.../session` by a bare
    // string prefix comparison.
    const sibling = resolveWorkingDir(
      { working_dir: join(base, 'session-evil') },
      options(),
      executionIn(sessionDir),
    )
    expect(sibling.ok).toBe(false)
  })
})

describe('runAsk argument validation', () => {
  const deps = { options: options(), regions: [] as BridgeCredentialRegion[], log: () => {} }

  it('refuses an empty message before touching the CLI', async () => {
    const value = await runAsk({ message: '   ' }, undefined, deps)
    expect(value.ok).toBe(false)
    expect(value.error).toContain('message')
  })

  it('refuses an unknown permission mode and lists the legal ones', async () => {
    const value = await runAsk({ message: 'x', working_dir: sessionDir, permission_mode: 'yolo' }, undefined, deps)
    expect(value.ok).toBe(false)
    expect(value.error).toContain('yolo')
    expect(value.error).toContain('acceptEdits')
  })

  it('refuses an unknown effort level', async () => {
    const value = await runAsk({ message: 'x', working_dir: sessionDir, effort: 'turbo' }, undefined, deps)
    expect(value.ok).toBe(false)
    expect(value.error).toContain('turbo')
  })

  it('reports a missing working directory instead of choosing one', async () => {
    const value = await runAsk({ message: 'x' }, undefined, deps)
    expect(value.ok).toBe(false)
    expect(value.error).toContain('working_dir')
  })

  it('removes the scratch directory when the gate refuses the turn', async () => {
    // The scratch directory is created while resolving the working directory,
    // BEFORE the gate runs. A refusal used to return straight out of the
    // function, leaving one empty `dsh-codebuddy-scratch-*` behind per attempt —
    // so a client retrying against a full quota littered the OS temp directory.
    const gate = new TurnGate({ perSessionPerHour: 1, globalPerHour: 1, allowConcurrentPerSession: false })
    const spent = gate.tryEnter('codebuddy_ask', () => {})
    if (spent.ok) spent.release()

    const scratchPrefix = 'dsh-codebuddy-scratch-'
    const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith(scratchPrefix)))
    const value = await runAsk({ message: 'x', allow_unattended: true }, undefined, { ...deps, gate })
    expect(value.ok).toBe(false)
    expect(value.error).toContain('上限')
    const leaked = readdirSync(tmpdir()).filter(name => name.startsWith(scratchPrefix) && !before.has(name))
    expect(leaked).toEqual([])
  })
})

describe('turn gate', () => {
  /** A clock the test moves by hand, so no test waits for an hour. */
  function clock(start = 1_000_000) {
    let at = start
    return {
      now: () => at,
      advance: (ms: number) => { at += ms },
    }
  }

  const limits = { perSessionPerHour: 2, globalPerHour: 3, allowConcurrentPerSession: false }

  it('lets one turn in and refuses the second concurrent one in the same session', () => {
    const gate = new TurnGate(limits)
    const first = gate.tryEnter('s1', () => {})
    expect(first.ok).toBe(true)
    // A second turn in the same session is refused while the first is live: two
    // agents editing one workspace is the failure this prevents.
    expect(gate.tryEnter('s1', () => {})).toMatchObject({ ok: false, code: 'busy' })
    // A DIFFERENT session is unaffected by that busy slot.
    expect(gate.tryEnter('s2', () => {}).ok).toBe(true)
  })

  it('frees the session when the turn is released, and only once', () => {
    const gate = new TurnGate(limits)
    const entry = gate.tryEnter('s1', () => {})
    if (!entry.ok) throw new Error('expected the first entry to be accepted')
    entry.release()
    entry.release() // idempotent: a double release must not corrupt the count
    expect(gate.isBusy('s1')).toBe(false)
    expect(gate.spentBySession('s1')).toBe(1)
  })

  it('refuses on the per-session quota and names the config key that raises it', () => {
    const gate = new TurnGate(limits)
    const messages: string[] = []
    for (let index = 0; index < 2; index += 1) {
      const entry = gate.tryEnter('s1', message => messages.push(message))
      if (!entry.ok) throw new Error('expected the first two turns in')
      entry.release()
    }
    // Charged on ENTRY, and kept: the third is refused even though the first two
    // completed.
    const refused = gate.tryEnter('s1', message => messages.push(message))
    expect(refused).toMatchObject({ ok: false, code: 'session-quota' })
    expect(messages.join('\n')).toContain('maxTurnsPerSessionHour')
  })

  it('refuses on the global quota even across different sessions', () => {
    const gate = new TurnGate({ perSessionPerHour: 0, globalPerHour: 2, allowConcurrentPerSession: false })
    gate.tryEnter('s1', () => {}).ok
    gate.tryEnter('s2', () => {})
    expect(gate.tryEnter('s3', () => {})).toMatchObject({ ok: false, code: 'global-quota' })
    expect(gate.spentTotal()).toBe(2)
  })

  it('forgets older turns when the window slides past them', () => {
    const time = clock()
    const gate = new TurnGate({ perSessionPerHour: 1, globalPerHour: 1, allowConcurrentPerSession: false }, time.now)
    const entry = gate.tryEnter('s1', () => {})
    if (!entry.ok) throw new Error('expected the first turn in')
    entry.release()
    expect(gate.tryEnter('s1', () => {})).toMatchObject({ ok: false, code: 'session-quota' })
    time.advance(60 * 60 * 1000 + 1)
    expect(gate.tryEnter('s1', () => {}).ok).toBe(true)
  })

  it('treats 0 as unbounded, so an explicit opt-out is honoured', () => {
    const gate = new TurnGate({ perSessionPerHour: 0, globalPerHour: 0, allowConcurrentPerSession: true })
    for (let index = 0; index < 25; index += 1) expect(gate.tryEnter('s1', () => {}).ok).toBe(true)
    expect(gate.spentBySession('s1')).toBe(25)
  })

  it('forgets everything on clear, which is what the mount disposer calls', () => {
    const gate = new TurnGate(limits)
    gate.tryEnter('s1', () => {})
    gate.clear()
    expect(gate.spentTotal()).toBe(0)
    expect(gate.isBusy('s1')).toBe(false)
  })
})

/** Walk a JSON Schema and return every violation of the Host's closed subset. */
function closedSubsetViolations(schema: unknown, path = '$'): string[] {
  const problems: string[] = []
  if (schema === null || typeof schema !== 'object') return problems
  const node = schema as Record<string, unknown>
  const type = node['type']
  if (type !== undefined && typeof type !== 'string') {
    problems.push(`${path}.type must be a single string, got ${JSON.stringify(type)}`)
  }
  const properties = node['properties']
  if (properties !== undefined && typeof properties === 'object' && properties !== null) {
    const keys = Object.keys(properties as Record<string, unknown>)
    const required = Array.isArray(node['required']) ? (node['required'] as unknown[]) : []
    for (const key of keys) {
      if (!required.includes(key)) problems.push(`${path}.required is missing "${key}"`)
      problems.push(...closedSubsetViolations((properties as Record<string, unknown>)[key], `${path}.${key}`))
    }
    if (node['additionalProperties'] !== false) problems.push(`${path}.additionalProperties must be false`)
  }
  const items = node['items']
  if (items !== undefined) problems.push(...closedSubsetViolations(items, `${path}[]`))
  return problems
}

describe('codebuddy_ask registration', () => {
  /** A tools service that records what it was handed. */
  function capture() {
    const registered: BridgeToolDefinition[] = []
    const disposers: number[] = []
    let disposed = 0
    return {
      registered,
      disposed: () => disposed,
      disposers,
      service: {
        register(definition: BridgeToolDefinition) {
          registered.push(definition)
          return () => { disposed += 1 }
        },
      },
    }
  }

  it('registers one tool whose schema stays inside the Host closed subset', () => {
    const sink = capture()
    const dispose = mountAskTool(sink.service, { options: options(), regions: [], log: () => {} })
    expect(sink.registered).toHaveLength(1)
    const definition = sink.registered[0]!
    expect(definition.name).toBe('codebuddy_ask')
    expect(definition.parameters['required']).toEqual(['message'])
    expect(closedSubsetViolations(definition.output.schema)).toEqual([])
    // The result object is validated against this schema on every call, so a
    // field missing from `required` is a value the Host may drop.
    expect(definition.output.schema['required']).toEqual(
      expect.arrayContaining([
        'ok', 'reply', 'session_id', 'tools', 'denied_tools', 'tool_calls', 'num_turns', 'tokens_in',
        'tokens_out', 'cache_read_tokens', 'credential_region', 'working_dir',
        'unattended', 'elapsed_ms', 'truncated', 'error',
      ]),
    )
    dispose()
    expect(sink.disposed()).toBe(1)
  })

  it('degrades to a no-op when the Host has no tools service', () => {
    const dispose = mountAskTool(undefined, { options: options(), regions: [], log: () => {} })
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
  })

  it('renders a failure as text instead of throwing', () => {
    const sink = capture()
    mountAskTool(sink.service, { options: options(), regions: [], log: () => {} })
    const render = sink.registered[0]!.output.render
    const failed = { ...empty, ok: false, error: 'boom' }
    const blocks = render({}, failed) as Array<{ type: string, text: string }>
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toContain('boom')
  })

  it('renders a success with the accounting footer and the working directory', () => {
    const sink = capture()
    mountAskTool(sink.service, { options: options(), regions: [], log: () => {} })
    const render = sink.registered[0]!.output.render
    const ok: AskResult = {
      ...empty,
      reply: 'done',
      session_id: 's1',
      tools: [{ name: 'Read', count: 2 }],
      tool_calls: 2,
      num_turns: 3,
      tokens_in: 10,
      tokens_out: 4,
      cache_read_tokens: 8,
      credential_region: 'cn',
      working_dir: 'C:/repo',
      elapsed_ms: 1234,
    }
    const text = (render({}, ok) as Array<{ text: string }>)[0]!.text
    expect(text).toContain('done')
    expect(text).toContain('Read×2')
    expect(text).toContain('dir=C:/repo')
    expect(text).toContain('cred=cn')
  })

  it('warns the caller when the turn ran unattended', () => {
    const sink = capture()
    mountAskTool(sink.service, { options: options(), regions: [], log: () => {} })
    const render = sink.registered[0]!.output.render
    const value: AskResult = {
      ...empty,
      reply: 'x',
      credential_region: 'cn',
      working_dir: 'C:/temp/scratch',
      unattended: true,
      elapsed_ms: 1,
    }
    expect((render({}, value) as Array<{ text: string }>)[0]!.text).toContain('临时目录')
  })

  it('names the tools it was refused, so a partial answer is not read as a full one', () => {
    const sink = capture()
    mountAskTool(sink.service, { options: options(), regions: [], log: () => {} })
    const render = sink.registered[0]!.output.render
    const value: AskResult = { ...empty, reply: 'could not write', denied_tools: ['Write', 'Bash'] }
    const text = (render({}, value) as Array<{ text: string }>)[0]!.text
    expect(text).toContain('Write')
    expect(text).toContain('Bash')
  })
})

describe('composeContinuation and injectOutcome', () => {
  it('names CodeBuddy, the directory and the instruction, and warns files may have changed', () => {
    const text = composeContinuation('评审结论：没问题', {
      dir: 'C:/repo',
      scope: '（未提交改动）',
      toolCalls: 3,
      tools: [{ name: 'Read', count: 3 }],
    })
    expect(text).toContain('CodeBuddy')
    expect(text).toContain('C:/repo')
    expect(text).toContain('（未提交改动）')
    expect(text).toContain('Read×3')
    expect(text).toContain('可能已经改动了工作区里的文件')
    // It must NOT pretend the human asked the model to continue: the command was
    // human-to-CodeBuddy.
    expect(text).not.toContain('继续你原来的任务')
  })

  it('omits the optional lines rather than printing empty labels', () => {
    const text = composeContinuation('ok')
    expect(text).not.toContain('工作目录：')
    expect(text).not.toContain('交给它的指令：')
    expect(text).toContain('无')
  })

  it('wakes an idle session and queues onto a running one', () => {
    const idle = agent('idle')
    expect(injectOutcome(idle, { reply: 'done' })).toMatchObject({ ok: true, delivered: 'new-turn', woke: true })
    expect(idle.calls).toEqual(['steer'])

    const running = agent('running')
    expect(injectOutcome(running, { reply: 'done' })).toMatchObject({ ok: true, delivered: 'next-step', woke: false })
    expect(running.calls).toEqual(['inject'])
  })

  it('treats an ABSENT status as running: a parked message is recoverable, a spare turn is not', () => {
    const unknown = agent(undefined)
    expect(injectOutcome(unknown, { reply: 'done' })).toMatchObject({ ok: true, delivered: 'next-step' })
    expect(unknown.calls).toEqual(['inject'])
  })

  it('refuses by name instead of silently doing nothing', () => {
    expect(injectOutcome(undefined, { reply: 'x' })).toMatchObject({ ok: false, code: 'agent-not-live' })
    expect(injectOutcome(agent('idle'), { reply: '   ' })).toMatchObject({ ok: false, code: 'text-required' })
    expect(injectOutcome(agent('idle'), { reply: 'x'.repeat(INJECT_TEXT_LIMIT + 1) })).toMatchObject({
      ok: false,
      code: 'text-too-large',
    })
  })

  it('reports a delivery failure as a named refusal, not an exception', () => {
    const broken: BridgeAgent = {
      status: 'idle',
      inject() { throw new Error('nope') },
      steer() { throw new Error('nope') },
    }
    expect(injectOutcome(broken, { reply: 'x' })).toMatchObject({ ok: false, code: 'inject-failed' })
  })

  it('renders the two delivery outcomes differently, because they are different facts', () => {
    expect(formatInjection({ ok: true, delivered: 'new-turn', woke: true, messageId: 'm' })).toContain('已唤醒')
    expect(formatInjection({ ok: true, delivered: 'next-step', woke: false, messageId: 'm' })).toContain('已排队')
    expect(formatInjection({ ok: false, code: 'agent-not-live', error: 'x' })).toContain('agent-not-live')
  })
})

describe('/codebuddy', () => {
  function captureCommands() {
    const registered: BridgeCommandDefinition[] = []
    let disposed = 0
    return {
      registered,
      disposed: () => disposed,
      service: {
        register(definition: BridgeCommandDefinition) {
          registered.push(definition)
          return () => { disposed += 1 }
        },
      },
    }
  }

  it('turns an empty line into the review brief and leaves typed text alone', () => {
    expect(composeCommandPrompt('')).toContain('未提交的改动')
    expect(composeCommandPrompt('   ')).toContain('未提交的改动')
    // A human who typed something meant it: no brief may be prepended.
    expect(composeCommandPrompt(' 修一下这个空指针 ')).toBe('修一下这个空指针')
  })

  it('labels the scope so the footer says what was asked', () => {
    expect(commandScopeLabel('')).toBe('（未提交改动）')
    expect(commandScopeLabel(' 修 bug ')).toBe('（指令：修 bug）')
  })

  it('detects the review invocation by an empty line only', () => {
    expect(isReviewInvocation('')).toBe(true)
    expect(isReviewInvocation('  ')).toBe(true)
    expect(isReviewInvocation('review')).toBe(false)
  })

  it('grants write permission for one turn only when --edit is typed', () => {
    // The default refuses writes; the flag is the per-invocation consent.
    expect(permissionModeForInvocation('修一下这个空指针')).toBe('')
    expect(permissionModeForInvocation('')).toBe('dontAsk')

    const edit = parseCommandInput(`${EDIT_FLAG} 修一下这个空指针`)
    expect(edit.permissionMode).toBe('acceptEdits')
    // The flag is bridge syntax, not something CodeBuddy should ever see.
    expect(edit.prompt).toBe('修一下这个空指针')
    expect(edit.label).toBe('（可写：修一下这个空指针）')
    expect(edit.review).toBe(false)

    // `--edit` alone is "review, and you may fix what you find".
    const alone = parseCommandInput(`${EDIT_FLAG}   `)
    expect(alone.prompt).toContain('未提交的改动')
    expect(alone.permissionMode).toBe('acceptEdits')
    expect(alone.label).toBe('（未提交改动，可写）')

    // A word that merely starts with the flag is not the flag.
    expect(parseCommandInput('--edit-something').prompt).toBe('--edit-something')
    expect(parseCommandInput('--edit-something').permissionMode).toBe('')
  })

  it('does not advertise an example the default permission mode cannot run', () => {
    const sink = captureCommands()
    const dispose = mountCodebuddyCommand(sink.service, {
      options: options(),
      regions: [],
      log: () => {},
    })
    const hint = sink.registered[0]?.input?.hint ?? ''
    // Every "make it change something" example must carry the flag that permits it.
    expect(hint).toContain(EDIT_FLAG)
    expect(hint).toContain('允许改文件')
    dispose()
  })

  it('registers under the documented name with a hint', () => {
    const sink = captureCommands()
    const dispose = mountCodebuddyCommand(sink.service, {
      options: options(),
      regions: [],
      log: () => {},
    })
    expect(sink.registered[0]?.name).toBe(COMMAND_NAME)
    expect(sink.registered[0]?.input?.hint).toContain('留空')
    dispose()
    expect(sink.disposed()).toBe(1)
  })

  it('degrades to a no-op when the Host has no commands service', () => {
    const dispose = mountCodebuddyCommand(undefined, {
      options: options(),
      regions: [],
      log: () => {},
    })
    expect(() => dispose()).not.toThrow()
  })

  it('refuses when the session carries no workspace path', async () => {
    const sink = captureCommands()
    mountCodebuddyCommand(sink.service, {
      options: options(),
      regions: [],
      log: () => {},
    })
    const result = await sink.registered[0]!.handler({ agent: { id: 's', inject() {}, steer() {} } })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('工作区')
  })
  // The command and the tool must agree on where a turn runs, so the command
  // reads the same projection the tool does. These two pin the two halves of that
  // agreement: the projection wins when it exists, and the command does NOT get a
  // ladder of its own when neither source has a directory.
  it('runs the turn in the session projection, not in the header directory', async () => {
    const sink = captureCommands()
    // The smallest board that records the announcement, shaped like the real one:
    // `begin` returns a turn the bridge will hand back to `end`, so the stub has to
    // return something rather than the raw input.
    const begun: Array<{ entrance: string; workingDir: string }> = []
    const board = {
      begun,
      begin(input: { entrance: string; workingDir: string }) {
        const turn = { ...input, id: 'spy-0', startedAt: Date.now(), phase: 'starting' as const }
        begun.push({ entrance: input.entrance, workingDir: input.workingDir })
        return turn as never
      },
      end() {},
      snapshot() {
        return { turns: [], serverTime: Date.now() }
      },
      size() {
        return begun.length
      },
    }
    mountCodebuddyCommand(sink.service, {
      options: options({ allowedDirs: [sessionDir, allowedDir] }),
      regions: [],
      log: () => {},
      live: board,
      directoryOf: projectionOf(),
    })
    // The projection wins BEFORE the turn starts, so the directory it chose is
    // observable from the announcement the board received — no stubbing needed.
    // The header points at `sessionDir` and the projection at `allowedDir`; the
    // announcement must name the projection's directory and nothing else.
    await sink.registered[0]!.handler({
      agent: {
        id: 'session-1',
        session: { header: { cwd: sessionDir }, workingDirectory: allowedDir },
        inject: vi.fn(),
        steer: vi.fn(),
      },
      rawInput: 'look',
    })
    expect(board.begun).toHaveLength(1)
    expect(board.begun[0]).toMatchObject({ entrance: 'command', workingDir: realpathSync(allowedDir) })
  })

  it('still refuses when the projection and the header are both empty', async () => {
    const sink = captureCommands()
    mountCodebuddyCommand(sink.service, {
      options: options(),
      regions: [],
      log: () => {},
      directoryOf: projectionOf(),
    })
    const result = await sink.registered[0]!.handler({
      agent: { id: 's', session: { header: { cwd: '' }, workingDirectory: null }, inject() {}, steer() {} },
      rawInput: 'look',
    })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('投影')
  })

  it('honours a projection that appears AFTER the runtime was built', async () => {
    // THE ORDERING REGRESSION. In the plugin, `createCliBridgeRuntime` runs on the
    // tools/commands row, which can arrive BEFORE `sessionProjections`; the rebuild
    // gate keys on the serialized settings alone, so the late service does NOT
    // rebuild the runtime. The fix wires a stable probe closure over a mutable
    // cell, and every turn re-reads that cell. This test mirrors the assembly:
    // build the runtime while the cell is still empty, mount one surface from the
    // resulting deps (as index.ts does), THEN fill the cell — and the very next
    // turn must run in the projection, not in the header. With the pre-fix wiring
    // (`directoryOf` captured at build time) the turn would land on sessionDir.
    const sink = captureCommands()
    let published: DirectoryOf | undefined
    const probe: DirectoryOf = (session) => published?.(session) ?? null
    const runtime = createCliBridgeRuntime({ enabled: true }, [], () => {}, probe)
    if (runtime === undefined) throw new Error('runtime must build with enabled: true')
    // The runtime holds the probe itself — not a snapshot taken right now.
    expect(runtime.deps.directoryOf).toBe(probe)
    const begun: Array<{ entrance: string; workingDir: string }> = []
    const board = {
      begin(input: { entrance: string; workingDir: string }) {
        begun.push({ entrance: input.entrance, workingDir: input.workingDir })
        return { ...input, id: 'spy-0', startedAt: Date.now(), phase: 'starting' as const } as never
      },
      end() {},
      snapshot() { return { turns: [], serverTime: Date.now() } },
      size() { return begun.length },
    }
    mountCodebuddyCommand(sink.service, {
      ...runtime.deps,
      options: options({ allowedDirs: [sessionDir, allowedDir] }),
      live: board,
    })

    // The Host publishes its projections AFTER the mount — what index.ts's
    // `inject(['sessionProjections'])` does. No re-mount, no settings change.
    published = projectionOf()

    await sink.registered[0]!.handler({
      agent: {
        id: 'session-1',
        session: { header: { cwd: sessionDir }, workingDirectory: allowedDir },
        inject: vi.fn(),
        steer: vi.fn(),
      },
      rawInput: 'look',
    })
    expect(begun).toHaveLength(1)
    // Header would give sessionDir; the late projection must win without a remount.
    expect(begun[0]).toMatchObject({ entrance: 'command', workingDir: realpathSync(allowedDir) })
  })

  it('refuses a second concurrent turn on the same session', async () => {
    const sink = captureCommands()
    // The gate, not the command, owns concurrency now: the tool and the command
    // must share one budget, so a busy slot here is created by entering it.
    const gate = new TurnGate({ perSessionPerHour: 5, globalPerHour: 10, allowConcurrentPerSession: false })
    expect(gate.tryEnter('session-1', () => {}).ok).toBe(true)
    mountCodebuddyCommand(sink.service, { options: options(), regions: [], log: () => {}, gate })
    const result = await sink.registered[0]!.handler({
      agent: { id: 'session-1', session: { header: { cwd: sessionDir } }, inject() {}, steer() {} },
      rawInput: '',
    })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('回合在跑')
  })

  it('renders a failed turn as an error result without touching the model', async () => {
    const sink = captureCommands()
    mountCodebuddyCommand(sink.service, {
      options: options(),
      regions: [],
      log: () => {},
    })
    // No credentials → runAsk fails before spawning anything.
    const agentStub = { id: 'session-2', session: { header: { cwd: sessionDir } }, inject: vi.fn(), steer: vi.fn() }
    const result = await sink.registered[0]!.handler({ agent: agentStub, rawInput: 'do something' })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('CodeBuddy 失败')
    expect(agentStub.inject).not.toHaveBeenCalled()
    expect(agentStub.steer).not.toHaveBeenCalled()
  })
})

describe('formatCommandOutcome', () => {
  const base: AskResult = {
    ...empty,
    reply: '结论',
    session_id: 's1',
    num_turns: 2,
    tokens_in: 5,
    tokens_out: 6,
    cache_read_tokens: 4,
    credential_region: 'cn',
    working_dir: 'C:/repo',
    elapsed_ms: 900,
  }

  it('carries the same footer the tool renders, plus the directory', () => {
    const text = formatCommandOutcome(base, { raw: '' })
    expect(text).toContain('结论')
    expect(text).toContain('（未提交改动）')
    expect(text).toContain('dir=C:/repo')
    expect(text).toContain('turns=2')
  })

  it('adds the delivery line only when a delivery was attempted', () => {
    expect(formatCommandOutcome(base, { raw: '' })).not.toContain('已唤醒')
    const withDelivery = formatCommandOutcome(base, {
      raw: '',
      injection: { ok: true, delivered: 'new-turn', woke: true, messageId: 'm' },
    })
    expect(withDelivery).toContain('已唤醒')
  })

  it('flags a truncated reply so nobody reads the summary as the whole answer', () => {
    expect(formatCommandOutcome({ ...base, truncated: true }, {})).toContain('已截断')
  })

  it('says a failed turn failed, with its reason', () => {
    const text = formatCommandOutcome({ ...base, ok: false, error: 'boom' }, { raw: 'x' })
    expect(text).toContain('失败')
    expect(text).toContain('boom')
  })
})

describe('CLI entry lookup', () => {
  it('takes an explicit CLI path literally once it exists', async () => {
    const { resolveCliEntry } = await import('../src/cli-bridge/runner.ts')
    const entry = join(base, 'codebuddy-probe')
    await writeFile(entry, '#!/usr/bin/env node\n')
    // A typo answered by a different working executable is a bug nobody can
    // reproduce, so an explicit path is used exactly as written — never replaced.
    expect(resolveCliEntry(entry)).toEqual({ ok: true, entry, configured: true, reason: '' })
  })

  it('refuses an explicit path that does not exist, instead of falling back to PATH', async () => {
    const { resolveCliEntry } = await import('../src/cli-bridge/runner.ts')
    const missing = join(base, 'not-installed', 'codebuddy')
    const choice = resolveCliEntry(missing)
    expect(choice.ok).toBe(false)
    expect(choice.reason).toContain('不存在')
    // The important half: a failed explicit path must NOT quietly become
    // "whatever `codebuddy` is on PATH", because that binary would inherit the
    // vault token from the environment.
    expect(choice.entry).toBe('')
  })

  it('refuses a Windows batch wrapper, which would be run through cmd.exe', async () => {
    const { resolveCliEntry } = await import('../src/cli-bridge/runner.ts')
    const wrapper = join(base, 'codebuddy.cmd')
    await writeFile(wrapper, '@echo off\n')
    const choice = resolveCliEntry(wrapper)
    if (process.platform === 'win32') {
      expect(choice.ok).toBe(false)
      expect(choice.reason).toContain('批处理')
    } else {
      // On POSIX a `.cmd` file is just a file; the guard is Windows-specific.
      expect(choice.ok).toBe(true)
    }
  })

  it('reports the failure when no install exists, rather than inventing a path', async () => {
    const { resolveCliEntry } = await import('../src/cli-bridge/runner.ts')
    // vitest isolates HOME/APPDATA to an empty temp dir, so the home-derived
    // candidates cannot exist here. The two hard-coded POSIX prefixes are
    // outside that isolation, though, so this asserts the CONTRACT rather than
    // "nothing was found": an auto-detected entry is only ever reported when the
    // file really exists, it is never `configured`, and a miss explains itself.
    const found = resolveCliEntry('')
    expect(found.configured).toBe(false)
    if (found.ok) {
      expect(found.entry.endsWith(join('@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'))).toBe(true)
    } else {
      expect(found.entry).toBe('')
      expect(found.reason).toContain('cliBridge.binary')
      // The user has to be told the dangerous alternative is not taken.
      expect(found.reason).toContain('PATH')
    }
  })

  it('only treats a credential refusal as worth walking to the next account', async () => {
    const { looksLikeAuthFailure } = await import('../src/cli-bridge/runner.ts')
    // The assistant's own prose is NOT part of the channel any more: this used to
    // take the reply text, so a review that merely quoted `HTTP 401` discarded a
    // good turn and re-ran it on the next account.
    expect(looksLikeAuthFailure({ isError: true, errors: ['http 401 Unauthorized'], subtype: undefined })).toBe(true)
    expect(looksLikeAuthFailure({ isError: true, errors: ['Authentication required'], subtype: undefined })).toBe(true)
    expect(looksLikeAuthFailure({ isError: true, errors: ['run the /login command'], subtype: undefined })).toBe(true)
    // A rate limit or a real model error on the next token just burns a turn.
    expect(looksLikeAuthFailure({ isError: true, errors: ['http 429 rate limited'], subtype: undefined })).toBe(false)
    expect(looksLikeAuthFailure({ isError: false, errors: ['http 401'], subtype: undefined })).toBe(false)
  })
})

describe('plugin config schema', () => {
  /**
   * Resolve the plugin config the way the Host does, then peel the LIVE
   * reference `cliBridge` carries — it is marked volatile so turning the route
   * on does not reload the whole plugin, and a raw property read therefore sees
   * a `{get()}` wrapper rather than the settings.
   */
  async function resolveCliBridge(input: unknown): Promise<Record<string, any>> {
    const plugin = await import('../src/index.ts')
    const resolved = (plugin.Config as unknown as (value: unknown) => Record<string, any>)(input)
    const section = resolved['cliBridge'] as { get?: () => Record<string, any> } | undefined
    return typeof section?.get === 'function' ? section.get() : (section ?? {})
  }

  // The schema is what a user's profile is validated against, so "the route is
  // off by default" has to be true HERE too — not only in the mount's fallback.
  it('resolves the CLI section with defaults when the profile omits it', async () => {
    const resolved = await resolveCliBridge({})
    expect(resolved['enabled']).toBe(false)
    expect(resolved['permissionMode']).toBe(CLI_BRIDGE_DEFAULTS.permissionMode)
    expect(resolved['maxTurns']).toBe(CLI_BRIDGE_DEFAULTS.maxTurns)
    expect(resolved['regionOrder']).toBe(CLI_BRIDGE_DEFAULTS.regionOrder)
    // The budget the maintainer asked for is in the SCHEMA, not just the mount.
    expect(resolved['maxTurnsPerSessionHour']).toBe(CLI_BRIDGE_DEFAULTS.maxTurnsPerSessionHour)
    expect(resolved['maxTurnsPerHour']).toBe(CLI_BRIDGE_DEFAULTS.maxTurnsPerHour)
  })

  it('accepts the documented keys a user would actually write', async () => {
    const resolved = await resolveCliBridge({
      cliBridge: { enabled: true, maxTurns: 3, permissionMode: 'plan' },
    })
    expect(resolved['enabled']).toBe(true)
    expect(resolved['maxTurns']).toBe(3)
    expect(resolved['permissionMode']).toBe('plan')
  })
})

describe('mountCliBridge', () => {
  function services() {
    const tools: BridgeToolDefinition[] = []
    const commands: BridgeCommandDefinition[] = []
    return {
      tools,
      commands,
      input: {
        regions: [] as BridgeCredentialRegion[],
        tools: { register(definition: BridgeToolDefinition) { tools.push(definition); return () => {} } },
        commands: { register(definition: BridgeCommandDefinition) { commands.push(definition); return () => {} } },
      },
    }
  }

  it('registers nothing at all while the route is off, and does not log', () => {
    const sink = services()
    const log = vi.fn()
    const dispose = mountCliBridge({ settings: { enabled: false } as CliBridgeSettings, log, ...sink.input })
    expect(sink.tools).toHaveLength(0)
    expect(sink.commands).toHaveLength(0)
    expect(log).not.toHaveBeenCalled()
    expect(() => dispose()).not.toThrow()
  })

  it('registers both entrances when it is on', () => {
    const sink = services()
    const log = vi.fn()
    const dispose = mountCliBridge({ settings: { enabled: true }, log, ...sink.input })
    expect(sink.tools).toHaveLength(1)
    expect(sink.commands).toHaveLength(1)
    expect(log.mock.calls[0]?.[0]).toContain('codebuddy_ask')
    expect(log.mock.calls[0]?.[0]).toContain('/codebuddy')
    dispose()
  })

  it('mounts the provider-only case: on, but the Host publishes neither service', () => {
    const log = vi.fn()
    const dispose = mountCliBridge({
      settings: { enabled: true },
      regions: [],
      log,
      tools: undefined,
      commands: undefined,
    })
    // Not a throw and not silence: the user turned it on and is entitled to know
    // it did nothing.
    expect(log.mock.calls[0]?.[0]).toContain('两个入口都没挂上')
    expect(() => dispose()).not.toThrow()
  })
})

/**
 * `cliBridge.sessionContinuity` — the setting and the in-memory memory behind it.
 *
 * The setting exists because continuation is a BEHAVIOUR CHANGE, not a bug fix:
 * a second `/codebuddy` used to be an independent agent by construction, and
 * anyone who relied on that must be able to get it back with one key.
 */
describe('session continuity settings and memory', () => {
  it('defaults to auto, accepts off, and falls back with a reason on a typo', () => {
    expect(CLI_BRIDGE_DEFAULTS.sessionContinuity).toBe('auto')
    expect(normalizeCliBridgeOptions({}).sessionContinuity).toBe('auto')
    expect(normalizeCliBridgeOptions({ sessionContinuity: 'off' }).sessionContinuity).toBe('off')
    // Case-SENSITIVE, like permissionMode and effort: a value that only looks
    // right is rejected out loud rather than silently honoured.
    expect(normalizeCliBridgeOptions({ sessionContinuity: ' OFF ' }).sessionContinuity).toBe('auto')

    const rejected: string[] = []
    const value = normalizeCliBridgeOptions({ sessionContinuity: 'sometimes' }, message => rejected.push(message))
    // A typo must not silently run the other mode without saying so.
    expect(value.sessionContinuity).toBe('auto')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toContain('sometimes')
    expect(rejected[0]).toContain(SESSION_CONTINUITY_MODES.join(', '))
  })

  it('remembers, recalls and forgets one session at a time', () => {
    forgetCliSession('mem-a')
    forgetCliSession('mem-b')
    expect(recallCliSession('mem-a')).toBe('')
    rememberCliSession('mem-a', 'uuid-1')
    rememberCliSession('mem-b', 'uuid-2')
    expect(recallCliSession('mem-a')).toBe('uuid-1')
    expect(recallCliSession('mem-b')).toBe('uuid-2')
    // A blank id is never remembered: an empty string means "the CLI reported
    // none", and storing it would erase a usable entry.
    rememberCliSession('mem-a', '')
    expect(recallCliSession('mem-a')).toBe('uuid-1')
    rememberCliSession('mem-a', 'uuid-3')
    expect(recallCliSession('mem-a')).toBe('uuid-3')
    forgetCliSession('mem-a')
    expect(recallCliSession('mem-a')).toBe('')
    forgetCliSession('mem-b')
  })

  it('stays bounded, dropping the oldest entry first', () => {
    // 256 is the documented ceiling; one more than that must not grow the map
    // without limit in a process that lives for days.
    for (let index = 0; index <= 256; index += 1) rememberCliSession(`cap-${String(index)}`, `uuid-${String(index)}`)
    expect(recallCliSession('cap-0')).toBe('')
    expect(recallCliSession('cap-1')).toBe('uuid-1')
    expect(recallCliSession('cap-256')).toBe('uuid-256')
    for (let index = 0; index <= 256; index += 1) forgetCliSession(`cap-${String(index)}`)
  })
})

/**
 * WHICH PROJECTION READ FACE THE BRIDGE USES — and why it is not cosmetic.
 *
 * DSH 0.2.2 deprecated `sessionProjections.stateOf(session, key)`. It still
 * answers, so a bridge that kept calling it would look perfectly healthy — it
 * would just print a deprecation warning once per key per process and stay
 * pinned to a read face the Host says is on its way out. The migration is only
 * real if the CURRENT face is the one actually called, and only SAFE if the old
 * face still answers on a Host that has nothing else.
 *
 * Both halves are asserted here rather than left to the deprecation notice,
 * because neither can fail loudly at runtime: preferring the wrong face costs a
 * warning nobody reads, and dropping the fallback costs a user on an older Host
 * a silent "no directory recorded" — which the ladder turns into the session
 * HEADER, i.e. the stale pre-`/cd` location this whole feature exists to avoid.
 */
describe('readProjectedState (the projection read face, issue: 0.2.2 stateOf deprecation)', () => {
  it('answers from snapshot and never touches the deprecated stateOf', () => {
    // The point of the migration. `stateOf` is wired to a sentinel rather than a
    // spy: if it runs at all the test fails, which is the assertion — calling it
    // is what produces the deprecation warning the Host asks us to stop causing.
    const calls: string[] = []
    const state = readProjectedState(
      {
        snapshot: (session, keys) => {
          calls.push(`snapshot:${String((session as { id?: string }).id)}:${keys?.join(',') ?? ''}`)
          return { values: { workingDirectory: '/tmp/projected' } }
        },
        stateOf: () => {
          calls.push('stateOf')
          return '/tmp/deprecated'
        },
      },
      { id: 's1' },
      'workingDirectory',
    )
    expect(state).toBe('/tmp/projected')
    expect(calls).toEqual(['snapshot:s1:workingDirectory'])
  })

  it('falls back to stateOf when the Host has no snapshot', () => {
    // An older Host. The directory must still come back, otherwise the ladder
    // silently answers with the session header — the exact drift /cd causes.
    const state = readProjectedState(
      { stateOf: () => '/tmp/legacy-projected' },
      { id: 's1' },
      'workingDirectory',
    )
    expect(state).toBe('/tmp/legacy-projected')
  })

  it('reports "nothing recorded" as undefined from either face', () => {
    // `undefined` and "the reader threw" are different facts: the caller keeps
    // the header fallback for the first and abandons the projection for the
    // second. Both faces must agree on the first.
    expect(readProjectedState({ snapshot: () => ({ values: {} }) }, {}, 'workingDirectory')).toBeUndefined()
    expect(readProjectedState({ snapshot: () => undefined }, {}, 'workingDirectory')).toBeUndefined()
    expect(readProjectedState({ stateOf: () => null }, {}, 'workingDirectory')).toBeNull()
    expect(readProjectedState({}, {}, 'workingDirectory')).toBeUndefined()
  })
})
