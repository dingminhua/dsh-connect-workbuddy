import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Tests must never touch the real DSH home: the plugin writes a heartbeat and
 * a credential copy under `$DSH_HOME`, and polluting a developer's real
 * profile (or being blocked by the sandbox) would make results meaningless.
 */
const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-connect-workbuddy-test-'))

/**
 * The home-derived paths must be isolated too, not just `DSH_HOME`.
 *
 * `defaultDesktopAuthDirs()` resolves the WorkBuddy desktop auth directory from
 * the OS home (`~/Library/Application Support/...` on macOS, `%LOCALAPPDATA%`
 * and `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` on Linux). Left
 * alone, every test that does not pin `authFile` reads whichever sign-ins the
 * MACHINE happens to have — so a suite that passes on a developer's laptop can
 * fail on a clean CI runner, which is exactly how 2.0.6 shipped a red build:
 * two tests loaded the plugin with `{}` and asserted each region served its
 * fallback roster, which since issue #12 requires a local sign-in. Locally the
 * developer's own accounts satisfied that; on CI neither region had one and
 * both rosters were correctly empty.
 *
 * Pointing these at an empty temp directory makes the ambient answer "no
 * accounts" on every platform, so a test that needs a region to serve MUST pin
 * its own fixture (see `writeRegionFixtures` in settings-integration.spec.ts).
 * That turns an environment-dependent pass into a real assertion.
 *
 * `HOME` and `USERPROFILE` cover `os.homedir()` (POSIX vs Windows);
 * `LOCALAPPDATA` / `APPDATA` cover the Windows branch of
 * `defaultDesktopAuthDirs()`, which prefers them over the home-derived
 * convention; `XDG_CONFIG_HOME` covers the Linux branch. All are set even on
 * platforms that ignore them so one config serves every runner.
 */
const isolatedEnv = {
  DSH_HOME: isolatedHome,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  LOCALAPPDATA: join(isolatedHome, 'AppData', 'Local'),
  APPDATA: join(isolatedHome, 'AppData', 'Roaming'),
  XDG_CONFIG_HOME: join(isolatedHome, '.config'),
}

/**
 * `WORKBUDDY_AUTH_FILE` is deliberately NOT set here: it is the explicit-path
 * override, and setting it would take every test down the "user pinned one
 * file" branch instead of the platform-default scanning branch.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    env: isolatedEnv,
    // Windows runners cold-start PowerShell very slowly; `processStartTimeMs`
    // shells out to `powershell` there, so give heartbeat tests headroom.
    // Locally (macOS/Linux) each test still finishes in well under a second.
    testTimeout: 30_000,
  },
})
