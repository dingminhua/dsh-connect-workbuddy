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

  it('never points the settings UI at a file that does not ship', () => {
    // WHY THIS EXISTS. 5.24.7 shipped a setting whose description told users to
    // read `docs/STABLE-KEY-SEMANTICS.md` — a file OUTSIDE the npm `files`
    // whitelist. Installed users got a link to nothing, and the settings text
    // is the switch's ONLY user-facing explanation (READMEs do not cover it).
    // The dead pointer was invisible to every other gate: builds pass, tests
    // pass, `check-pii` passes — a path inside a string literal breaks nothing.
    //
    // The guard is deliberately DYNAMIC: it extracts every `docs/*.md` pointer
    // from schema descriptions in src/index.ts and requires it to ship. Delete
    // the whitelist entry, or repoint a description at any unshipped doc, and
    // this goes red — the bug cannot rot back in silently.
    const src = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
    // One nesting level of ASCII parens is tolerated; a description with deeper
    // nesting would be skipped by this regex. That is fine for a drift net: the
    // CURRENT descriptions all match (verified by the explicit assertion below
    // finding the very pointer this test was born from).
    const descriptions = src.match(/\.description\((?:[^()]|\([^()]*\))*\)/gu) ?? []
    expect(descriptions.length).toBeGreaterThan(0)
    const pointers = new Set<string>()
    for (const d of descriptions) {
      for (const m of d.matchAll(/docs\/[A-Za-z0-9_.-]+\.md/gu)) pointers.add(m[0])
    }
    // One known pointer must exist, or the regex above silently matched nothing
    // and the loop would pass vacuously — the failure mode this whole test was
    // written to prevent. 5.24.8 shipped the pointer; it only disappears if
    // someone rewrites the description on purpose.
    expect(pointers.has('docs/STABLE-KEY-SEMANTICS.md')).toBe(true)
    for (const p of pointers) {
      const ships = manifest.files.some(
        (entry) => entry === p || (entry.endsWith('/') ? p.startsWith(entry) : `${p}`.startsWith(`${entry}/`)),
      )
      expect(ships, `settings description points at ${p}, which does not ship`).toBe(true)
    }
  })

  it('is a named CI step, so a leak fails a check rather than a pack log', () => {
    // `prepack` already covers the publish path, but it surfaces as a failed
    // `npm pack` with the real reason buried in the output — and it vanishes if
    // anyone edits `prepack`. A dedicated CI step makes the gate a first-class
    // result, and its absence is visible in the Actions tab rather than in a
    // wall of npm notices.
    const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
    expect(ci).toContain('check:pii')
  })

  it('is written down where a contributor will see it before writing code', () => {
    // The gate catches a leak at pack time — but the expensive mistakes happen
    // while WRITING: a real nickname pasted into a JSDoc comment (tsdown keeps
    // it, and `lib/` ships) or a screenshot redacted with a translucent overlay.
    // A rule nobody reads before touching the code is enforced too late.
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    const contributing = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8')
    for (const doc of [agents, contributing]) {
      // Each must point at the authoritative policy and name the command,
      // rather than restating the rules and drifting out of sync with it.
      expect(doc).toContain('docs/PRIVACY.md')
      expect(doc).toContain('scripts/check-pii.mjs')
    }
    // The one fact that actually caused a leak: comments ship.
    expect(agents).toContain('JSDoc')
    expect(contributing).toContain('JSDoc')
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
