/**
 * The audit script is plain ESM, not TypeScript — declare the surface its tests
 * use.
 *
 * Types live here rather than in the script so scripts/ stays runnable by any
 * node without a build step, and so a test that calls a function the script no
 * longer exports fails to compile instead of failing at runtime.
 */

export interface AuditRequest {
  seq: number
  time: number
  turn?: number
  surface: number
  cached: number
  uncached: number
  cause: 'prompt-changed' | 'cache-expired'
}

export interface SessionUsage {
  totalTokens?: number
  cacheReadTokens?: number
  inputTokens?: number
}

export interface SessionEvent {
  type: string
  seq: number
  time?: number
  /** Log events carry their own payload; only these fields are read here. */
  data?: { turn?: number, usage?: SessionUsage } & Record<string, unknown>
}

export function decodeLog(raw: Buffer): string
export function readEvents(raw: Buffer): SessionEvent[]
export function summarizeSession(events: SessionEvent[], options?: { minSurface?: number, promptChangeWindow?: number }): AuditRequest[]
export function sessionFiles(home: string): { label: string, path: string }[]
export function stamp(ms: number): { text: string, peak: boolean }
export function creditsOf(uncached: number, peak: boolean, creditsPerK: number, offpeakFactor: number): number
/** `{}` when no rate was supplied, so the row has no `credits` key at all. */
export function creditsFieldOf(uncached: number, peak: boolean, creditsPerK: number, offpeakFactor: number): { credits?: number }
