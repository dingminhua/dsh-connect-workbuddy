/**
 * The privacy gate has to keep existing.
 *
 * WHY THIS TEST EXISTS. `docs/PRIVACY.md` and `scripts/check-pii.mjs` only work
 * if they are wired into the paths that matter: the publish path (`prepack`),
 * the local pre-flight (`check`), and the published file list (the policy ships
 * with the package). All three are one-line edits in `package.json`, and a
 * one-line edit is exactly the kind of thing that gets dropped while resolving
 * a merge or "simplifying" the scripts block. Nothing else in the suite would
 * notice: the scanner is not imported by any source file.
 *
 * These assertions are deliberately narrow. They pin the WIRING, not the scanner
 * implementation — the scanner has its own mutation story in
 * `tests/check-pii-script.spec.ts`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  files: string[]
  scripts: Record<string, string>
}

describe('the privacy gate is still wired in', () => {
  it('runs the scanner before packing, so a leak cannot reach npm', () => {
    expect(manifest.scripts.prepack).toContain('scripts/check-pii.mjs')
  })

  it('runs the scanner in the local pre-flight', () => {
    expect(manifest.scripts.check).toContain('check:pii')
    expect(manifest.scripts['check:pii']).toContain('scripts/check-pii.mjs')
  })

  it('ships the policy document to users, not just to the repo', () => {
    // The policy is a promise to downstream users; hiding it in the repo only
    // means the promise is never shown to the people it is about.
    expect(manifest.files).toContain('docs/PRIVACY.md')
  })

  it('actually passes right now', () => {
    // Runs the real script, so this test fails if the repository is dirty —
    // which is the whole point of wiring it in.
    const out = execFileSync(process.execPath, ['scripts/check-pii.mjs', '--quiet'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(out.trim()).toBe('')
  })
})
