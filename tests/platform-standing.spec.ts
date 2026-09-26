import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Guard the project's platform standing: Windows is a first-class target.
 *
 * This is a POLICY test, not a behaviour test. It does not prove the Windows
 * code paths work — CI on `windows-latest` and the pinned unit tests do that.
 * It proves the *standing* cannot silently decay: the CI matrix keeps a
 * Windows runner, the platform register keeps existing, and the READMEs keep
 * telling users Windows is supported, with the three files staying in step.
 *
 * Why this is worth a test rather than a convention: every element here is a
 * one-line deletion away from gone, and none of them fails loudly. Dropping
 * `windows-latest` from the matrix would leave CI green; deleting the register
 * would break no build; a README losing its Platform-support section would
 * still render. The decay is invisible until a Windows user is affected — and
 * by then the regression is old. A failing assertion is cheaper than that.
 *
 * Counterpart documents: `docs/WINDOWS.md` (the register), README.md /
 * README.en.md (the user-facing summary), RELEASING.md §2.5 (the per-release
 * checklist). If you are here because this test failed, do not delete the
 * assertion — restore the artifact it names.
 */

const repoRoot = new URL('../', import.meta.url)

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, repoRoot)), 'utf8')
}

describe('platform standing', () => {
  it('keeps a Windows runner in the CI matrix', () => {
    const ci = read('.github/workflows/ci.yml')
    // A matrix that lost its Windows entry still passes everything else, so
    // this is the only thing that would notice.
    expect(ci).toContain('windows-latest')
    expect(ci).toContain('ubuntu-latest')
    expect(ci).toMatch(/os:\s*\[[^\]]*windows-latest/)
  })

  it('keeps the platform register', () => {
    // Throws (failing this test) if the file is gone.
    const register = read('docs/WINDOWS.md')
    // The register is only useful if it still carries its substance: the four
    // Windows-specific seams and the evidence tiers that govern wording.
    for (const seam of ['defaultDesktopAuthDirs', 'workbuddyAppExecutableCandidates', 'processStartTimeMs']) {
      expect(register).toContain(seam)
    }
    expect(register).toContain('证据分级')
    expect(register).toContain('不可能复现')
  })

  it('keeps a Platform support section in both READMEs, and they agree', () => {
    const zh = read('README.md')
    const en = read('README.en.md')
    expect(zh).toContain('## 平台支持')
    expect(en).toContain('## Platform support')

    // Both must state Windows support in the strong form the project holds to,
    // not merely mention Windows in passing (which both already did before
    // this section existed — scattered mentions were exactly the gap).
    expect(zh).toContain('一等目标平台')
    expect(en).toContain('first-class target')

    // The cross-reference must survive: the READMEs defer the details to the
    // register, so a renamed register would otherwise leave a dead link.
    expect(zh).toContain('docs/WINDOWS.md')
    expect(en).toContain('docs/WINDOWS.md')
  })

  it('keeps the per-release platform check in RELEASING.md', () => {
    const releasing = read('RELEASING.md')
    expect(releasing).toContain('平台核对')
    expect(releasing).toContain('docs/WINDOWS.md')
  })

  it('keeps DESIGN.md pointing at the register', () => {
    // The design note is where a contributor reads about the platform paths.
    expect(read('docs/DESIGN.md')).toContain('WINDOWS.md')
  })
})

describe('Windows code paths stay present', () => {
  /**
   * The four seams `docs/WINDOWS.md` §1 registers. These assertions are
   * deliberately shallow — they check the platform branch still EXISTS, not
   * that it behaves (the suites under `tests/` do that). A refactor that
   * genuinely removes a branch should also update the register, and whoever
   * does that will see this test name and the register together.
   */
  it('keeps the win32 credential-directory branch', () => {
    const auth = read('src/auth.ts')
    expect(auth).toContain("platform === 'win32'")
    expect(auth).toContain('LOCALAPPDATA')
    expect(auth).toContain('APPDATA')
  })

  it('keeps the win32 executable candidates and the .exe name', () => {
    const atRest = read('src/at-rest.ts')
    expect(atRest).toContain("platform === 'win32'")
    expect(atRest).toMatch(/WorkBuddy\.exe/)
  })

  it('keeps the Windows heartbeat timestamp source', () => {
    const heartbeat = read('src/host-heartbeat.ts')
    expect(heartbeat).toContain("process.platform === 'win32'")
    expect(heartbeat).toContain('powershell')
  })

  it('never hard-codes a POSIX separator in a path this project builds', () => {
    // The 2.0.11 CI break, distilled: production code was fine because it used
    // `join`, while a TEST asserted a POSIX literal and therefore asserted
    // "the test machine is POSIX". This guards the production sources against
    // the same mistake: a Windows credential or executable path must be built
    // with `join`, never by concatenating '/' into it.
    for (const file of ['src/auth.ts', 'src/at-rest.ts', 'src/host-heartbeat.ts', 'src/status-paths.ts']) {
      const source = read(file)
      const suspicious = [...source.matchAll(/['"`][^'"`\n]*\/[^'"`\n]*CodeBuddyExtension[^'"`\n]*['"`]/g)]
      expect(suspicious.map(m => m[0]), `${file} builds a platform path without join()`).toEqual([])
    }
  })
})

describe('the profile configuration file is named correctly', () => {
  /**
   * On the 0.1.7 line the write-back check re-reads the active profile's patch
   * file (`cordis.patch.yml`, `config-editor`'s `documentPath`); `settings.yaml`
   * is only imported once from earlier releases and then renamed to
   * `settings.yaml.imported`. The whole plugin once said `settings.yaml`, which
   * sent a Windows user chasing the wrong file in exactly the situation this
   * project's headline Windows limitation describes.
   *
   * That is a DOCUMENTATION bug in a user-facing string, so it is guarded where
   * the string lives. The lock-held verification steps in `docs/WINDOWS.md` §7.3
   * depend on the same fact — locking the wrong file verifies nothing.
   */
  const SOURCES = ['src/client/account-selection.ts', 'src/client/WorkBuddyCard.tsx', 'src/client/locales.ts'] as const

  it('describes the profile patch file, not settings.yaml, as the document being written', () => {
    for (const file of SOURCES) {
      const source = read(file)
      // A live claim that the document IS settings.yaml. The corrected comment
      // in account-selection.ts mentions the name only to say it is NOT it, so
      // match the positive claims rather than the bare word.
      expect(source, `${file} claims the written document is settings.yaml`)
        .not.toMatch(/document is `settings\.yaml`/)
      expect(source, `${file} tells the user to look for settings.yaml`)
        .not.toMatch(/holds? settings\.yaml/)
    }
    expect(read('src/client/account-selection.ts')).toContain('cordis.patch.yml')
  })

  it('keeps the verification guide pointing at the file that is actually locked', () => {
    const guide = read('docs/WINDOWS.md')
    expect(guide).toContain('cordis.patch.yml')
    expect(guide).toContain('不是 `settings.yaml`')
  })
})
