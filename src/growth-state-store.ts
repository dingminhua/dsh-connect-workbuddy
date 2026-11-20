/**
 * On-disk memory for the two background growth capabilities (issue #286).
 *
 * Same discipline as `auto-checkin-store.ts`: one file per CAPABILITY + REGION
 * under `$DSH_HOME`, atomic + locked writes, `mode: 0o600`, no token and no
 * account name inside — only account ids and a short failure reason. Kept in a
 * separate file from auto-check-in so the three capabilities' `doneAccountIds`
 * can never overwrite each other: "checked in" ≠ "active" ≠ "redeemed".
 *
 * Reads and writes never throw. A corrupt file degrades to "nothing done
 * today", and a repeat run is idempotent by design.
 *
 * @module dsh-connect-workbuddy/growth-state-store
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome, withFileLock, writeFileAtomic } from './host-peers.ts'
import type { AutoCheckinState } from './auto-checkin.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/** The capabilities that keep a daily state. */
export type GrowthCapability = 'growth-redeem' | 'growth-activity'

const STORE_FORMAT_VERSION = 1

interface GrowthStateDocument {
  version: typeof STORE_FORMAT_VERSION
  regions: Record<string, AutoCheckinState>
}

/** Path for one capability + region. */
export function growthStatePath(capability: GrowthCapability, region: WorkBuddyRegion): string {
  return join(resolveDshHome(), `.workbuddy-${capability}.${region}.json`)
}

function isState(value: unknown): value is AutoCheckinState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['day'] === 'string'
    && Array.isArray(candidate['doneAccountIds'])
    && candidate['doneAccountIds'].every(id => typeof id === 'string')
    && typeof candidate['failures'] === 'number'
    && Number.isFinite(candidate['failures'])
    && (candidate['lastAttemptAtMs'] === undefined || typeof candidate['lastAttemptAtMs'] === 'number')
    && (candidate['lastError'] === undefined || typeof candidate['lastError'] === 'string')
}

/** Read one capability + region's state, or undefined when absent/corrupt. */
export async function readGrowthState(
  capability: GrowthCapability,
  region: WorkBuddyRegion,
): Promise<AutoCheckinState | undefined> {
  try {
    const raw = await readFile(growthStatePath(capability, region), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const document = parsed as Partial<GrowthStateDocument>
    if (document.version !== STORE_FORMAT_VERSION) return undefined
    const regions = document.regions
    if (typeof regions !== 'object' || regions === null) return undefined
    const state = (regions as Record<string, unknown>)[region]
    return isState(state) ? state : undefined
  } catch {
    return undefined
  }
}

/** Write one capability + region's state, merging the sibling region. Never throws. */
export async function writeGrowthState(
  capability: GrowthCapability,
  region: WorkBuddyRegion,
  state: AutoCheckinState,
): Promise<void> {
  const path = growthStatePath(capability, region)
  try {
    await withFileLock(path, async () => {
      let existing: Record<string, AutoCheckinState> = {}
      try {
        const raw = await readFile(path, 'utf8')
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed === 'object' && parsed !== null) {
          const doc = parsed as Partial<GrowthStateDocument>
          if (doc.version === STORE_FORMAT_VERSION && typeof doc.regions === 'object' && doc.regions !== null) {
            const clean: Record<string, AutoCheckinState> = {}
            for (const [key, value] of Object.entries(doc.regions as Record<string, unknown>)) {
              if (isState(value)) clean[key] = value
            }
            existing = clean
          }
        }
      } catch { /* absent or corrupt — start fresh */ }
      const document: GrowthStateDocument = {
        version: STORE_FORMAT_VERSION,
        regions: { ...existing, [region]: state },
      }
      await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  } catch {
    // Swallowed by contract — a state write cannot break the plugin.
  }
}
