/**
 * Host-side heartbeat: a small JSON file written under `$DSH_HOME` once the
 * `workbuddy` provider is registered. The status CLI reads it to report
 * whether the host bundle is alive, independent of the browser card.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）
 *   — 该机制由其设计：浏览器端无法写文件，其健康只能靠 console.error 上报，
 *     因此由宿主写心跳文件，缺失即代表宿主从未启动；崩溃后的陈旧心跳
 *     通过 PID 存活检查识别。
 * 改动：无。机制本身已完备，原样沿用。
 *
 * @module dsh-connect-workbuddy/host-heartbeat
 */

import { execFileSync } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from './host-peers.ts'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'

/** Basename of the host heartbeat file inside the Harness home. */
export const WORKBUDDY_HOST_HEARTBEAT_FILENAME = '.workbuddy-host-heartbeat.json'

/**
 * On-disk heartbeat formats this build WRITES and READS.
 *
 * 1 → 2 added `hostStartedAt` (issue #174). Version 1 is still READ, on purpose:
 * rejecting it would turn the first `doctor` after an upgrade into a spurious
 * "no heartbeat at all", which is a worse diagnosis than the imprecise
 * comparison version 1 supports. Anything newer than {@link HEARTBEAT_FORMAT_VERSION}
 * is rejected, because a future field could change the meaning of the ones read
 * here.
 */
const HEARTBEAT_FORMAT_VERSION = 2
const READABLE_HEARTBEAT_VERSIONS: readonly number[] = [1, 2]

/** On-disk shape of the heartbeat. */
export interface WorkBuddyHostHeartbeat {
  /** The format actually on disk; this build writes {@link HEARTBEAT_FORMAT_VERSION}. */
  version: (typeof READABLE_HEARTBEAT_VERSIONS)[number]
  package: 'dsh-connect-workbuddy'
  pluginVersion: string
  /** Epoch milliseconds when the host registered the provider. */
  registeredAt: number
  /** Host process PID, to distinguish a stale heartbeat after a crash. */
  pid: number
  /**
   * Epoch milliseconds when THIS process started (issue #174).
   *
   * The staleness check needs to recognise a REUSED PID: `process.kill(pid, 0)`
   * only says "some process has this number", so after a crash the heartbeat
   * can describe a process that died while the number now belongs to something
   * else. The way to tell is to compare the live process's start time against
   * the one recorded HERE.
   *
   * Absent on heartbeats written by older builds (`version: 1`): the reader
   * then falls back to {@link WorkBuddyHostHeartbeat.registeredAt}, which is
   * what those builds wrote, and is only a last-resort approximation.
   */
  hostStartedAt?: number
}

/** Absolute path of the host heartbeat file. */
export function workbuddyHostHeartbeatPath(): string {
  return join(resolveDshHome(), WORKBUDDY_HOST_HEARTBEAT_FILENAME)
}

/**
 * Spawn options every external probe in this module is run with.
 *
 * `windowsHide` is REQUIRED here, not cosmetic. Windows hands a console-program
 * child a brand-new console window whenever its PARENT has none — and the
 * parent frequently has none: the DSH Desktop host is an Electron GUI process
 * (`MainWindowHandle = 0`, verified on the live host), as are Task Scheduler
 * jobs and CI services. That window is created VISIBLE, so every start-time
 * probe would flash a black box on the user's screen.
 *
 * Evidence (real Windows 11, parent created console-less through the WMI
 * service — the same condition as the Electron host; the child reports the
 * console it actually owns):
 *
 *   - without `windowsHide`: `NEW-console hwnd=1573500 visible=True`
 *   - with `windowsHide: true`: `no-console`
 *
 * Invoked from a terminal the parent HAS a console and the child simply
 * inherits it (no new window), which is why this never showed up in local
 * runs — the same blind spot `docs/WINDOWS.md` §0 describes. The sibling call
 * site `src/at-rest.ts` (the at-rest key fetch) already sets this option; this
 * module did not, and that inconsistency is what the test pins.
 *
 * On POSIX the option is ignored.
 */
export const PROCESS_PROBE_OPTIONS = { encoding: 'utf8', windowsHide: true } as const

/**
 * The command one start-time probe runs, per platform.
 *
 * Split out as a value so the spawn can be asserted WITHOUT a Windows machine:
 * `tests/host-heartbeat.spec.ts` checks the platform branch and the options
 * object directly, which is the only way a Windows-only spawn defect here can
 * be caught on the macOS development machine (§0: not "unreproduced" but
 * "impossible to reproduce").
 *
 * `platform` is injectable for the same reason, in the same spirit as
 * `defaultDesktopAuthDirs()` and `workbuddyAppExecutableCandidates()`.
 */
export function processStartProbe(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): { file: string, args: string[] } {
  if (platform === 'win32') {
    return {
      file: 'powershell',
      args: [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString('o')`,
      ],
    }
  }
  return { file: 'ps', args: ['-o', 'lstart=', '-p', String(pid)] }
}

/**
 * Process start time in epoch milliseconds; undefined when unavailable.
 *
 * POSIX reads `ps -o lstart=`; Windows has no such command, so the creation
 * time is taken from PowerShell's `Get-Process` StartTime, emitted as UTC ISO
 * 8601 so `Date.parse` understands it without locale assumptions. Absent or
 * unqueryable processes (other users' processes) degrade to undefined.
 */
export function processStartTimeMs(pid: number): number | undefined {
  try {
    const probe = processStartProbe(pid)
    const output = execFileSync(probe.file, probe.args, PROCESS_PROBE_OPTIONS)
    const parsed = Date.parse(output.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * How close a recorded start time must be to the live process's start time for
 * the two to be considered the SAME process.
 *
 * Two tolerances, for two different comparisons:
 *
 *   - {@link HOST_START_REFERENCE_TOLERANCE_MS} when the heartbeat records
 *     `hostStartedAt` — both sides are then the SAME quantity (a process start
 *     time), so the window only has to absorb the coarse resolution of
 *     `ps -o lstart=` (whole seconds) and PowerShell's string round-trip.
 *   - {@link LEGACY_REFERENCE_TOLERANCE_MS} when it does not, and the only
 *     available reference is `registeredAt`. That is a different quantity
 *     (when the plugin mounted, not when the process started), so it is a
 *     lower bound rather than an answer: a host that started more than this
 *     before the plugin mounted would have looked dead. Kept wide on purpose —
 *     a missed reuse is far less harmful than calling a live host stale.
 */
export const HOST_START_REFERENCE_TOLERANCE_MS = 120_000
export const LEGACY_REFERENCE_TOLERANCE_MS = 12 * 60 * 60 * 1_000

/**
 * Whether the recorded host process still matches the heartbeat's PID.
 *
 * A PID can be reused after a crash, so the recorded start time is compared
 * against the live process: a different start time means a different process.
 *
 * ISSUE #174 — the reference used to be `registeredAt`, the moment the plugin
 * WROTE the heartbeat, and the comparison was `|startedAt − registeredAt| < 60s`.
 * Those are two different quantities: `registeredAt` is when the host finished
 * booting and mounted this plugin, which on a real machine is minutes after the
 * process started. Measured by the reporter on Windows 11: process start
 * 19:47:20, heartbeat written 19:58:45 — 684,817 ms apart — so `doctor` and
 * `status` reported `hostBundle: "stale"` for a host that was alive and had
 * just written the file. The `hostStartedAt` field exists so the comparison has
 * the right reference; `registeredAt` is only read for heartbeats written by an
 * older build, where it is the sole (and merely near) signal available.
 */
export function isHeartbeatProcessAlive(heartbeat: WorkBuddyHostHeartbeat): boolean {
  if (!Number.isInteger(heartbeat.pid) || heartbeat.pid <= 0) return false
  try {
    // Signal 0 probes existence without delivering a signal.
    process.kill(heartbeat.pid, 0)
  } catch {
    return false
  }
  const startedAt = processStartTimeMs(heartbeat.pid)
  if (startedAt === undefined) return true
  const recorded = heartbeat.hostStartedAt
  if (recorded !== undefined && Number.isFinite(recorded)) {
    return Math.abs(startedAt - recorded) < HOST_START_REFERENCE_TOLERANCE_MS
  }
  return Math.abs(startedAt - heartbeat.registeredAt) < LEGACY_REFERENCE_TOLERANCE_MS
}

/** Read the heartbeat; absent or unparsable files report undefined. */
export async function readHostHeartbeat(): Promise<WorkBuddyHostHeartbeat | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(workbuddyHostHeartbeatPath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const document = parsed as Record<string, unknown>
    if (!READABLE_HEARTBEAT_VERSIONS.includes(document['version'] as number)) return undefined
    if (document['package'] !== 'dsh-connect-workbuddy') return undefined
    const pid = document['pid']
    const registeredAt = document['registeredAt']
    if (typeof pid !== 'number' || typeof registeredAt !== 'number') return undefined
    // `hostStartedAt` is OPTIONAL: a heartbeat written by a build before issue
    // #174 has no such field, and refusing to read it would turn every upgrade
    // into a spurious "no heartbeat" report.
    const hostStartedAt = document['hostStartedAt']
    return {
      // The version READ, not the one this build writes: `doctor` reports it, and
      // claiming 2 for a v1 file would hide that the precise reference is absent.
      version: document['version'] as (typeof READABLE_HEARTBEAT_VERSIONS)[number],
      package: 'dsh-connect-workbuddy',
      pluginVersion: typeof document['pluginVersion'] === 'string' ? document['pluginVersion'] : WORKBUDDY_CONNECT_VERSION,
      registeredAt,
      pid,
      ...typeof hostStartedAt === 'number' && Number.isFinite(hostStartedAt) ? { hostStartedAt } : {},
    }
  } catch {
    return undefined
  }
}

/**
 * Write the heartbeat for the current process.
 *
 * `hostStartedAt` is captured HERE, from this process, so the later staleness
 * check compares like with like (issue #174). Sampled on every write rather
 * than cached: the value is cheap, and a module-level cache would be wrong the
 * moment this function is exercised from a child process.
 */
export async function writeHostHeartbeat(): Promise<void> {
  const hostStartedAt = processStartTimeMs(process.pid)
  const heartbeat: WorkBuddyHostHeartbeat = {
    version: HEARTBEAT_FORMAT_VERSION,
    package: 'dsh-connect-workbuddy',
    pluginVersion: WORKBUDDY_CONNECT_VERSION,
    registeredAt: Date.now(),
    pid: process.pid,
    ...hostStartedAt === undefined ? {} : { hostStartedAt },
  }
  await writeFile(workbuddyHostHeartbeatPath(), `${JSON.stringify(heartbeat, null, 2)}\n`, { mode: 0o600 })
}

/** Remove the heartbeat; called when the plugin is disposed. */
export async function clearHostHeartbeat(): Promise<void> {
  await rm(workbuddyHostHeartbeatPath(), { force: true })
}
