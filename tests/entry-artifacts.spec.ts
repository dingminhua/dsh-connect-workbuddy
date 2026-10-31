/**
 * `scripts/verify-entry-artifacts.mjs` must answer the same question DSH's
 * installer asks, because its whole point is to fail here instead of at the
 * next boot. These cases pin the two verdicts it is allowed to give and the
 * one shape it must NOT mistake for a pass (a subpath pattern).
 *
 * The script is spawned as a real process rather than imported: it runs
 * before `lib/` exists, so it cannot depend on the build it is checking.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/verify-entry-artifacts.mjs', import.meta.url))

let dir = ''

/** A package directory with the given manifest and files (files are created empty). */
function fixture(manifest: unknown, files: readonly string[] = []): string {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  for (const file of files) {
    const path = join(dir, file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '')
  }
  return dir
}

function run(target: string = dir): { status: number | null, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [script, target], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'entry-artifacts-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('verify-entry-artifacts', () => {
  it('passes when every declared artifact exists', () => {
    fixture({ name: 'p', version: '1.0.0', main: 'lib/index.js', exports: { '.': './lib/index.js' } }, ['lib/index.js'])
    const { status, stdout } = run()
    expect(status).toBe(0)
    expect(stdout).toContain('lib/index.js')
    // Declared three ways, counted once: the summary is a file count, not a
    // line count, otherwise a package looks healthier the more aliases it has.
    expect(stdout).toContain('1 declared artifact(s) present')
  })

  it('fails and names the missing file, with the source-checkout explanation', () => {
    // The exact shape that produced the DSH warning: a checkout whose `lib/`
    // was never built. No `lib/` at all means "not built", not "wrong path".
    fixture({ name: 'p', version: '1.0.0', main: 'lib/index.js' })
    const { status, stdout } = run()
    expect(status).toBe(1)
    expect(stdout).toContain('MISSING lib/index.js')
    expect(stdout).toContain('never built')
    expect(stdout).toContain('link:` installs run no lifecycle scripts')
  })

  it('says the build and the manifest disagree when lib exists but the file does not', () => {
    // Different cause, different advice: rebuilding cannot fix a path the
    // build never emits, so the two cases must not share one message.
    fixture({ name: 'p', version: '1.0.0', main: 'lib/index.js', exports: { './client': './lib/client.js' } }, ['lib/index.js'])
    const { status, stdout } = run()
    expect(status).toBe(1)
    expect(stdout).toContain('lib/client.js')
    expect(stdout).toContain('disagreement')
    expect(stdout).not.toContain('never built')
  })

  it('does not treat a subpath pattern as a missing file', () => {
    // `./locale/*.json` names a family. There is no single path to stat, and
    // reporting one would fail a package that is perfectly loadable.
    fixture({
      name: 'p',
      version: '1.0.0',
      main: 'lib/index.js',
      exports: { '.': './lib/index.js', './locale/*.json': './locale/*.json' },
    }, ['lib/index.js'])
    const { status, stdout } = run()
    expect(status).toBe(0)
    expect(stdout).not.toContain('locale/')
  })

  it('checks bin and the bundle patch too', () => {
    fixture({
      name: 'p',
      version: '1.0.0',
      main: 'lib/index.js',
      bin: { p: 'lib/bin.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, ['lib/index.js'])
    const { status, stdout } = run()
    expect(status).toBe(1)
    expect(stdout).toContain('lib/bin.js')
    expect(stdout).toContain('cordis.patch.yml')
  })

  it('reports an unreadable manifest as its own failure, not as "missing"', () => {
    writeFileSync(join(dir, 'package.json'), '{ not json')
    const { status, stderr } = run()
    expect(status).toBe(2)
    expect(stderr).toContain('package.json')
  })
})
