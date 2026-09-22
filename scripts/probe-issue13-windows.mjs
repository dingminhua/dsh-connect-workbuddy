/**
 * Windows reproduction and budget check for issue #13, with NO DSH involved.
 *
 * Why this probe exists: the failure is WINDOWS-ONLY and cannot be reproduced
 * on macOS/Linux. `@deepseek-ai/dsh-atomic-write` gates its rename retries on
 * `process.platform === 'win32'`, because only Windows refuses to rename over a
 * file another process holds open (POSIX `rename` replaces it regardless, so
 * the same code path simply never fails there). A developer machine on macOS
 * therefore cannot observe this bug at any hold duration — the control run
 * below documents exactly that.
 *
 * What it measures: how long a second process must hold `settings.yaml` open
 * before the write stops landing. That number is the one that matters, because
 * the plugin's own retry budget (`VERIFIED_WRITE_RETRY_DELAYS_MS`, 200 + 600 ms)
 * is only useful while the interference is shorter than it.
 *
 * Usage:
 *   node scripts/probe-issue13-windows.mjs            # scan the hold durations
 *   node scripts/probe-issue13-windows.mjs 1500       # single hold duration
 *
 * Interpretation on Windows:
 *   - writes succeed but the two longest holds fail -> the plugin's retry
 *     budget covers the shorter half; widen it if users report persistent
 *     failures at the longest hold.
 *   - every hold succeeds -> the write path is not the problem, and a #13
 *     report on that machine needs the `.lock` file checked instead (the
 *     `withFileLock` timeout is 2000 ms and fails by THROWING, which surfaces
 *     differently from the silent drop this probe measures).
 */
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { writeFileAtomic } = require('@deepseek-ai/dsh-atomic-write')

/** The plugin's own retry budget, in ms, for comparison against the scan. */
const PLUGIN_RETRY_BUDGET_MS = 200 + 600

const isWindows = process.platform === 'win32'
console.log('platform                 :', process.platform)
console.log('windows-only failure path:', isWindows ? 'ACTIVE' : 'NOT APPLICABLE')
console.log('plugin retry budget      :', PLUGIN_RETRY_BUDGET_MS, 'ms')
if (!isWindows) {
  console.log('\nNOTE: on this platform the probe is a CONTROL, not a test — the rename')
  console.log('retries are gated to win32, so POSIX replaces the file even while it is')
  console.log('held open. Successes below are expected and say nothing about Windows.')
}

/** Hold `target` open in a child process for `holdMs`, then attempt one write. */
async function attempt(holdMs) {
  const dir = await mkdtemp(join(tmpdir(), 'wb13-'))
  const target = join(dir, 'settings.yaml')
  await writeFile(target, 'workbuddy:\n  accounts:\n    cn: old\n')

  const holder = spawn(process.execPath, ['-e', `
    const fs = require('fs')
    const fd = fs.openSync(${JSON.stringify(target)}, 'r+')
    setTimeout(() => { try { fs.closeSync(fd) } catch {} }, ${holdMs})
    setTimeout(() => process.exit(0), ${holdMs + 400})
  `], { stdio: 'ignore' })

  await new Promise(resolve => setTimeout(resolve, 250))   // let it open the file
  const started = Date.now()
  let outcome
  try {
    await writeFileAtomic(target, 'workbuddy:\n  accounts:\n    cn: new\n', { mode: 0o600 })
    const landed = (await readFile(target, 'utf8')).includes('new')
    outcome = { ok: true, landed, ms: Date.now() - started }
  } catch (error) {
    outcome = { ok: false, code: error.code, message: error.message, ms: Date.now() - started }
  }
  holder.kill()
  return outcome
}

const single = process.argv[2]
const holds = single === undefined
  ? [0, 300, 800, 1500, 3000, 6000]
  : [Number(single)]

console.log(`\n${'hold'.padStart(6)}  ${'result'.padEnd(34)} elapsed`)
for (const holdMs of holds) {
  const r = await attempt(holdMs)
  const verdict = r.ok
    ? `write landed (${r.landed ? 'content NEW' : 'CONTENT UNCHANGED'})`
    : `write FAILED (${r.code ?? r.message})`
  console.log(`${String(holdMs).padStart(6)}  ${verdict.padEnd(34)} ${r.ms} ms`)
}

if (isWindows) {
  console.log('\nCompare the failing holds against the plugin retry budget of', PLUGIN_RETRY_BUDGET_MS, 'ms:')
  console.log('a hold shorter than the budget is one the plugin\'s retry can outlast.')
}
