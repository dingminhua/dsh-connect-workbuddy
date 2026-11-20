/**
 * On-disk "done today" memory for the three per-account day facts (issue #286
 * follow-up): checked-in / tier-redeemed / active-today.
 *
 * WHY THIS EXISTS. The card used to RE-READ "did this account check in today"
 * from upstream every 10 minutes, for every account — including ones that had
 * been done since morning. The user asked for the obvious: once a fact is true
 * today, remember it locally and stop asking; only read when there is no record
 * yet (a fresh day, or an account the plugin has never observed). This module is
 * that memory. It is keyed by (kind, region), persisted under `$DSH_HOME`, and
 * bounded by the LOCAL day so a `true` read at 23:58 never answers for 00:08.
 *
 * It deliberately does NOT distinguish "we did it" from "the user did it in the
 * official client": both are observed as `true` from upstream and both mean the
 * same thing to the card — done today, nothing more to do. That is why the read
 * path writes the record: the first observation (whoever caused it) is enough.
 *
 * Reads/writes never throw — a corrupt or missing file means "nothing done
 * today", and the caller then performs the one read this module saves.
 *
 * No token, no account name in the file — only account ids and a local day key.
 *
 * @module dsh-connect-workbuddy/daily-done-store
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome, withFileLock, writeFileAtomic } from './host-peers.ts'
import { localDayKey } from './auto-checkin.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/** The three per-account day facts we remember. */
export type DailyDoneKind = 'checkin' | 'growth-redeem' | 'growth-activity'

const STORE_FORMAT_VERSION = 1

interface DailyDoneDocument {
  version: typeof STORE_FORMAT_VERSION
  day: string
  /** Account ids observed done on {@link day}. */
  ids: string[]
}

/** A process-local mirror so the hot path never touches the disk. */
const memory: Partial<Record<string, { day: string; ids: Set<string> }>> = {}

/**
 * Cache key includes the resolved home so a changed `$DSH_HOME` (only ever a
 * test fixture in practice) cannot reuse another home's memory. In production
 * the home is fixed for the process, so this is a pure correctness safeguard.
 */
const keyOf = (kind: DailyDoneKind, region: WorkBuddyRegion): string =>
  `${resolveDshHome()}:${kind}:${region}`

function filePath(kind: DailyDoneKind, region: WorkBuddyRegion): string {
  return join(resolveDshHome(), `.workbuddy-daydone-${kind}.${region}.json`)
}

function isDocument(value: unknown): value is DailyDoneDocument {
  if (typeof value !== 'object' || value === null) return false
  const doc = value as Record<string, unknown>
  return doc['version'] === STORE_FORMAT_VERSION
    && typeof doc['day'] === 'string'
    && Array.isArray(doc['ids'])
    && doc['ids'].every(id => typeof id === 'string')
}

/** Load one (kind, region) from disk into the mirror, once. Never throws. */
async function load(kind: DailyDoneKind, region: WorkBuddyRegion): Promise<{ day: string; ids: Set<string> }> {
  const key = keyOf(kind, region)
  const hit = memory[key]
  if (hit !== undefined) return hit
  let loaded: { day: string; ids: Set<string> } = { day: localDayKey(Date.now()), ids: new Set() }
  try {
    const raw = await readFile(filePath(kind, region), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (isDocument(parsed) && parsed.day === localDayKey(Date.now())) {
      loaded = { day: parsed.day, ids: new Set(parsed.ids) }
    }
  } catch { /* absent or corrupt — start empty */ }
  memory[key] = loaded
  return loaded
}

/** Is this account already recorded done TODAY? No disk read after the first. */
export async function isDoneToday(
  kind: DailyDoneKind,
  region: WorkBuddyRegion,
  accountId: string,
): Promise<boolean> {
  const state = await load(kind, region)
  if (state.day !== localDayKey(Date.now())) {
    // Day rolled over in a long-lived process: reset in memory; the file is
    // rewritten on the next mark.
    memory[keyOf(kind, region)] = { day: localDayKey(Date.now()), ids: new Set() }
    return false
  }
  return state.ids.has(accountId)
}

/** Record one (or several) accounts done today. Never throws. */
export async function markDoneToday(
  kind: DailyDoneKind,
  region: WorkBuddyRegion,
  accountIds: readonly string[],
): Promise<void> {
  if (accountIds.length === 0) return
  const key = keyOf(kind, region)
  const today = localDayKey(Date.now())
  const state = memory[key]?.day === today ? memory[key]! : { day: today, ids: new Set<string>() }
  for (const id of accountIds) state.ids.add(id)
  memory[key] = state
  const path = filePath(kind, region)
  try {
    await withFileLock(path, async () => {
      const document: DailyDoneDocument = { version: STORE_FORMAT_VERSION, day: today, ids: [...state.ids] }
      await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    })
  } catch { /* Swallowed by contract: state memory cannot break the plugin. */ }
}

/** The full done-today set for one (kind, region), for the first-paint map. */
export async function doneTodayMap(
  kind: DailyDoneKind,
  region: WorkBuddyRegion,
): Promise<Readonly<Record<string, boolean>>> {
  const state = await load(kind, region)
  if (state.day !== localDayKey(Date.now())) return {}
  return Object.fromEntries([...state.ids].map(id => [id, true]))
}
