import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every test FILE gets its own DSH_HOME.
 *
 * The unified credential vault lives under DSH_HOME and persists EVERY
 * credential a scan sees, so with the config-level shared home one file that
 * mounts the real plugin would seed accounts that every later file then
 * "discovers" — issue #12's region-hiding tests read phantom global accounts
 * exactly that way. A per-file home keeps each file's accounts its own, the
 * same isolation `.spec` fixtures already pin through `authDirs`.
 *
 * `setupFiles` run once per test file (in the file's own worker), so this
 * is process-env-wide for the file and needs no restore.
 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-connect-workbuddy-file-'))
