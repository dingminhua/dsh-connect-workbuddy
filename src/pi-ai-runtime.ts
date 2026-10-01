/**
 * Which `@earendil-works/pi-ai` copy THIS plugin actually resolves at runtime.
 *
 * WHY THIS EXISTS (issues #24 / #25 / #26). The plugin declares pi-ai as a
 * peer (`>=0.85.0 <0.88.0`), so the module it imports is whatever the host
 * environment provides — and the two generations consume DIFFERENT context
 * shapes:
 *
 * - 0.87 hands providers a normalized transcript: `{ messages: [ {role:
 *   'system', content, toolsAdded}, … ] }`. The system prompt and the tool
 *   declarations live ONLY on that leading system message; the top-level
 *   `systemPrompt` / `tools` fields are gone, and 0.87's api never reads them
 *   back.
 * - 0.85 expects `{ systemPrompt, tools, messages }` and has no branch for a
 *   `system` message inside `messages` at all: its token estimator crashes on
 *   one (issue #24), and its wire converter silently drops it.
 *
 * Which copy resolves is NOT predictable from the host version alone: a
 * nested 0.85.1 on disk shadows the host's 0.87.1 (the plugin author's own
 * symlinked checkout does exactly that), while a clean market install has no
 * local copy at all and resolves the host's (issue #26's reporter). The
 * adapter therefore gates on what THIS plugin resolves.
 *
 * HOW it is detected — deliberately WITHOUT importing pi-ai:
 * `import.meta.resolve` locates the entry file (executing nothing), the
 * package manifest sitting beside it names the version, and the generation is
 * decided from that version (0.87+ → modern). A static import would drag
 * pi-ai into the standalone `doctor` CLI, which must also run from market
 * installs where NO local pi-ai exists and the module is only provided inside
 * the DSH host — a static import there is a load-time crash. Resolution
 * itself does not need the module: within the peer range, the manifest
 * version and the `normalizeContext` feature (present from 0.87 on, not
 * before) agree.
 *
 * When resolution FAILS — the normal state of a market install probed outside
 * the host — there is no local copy, so inside DSH the host supplies pi-ai.
 * Every DSH host that normalizes contexts (0.2.0+, via 0.87.1) also supplies
 * 0.87.1, so the reported generation defaults to `modern` (pass-through).
 * That default is safe on older hosts too: they never normalize, and a native
 * 0.85-shaped context is an identity under BOTH branches of the adapter gate.
 *
 * `doctor` prints the resolved version and path so mixed-generation setups —
 * the silent kind that produced #24 and #26 — become visible on demand.
 *
 * @module dsh-connect-workbuddy/pi-ai-runtime
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The resolved pi-ai generation, by context-shape capability. */
export type PiAiGeneration = 'modern' | 'legacy'

/** What {@link piAiRuntimeInfo} reports about the resolved pi-ai copy. */
export interface PiAiRuntimeInfo {
  /** `modern` (0.87+: consumes normalized transcripts natively) or `legacy` (0.85 shape). */
  generation: PiAiGeneration
  /** Version of the resolved copy, when the manifest could be read. */
  version: string | undefined
  /** File the bare `@earendil-works/pi-ai` specifier resolved to. */
  resolvedFrom: string | undefined
  /**
   * Whether pi-ai resolves from the plugin's own path. `false` is the normal
   * state of a market install probed OUTSIDE the DSH host: no local copy
   * exists, and the host supplies the module at plugin runtime. Inside the
   * host this stays `true` whenever a local copy exists, because a nested
   * copy shadows host injection (that shadowing is what issue #24 proved).
   */
  resolvedLocally: boolean
}

let cached: PiAiRuntimeInfo | undefined

/** Resolve (once) which pi-ai copy this plugin runs against. */
export function piAiRuntimeInfo(): PiAiRuntimeInfo {
  cached ??= piAiRuntimeFor(resolveModuleFile())
  return cached
}

/**
 * The decision table for one resolution result, exported so the branch that
 * only ever runs on OTHER machines (a market install with no local pi-ai) is
 * pinned by tests rather than by this comment.
 *
 * `undefined` means nothing local resolved — inside DSH the host supplies the
 * module, and every host that normalizes contexts (0.2.0+, via 0.87.1) ships
 * the modern generation, so that is the default. Older hosts never normalize,
 * and their native 0.85-shaped context is an identity under either gate
 * branch, so the default cannot hurt them.
 */
export function piAiRuntimeFor(resolvedFrom: string | undefined): PiAiRuntimeInfo {
  if (resolvedFrom === undefined) {
    return { generation: 'modern', resolvedFrom: undefined, version: undefined, resolvedLocally: false }
  }
  const version = readVersion(resolvedFrom)
  return { generation: generationOf(version), resolvedFrom, version, resolvedLocally: true }
}

/**
 * The file the main entry resolved to; undefined when resolution itself fails.
 *
 * `import.meta.resolve` (not `require.resolve`): pi-ai's exports map exposes
 * "." under the `import` condition only, so the CJS resolver refuses the bare
 * specifier outright — the ESM resolver is the one this plugin actually
 * imports with, so it is also the one whose answer is meaningful here.
 */
function resolveModuleFile(): string | undefined {
  try {
    return fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'))
  } catch {
    return undefined
  }
}

/**
 * The version of the package owning `moduleFile`. pi-ai's exports map does
 * not expose `./package.json`, so the manifest is found by walking up from
 * the resolved entry — `dist/index.js` sits directly inside the package —
 * and claiming it only when its `name` matches, so a same-named ancestor
 * (a pnpm virtual-store parent, for instance) cannot be misread.
 */
function readVersion(moduleFile: string | undefined): string | undefined {
  if (moduleFile === undefined) return undefined
  let directory = dirname(moduleFile)
  for (let depth = 0; depth < 4; depth++) {
    try {
      const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown, version?: unknown }
      if (parsed.name === '@earendil-works/pi-ai' && typeof parsed.version === 'string') return parsed.version
    } catch {
      // No manifest here (or not JSON): keep walking up.
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
  return undefined
}

/**
 * The generation a manifest version belongs to. Within the peer range
 * (<0.88.0) the split is exactly `0.87+` versus earlier; an unreadable
 * version conservatively reports `legacy` (and doctor shows it as
 * unreadable, so the guess is visible rather than silent).
 */
function generationOf(version: string | undefined): PiAiGeneration {
  if (version === undefined) return 'legacy'
  const match = /^0\.(\d+)\./u.exec(version)
  if (match === null) return 'legacy'
  return Number(match[1]) >= 87 ? 'modern' : 'legacy'
}
