/**
 * Issue #47: the standalone CLI must LOAD without the DSH host present.
 *
 * The report (Fedora, `npm install -g @deepseek-ai/dsh`, release 4.3.0):
 *
 *   $ dsh plugin --profile dsh-tui exec dsh-connect-workbuddy status
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package
 *   '@deepseek-ai/dsh-atomic-write' imported from
 *   /home/liguolong/.dsh/profiles/dsh-tui/node_modules/dsh-connect-workbuddy/lib/host-heartbeat-jNlsUMZO.js
 *
 * WHY IT HAPPENED, and why the module in the message looks unrelated to the
 * command: tsdown emits ONE shared chunk (`host-heartbeat-<hash>.js`) holding
 * `auth`, `at-rest`, `host-heartbeat`, and `pi-ai-runtime`. `lib/bin.js`
 * imports that chunk, so a read-only `status` still evaluated `auth.ts`'s
 * top-level `import … from '@deepseek-ai/dsh-atomic-write'`. A static import
 * of a missing package throws at module-evaluation time, before any command
 * body runs.
 *
 * WHY THE HOST CANNOT HELP. `@deepseek-ai/dsh-atomic-write` and
 * `@deepseek-ai/dsh-home-paths` are declared as PEERS. Inside a booted host
 * the `app-boot` runtime interception layer answers them from the
 * installation, but `dsh plugin … exec` is not that: `plugin-manager`'s
 * `runProfilePnpm` spawns `pnpm exec` in the profile directory with the plain
 * environment, so the child resolves with stock Node rules and the
 * interception layer does not exist there. DSH never sets `NODE_PATH` (it
 * scrubs it), and the profile is created with `autoInstallPeers: false`, so
 * nothing installs the peers either. Hence the crash — and why it is
 * INVISIBLE on a machine whose profile symlinks the repo checkout, where a dev
 * `node_modules` supplies the peers by accident.
 *
 * WHAT IS PINNED HERE:
 *
 * 1. `lib/bin.js`'s own import graph carries NO bare non-`node:` specifier.
 *    Checked over the BUILT output, walking relative imports, because that is
 *    the artifact that ships and the only place chunking is visible. A test
 *    over `src/` alone would NOT catch a regression: the culprit was a shared
 *    chunk, not a source file.
 * 2. The two host peers are still external for the host half (`lib/index.js`),
 *    which must keep borrowing the host's copies.
 * 3. The fallback implementations of both utilities behave like the host's,
 *    so a CLI process and the host can share one credential file.
 *
 * The negative control in `lib/index.js` is deliberate: it fails if someone
 * "fixes" this by inlining the peers for BOTH entries.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { hostPeersInfo, resolveDshHome, withFileLock, writeFileAtomic } from '../src/host-peers.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const libDir = join(root, 'lib')

/**
 * Module specifiers of one built file — import statements only.
 *
 * The shapes that matter: a side-effect import (`import "x"`), a binding
 * import (`import … from "x"`), a re-export (`export … from "x"`), and a
 * dynamic `import("x")` with a LITERAL specifier (which the bundler resolves
 * and therefore links just as hard as a static one). Bare string literals in
 * the code — DPAPI markers, error messages — are NOT specifiers, so the
 * pattern requires the import keyword rather than scanning every quoted
 * string.
 *
 * A dynamic `import(variable)` is deliberately unmatched: that deferred form
 * is exactly how this plugin keeps the peer off the load-time graph.
 */
function specifiersOf(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  // A statement in emitted ESM starts at the beginning of a line, so anchoring
  // there keeps the clause match bounded and free of brace nesting problems
  // (a minified named-import list is one long line with many braces).
  const statement = /^[ \t]*(?:import|export)\b[^\n]*?\bfrom\s*["']([^"']+)["']/gm
  const sideEffect = /^[ \t]*import\s*["']([^"']+)["']/gm
  const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  const found = [...source.matchAll(statement), ...source.matchAll(sideEffect), ...source.matchAll(dynamic)]
    .map(match => match[1] as string)
  return [...new Set(found)]
}

/** Every built ESM entry, and the chunks reachable from it through relative imports. */
function reachableModules(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier))
    }
  }
  return [...seen]
}

describe('the standalone CLI loads without the DSH host (issue #47)', () => {
  /**
   * Run the artifact checks only when `lib/` exists.
   *
   * `pnpm test` does not build, and in a fresh clone there is no `lib/` yet.
   * Failing the whole file there would blame the source for a missing build
   * step, so the artifact half is skipped with that stated plainly — CI runs
   * `pnpm check` (typecheck → test → build), where the build follows and the
   * checks below are the ones that count. The source-level guards further down
   * run either way.
   */
  const built = existsSync(join(libDir, 'bin.js'))

  it.skipIf(!built)('lib/bin.js reaches no bare non-node specifier', () => {
    // Guard the guard: a path typo would make every assertion below vacuous.
    const modules = reachableModules(join(libDir, 'bin.js'))
    expect(modules.length).toBeGreaterThan(1)
    expect(modules.some(file => file.endsWith('bin.js'))).toBe(true)

    const offenders: string[] = []
    for (const file of modules) {
      for (const specifier of specifiersOf(file)) {
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
        offenders.push(`${file.slice(root.length + 1)} imports ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it.skipIf(!built)('the host half still borrows the host copies, which is the point of the split', () => {
    // Negative control for the test above: if a future edit inlines these for
    // `index` too, the plugin would stop using the host's implementation in
    // the one place where that is the correct behaviour.
    const specifiers = specifiersOf(join(libDir, 'index.js'))
    expect(specifiers).not.toContain('@deepseek-ai/dsh-atomic-write')
    // …and the peers it DOES still need are external, proving this scans a
    // real artifact rather than an empty file.
    expect(specifiers).toContain('@deepseek-ai/dsh-llm')
    expect(specifiers).toContain('@deepseek-ai/schemastery')
  })

  /**
   * The same rule at the SOURCE level, so it holds without a build.
   *
   * Weaker than the artifact check by construction — it cannot see tsdown's
   * chunking, which is precisely what made the original defect look unrelated
   * to the crashing command — so it is a fast tripwire, not a replacement.
   * It catches the common regression (a static peer import added back to a
   * module the CLI reaches) before a build is ever run.
   */
  it('no module reachable from src/bin.ts statically imports a host peer', () => {
    const srcDir = join(root, 'src')
    /** `import … from '…'` / `import '…'`, at statement position. */
    const staticImports = (file: string): string[] => {
      const source = readFileSync(file, 'utf8')
      return [
        ...source.matchAll(/^[ \t]*import\b[^\n]*?\bfrom\s*['"]([^'"]+)['"]/gm),
        ...source.matchAll(/^[ \t]*import\s*['"]([^'"]+)['"]/gm),
      ].map(match => match[1] as string)
    }
    const seen = new Set<string>()
    const queue = [join(srcDir, 'bin.ts')]
    const offenders: string[] = []
    while (queue.length > 0) {
      const file = queue.pop() as string
      if (seen.has(file) || !existsSync(file)) continue
      seen.add(file)
      for (const specifier of staticImports(file)) {
        if (specifier.startsWith('.')) {
          // `./x.ts` is the repo's style; accept an extension-less spelling too.
          const base = resolve(dirname(file), specifier)
          for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
            if (existsSync(candidate)) queue.push(candidate)
          }
          continue
        }
        if (specifier.startsWith('node:')) continue
        offenders.push(`${file.slice(root.length + 1)} statically imports ${specifier}`)
      }
    }
    // The walk really followed the graph.
    expect(seen.size).toBeGreaterThan(1)
    expect(offenders).toEqual([])
  })

  it('the peers stay declared, so the host half keeps resolving them', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      peerDependencies?: Record<string, string>
    }
    // Dropping the declaration is the OTHER tempting "fix": it would silence
    // the error by making the host stop supplying the packages.
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-atomic-write']).toBeDefined()
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-home-paths']).toBeDefined()
  })
})

describe('host-peer fallback behaves like the host copy', () => {
  const made: string[] = []
  afterEach(async () => {
    for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
  })
  async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'workbuddy-host-peers-'))
    made.push(dir)
    return dir
  }

  it('writes atomically, creating the parent chain', async () => {
    const dir = await scratch()
    const target = join(dir, 'nested', 'deeper', 'creds.json')
    await writeFileAtomic(target, '{"a":1}\n', { mode: 0o600, dirMode: 0o700 })
    expect(await readFile(target, 'utf8')).toBe('{"a":1}\n')
    // No temp sibling survives a successful commit.
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(dirname(target))).toEqual(['creds.json'])
  })

  it('serializes writers and always releases the lock', async () => {
    // THE invariant the fallback exists to preserve: two processes (a CLI and
    // the host) must not interleave a read-render-write on one credential
    // file. A fallback that used a different lock path or no lock at all would
    // make that possible while every other test stayed green.
    //
    // The assertion is on MUTUAL EXCLUSION, not on who wins: the two callers
    // start together, so which one acquires first is a scheduler detail. What
    // must never happen is interleaving (`a:start, b:start, a:end, b:end`),
    // which is exactly what a missing lock produces.
    const dir = await scratch()
    const target = join(dir, 'creds.json')
    await writeFile(target, '{}', 'utf8')
    const order: string[] = []
    let concurrent = 0
    let peak = 0
    const critical = (label: string, hold: boolean) => withFileLock(target, async () => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      order.push(`${label}:start`)
      if (hold) await new Promise(done => setTimeout(done, 50))
      order.push(`${label}:end`)
      concurrent -= 1
    })
    await Promise.all([critical('a', true), critical('b', false)])

    expect(peak).toBe(1)
    // Each caller's own pair stays adjacent: no interleaving.
    const tightened = order.filter(step => step.startsWith('a:'))
    expect(tightened).toHaveLength(2)
    expect(order.indexOf('a:end')).toBe(order.indexOf('a:start') + 1)
    expect(order.indexOf('b:end')).toBe(order.indexOf('b:start') + 1)
    await expect(readFile(`${target}.lock`, 'utf8')).rejects.toThrow()
  })

  it('releases the lock even when the operation throws', async () => {
    const dir = await scratch()
    const target = join(dir, 'creds.json')
    await writeFile(target, '{}', 'utf8')
    await expect(withFileLock(target, async () => {
      throw new Error('render failed')
    })).rejects.toThrow('render failed')
    await expect(readFile(`${target}.lock`, 'utf8')).rejects.toThrow()
  })

  it('reports which implementation this process uses', async () => {
    // Outside DSH (as in this suite) the fallback is the expected answer; the
    // value is reported rather than asserted so the same test is meaningful
    // when run inside a host.
    const info = await hostPeersInfo()
    expect(['host', 'fallback']).toContain(info.atomicWrite)
  })

  it('resolves the harness home with the documented precedence', () => {
    // Explicit path wins outright — asserted through the PLATFORM'S OWN
    // resolver, not against a hardcoded POSIX string. `resolveDshHome` runs
    // `path.resolve` on its argument, so on Windows `/explicit/home` becomes
    // `\explicit\home`; comparing to the literal made this test fail on
    // `windows-latest` and nowhere else. That is precisely the mistake
    // `docs/WINDOWS.md` §4 warns about ("assert the behaviour, not which
    // machine is running the suite"), and it is why the expected value is
    // computed here rather than written out.
    expect(resolveDshHome('/explicit/home')).toBe(resolve('/explicit/home'))
    // A second, separator-free spelling proves the argument is what wins, not
    // an accident of how one string was typed.
    expect(resolveDshHome('relative-ish')).toBe(resolve('relative-ish'))
    // `$DSH_HOME` is what the suite's own per-file setup injects, and it must
    // be used when no explicit path is given.
    expect(resolveDshHome()).toBe(resolve(process.env.DSH_HOME as string))
  })
})
