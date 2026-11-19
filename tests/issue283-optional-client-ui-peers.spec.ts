/**
 * Issue #283 — the three `@deepseek-ai/dsh-client-ui-*` peers block the plugin
 * from installing on DSH Go (iOS / HarmonyOS), because they are NOT host
 * packages there.
 *
 * WHAT HAPPENED. DSH Go resolves a plugin's peer graph before it downloads
 * anything: a peer that is neither provided by the host (`hostPackages`) nor
 * marked `optional` in `peerDependenciesMeta` aborts the install with
 * `unsupported non-host peer <name>`. `@deepseek-ai/dsh-client-ui-primitives`,
 * `…-renderer` and `…-settings` are host WEB packages: they are injected by
 * the host's web runtime (`window.__ModuleLoader__`), they are not installed
 * into `node_modules`, and their registry scope is not `installation` — so
 * they are absent from the host package map on DSH Go. The install never got
 * past dependency-graph resolution; nothing was downloaded and no profile was
 * written.
 *
 * WHY OPTIONAL IS THE CORRECT FIX (and not "delete the peers"). These three
 * packages are referenced from `src/client/**` ONLY through `import type`:
 * they contribute TYPES to the client build and nothing at runtime. So a
 * missing peer cannot break the plugin — the peer declaration exists to pin
 * the type contract against the host line, and `optional: true` keeps that
 * declaration while removing the "the host must provide it" requirement.
 * Deleting them would silently drop the type contract and break the
 * `devDependencies` ⇄ `peerDependencies` equality that `tests/dsh-line.spec.ts`
 * enforces. This is the same shape as `react` and `@earendil-works/pi-ai`,
 * both already optional.
 *
 * WHAT THESE TESTS PIN. The declaration alone is not the whole claim: if
 * someone later adds a VALUE import of one of these packages, "optional" would
 * become a lie (the runtime would need a package the host does not install).
 * So the suite asserts the truthfulness of the flag as well as its presence.
 *
 * All strings below are package names and manifest keys — no account, device
 * or session data.
 *
 * @module dsh-connect-workbuddy/tests/issue283-optional-client-ui-peers
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = new URL('../', import.meta.url)

/** The three peers that DSH Go refuses as "unsupported non-host peer". */
const CLIENT_UI_PEERS: readonly string[] = [
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-settings',
]

/** The host line every `dsh-*` peer and devDependency is pinned to. */
const HOST_RANGE = '>=0.1.7-rc.1 <0.3.0-0'

interface Manifest {
  version?: string
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  devDependencies?: Record<string, string>
  dsh?: { client?: { inject?: string[] } }
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(fileURLToPath(new URL('package.json', repoRoot)), 'utf8')) as Manifest
}

/** Every source file under `src/`, as absolute paths. */
function sourceFiles(dir = fileURLToPath(new URL('src/', repoRoot))): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
      continue
    }
    if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

describe('issue #283 — client-ui peers are optional', () => {
  it('declares all three as optional peers', () => {
    const meta = manifest().peerDependenciesMeta ?? {}
    for (const name of CLIENT_UI_PEERS) {
      expect(meta[name]?.optional, `${name} must be marked optional`).toBe(true)
    }
  })

  it('keeps them declared as peers on the host line (the type contract stays)', () => {
    const peers = manifest().peerDependencies ?? {}
    for (const name of CLIENT_UI_PEERS) {
      expect(peers[name], `${name} must stay a peer`).toBe(HOST_RANGE)
    }
  })

  it('keeps them as devDependencies, so the type check still compiles', () => {
    const dev = manifest().devDependencies ?? {}
    for (const name of CLIENT_UI_PEERS) {
      expect(dev[name], `${name} must stay a devDependency`).toBe(HOST_RANGE)
    }
  })

  it('references them TYPE-ONLY in the client sources — "optional" must stay true', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8')
      for (const name of CLIENT_UI_PEERS) {
        for (const line of text.split('\n')) {
          if (!line.includes(`'${name}`) && !line.includes(`"${name}`)) continue
          const isTypeOnly = /\bimport\s+type\b/.test(line)
          // A `declare module '…'` line augments types; it emits no runtime edge.
          const isAmbient = /^\s*declare\s+module\b/.test(line)
          if (isTypeOnly || isAmbient) continue
          offenders.push(`${file}: ${line.trim()}`)
        }
      }
    }
    expect(offenders, 'a runtime import would make "optional" false').toEqual([])
  })

  it('leaves the client inject list alone (it is the host-side injection, not a peer)', () => {
    const inject = manifest().dsh?.client?.inject ?? []
    expect(inject).toContain('@deepseek-ai/dsh-client-ui-settings')
    expect(inject).toContain('@deepseek-ai/dsh-client-ui-slots')
    expect(inject).toContain('@deepseek-ai/dsh-client-ui-settings-plugins')
    expect(inject).toContain('@deepseek-ai/dsh-client-locale')
  })
})
