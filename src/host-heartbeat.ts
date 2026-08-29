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
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'

/** Basename of the host heartbeat file inside the Harness home. */
export const WORKBUDDY_HOST_HEARTBEAT_FILENAME = '.workbuddy-host-heartbeat.json'

/** Current on-disk heartbeat format; readers reject others. */
const HEARTBEAT_FORMAT_VERSION = 1

/** On-disk shape of the heartbeat. */
export interface WorkBuddyHostHeartbeat {
  version: typeof HEARTBEAT_FORMAT_VERSION
  package: 'dsh-connect-workbuddy'
  pluginVersion: string
  /** Epoch milliseconds when the host registered the provider. */
  registeredAt: number
  /** Host process PID, to distinguish a stale heartbeat after a crash. */
  pid: number
}

/** Absolute path of the host heartbeat file. */
export function workbuddyHostHeartbeatPath(): string {
  return join(resolveDshHome(), WORKBUDDY_HOST_HEARTBEAT_FILENAME)
}

/** Process start time in epoch milliseconds; undefined when unavailable. */
export function processStartTimeMs(pid: number): number | undefined {
  try {
    const output = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
    const parsed = Date.parse(output.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the recorded host process still matches the heartbeat's PID.
 *
 * A PID can be reused after a crash, so the recorded start time is compared
 * against the live process: a different start time means a different process.
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
  // Allow one second of clock skew between the ps timestamp and Date.now().
  return Math.abs(startedAt - heartbeat.registeredAt) < 60_000
}

/** Read the heartbeat; absent or unparsable files report undefined. */
export async function readHostHeartbeat(): Promise<WorkBuddyHostHeartbeat | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(workbuddyHostHeartbeatPath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const document = parsed as Record<string, unknown>
    if (document['version'] !== HEARTBEAT_FORMAT_VERSION) return undefined
    if (document['package'] !== 'dsh-connect-workbuddy') return undefined
    const pid = document['pid']
    const registeredAt = document['registeredAt']
    if (typeof pid !== 'number' || typeof registeredAt !== 'number') return undefined
    return {
      version: HEARTBEAT_FORMAT_VERSION,
      package: 'dsh-connect-workbuddy',
      pluginVersion: typeof document['pluginVersion'] === 'string' ? document['pluginVersion'] : WORKBUDDY_CONNECT_VERSION,
      registeredAt,
      pid,
    }
  } catch {
    return undefined
  }
}

/** Write the heartbeat for the current process. */
export async function writeHostHeartbeat(): Promise<void> {
  const heartbeat: WorkBuddyHostHeartbeat = {
    version: HEARTBEAT_FORMAT_VERSION,
    package: 'dsh-connect-workbuddy',
    pluginVersion: WORKBUDDY_CONNECT_VERSION,
    registeredAt: Date.now(),
    pid: process.pid,
  }
  await writeFile(workbuddyHostHeartbeatPath(), `${JSON.stringify(heartbeat, null, 2)}\n`, { mode: 0o600 })
}

/** Remove the heartbeat; called when the plugin is disposed. */
export async function clearHostHeartbeat(): Promise<void> {
  await rm(workbuddyHostHeartbeatPath(), { force: true })
}
