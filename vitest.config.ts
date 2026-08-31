import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Tests must never touch the real DSH home: the plugin writes a heartbeat and
 * a credential copy under `$DSH_HOME`, and polluting a developer's real
 * profile (or being blocked by the sandbox) would make results meaningless.
 *
 * `WORKBUDDY_AUTH_FILE` is deliberately NOT set here: it is the explicit-path
 * override, and setting it would take every test down the "user pinned one
 * file" branch instead of the platform-default scanning branch.
 */
const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-connect-workbuddy-test-'))

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    env: {
      DSH_HOME: isolatedHome,
    },
    // Windows runners cold-start PowerShell very slowly; `processStartTimeMs`
    // shells out to `powershell` there, so give heartbeat tests headroom.
    // Locally (macOS/Linux) each test still finishes in well under a second.
    testTimeout: 30_000,
  },
})
