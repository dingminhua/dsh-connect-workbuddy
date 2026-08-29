#!/usr/bin/env node
/**
 * Probe the WorkBuddy desktop auth file(s): STRUCTURE ONLY.
 *
 * Never prints token material. Strings >= 24 chars and every value under a
 * token/secret-like key are redacted to a length + shape hint.
 *
 * Purpose: decide whether WorkBuddy can expose multiple selectable accounts
 * (as Trae does) or only a single followed sign-in.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

const SECRET_KEY = /token|secret|password|authorization|cookie|session/i

function redactString(key, value) {
  if (SECRET_KEY.test(key)) return `<redacted len=${value.length}>`
  if (/^eyJ/.test(value)) return `<redacted jwt len=${value.length}>`
  if (value.length >= 24) return `<redacted len=${value.length}>`
  return value
}

function shape(value, key = '', depth = 0) {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (value.length === 0) return '[] (empty)'
    if (depth > 3) return `[${value.length} items]`
    const first = shape(value[0], key, depth + 1)
    const rest = value.length > 1 ? ` ... +${value.length - 1} more` : ''
    return `[${value.length}] ${JSON.stringify(first)}${rest}`
  }
  if (typeof value === 'object') {
    if (depth > 4) return '{...deep}'
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = shape(v, k, depth + 1)
    return out
  }
  if (typeof value === 'string') return redactString(key, value)
  if (typeof value === 'number') {
    // Timestamps: seconds or milliseconds epoch -> readable date.
    if (value > 1e9 && value < 2e10) return `${value} (${new Date(value * 1000).toISOString()} sec)`
    if (value > 1e12 && value < 2e13) return `${value} (${new Date(value).toISOString()} ms)`
    return value
  }
  return typeof value
}

function candidates(home = homedir(), plat = platform()) {
  if (plat === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')]
  }
  if (plat === 'win32') {
    return [
      join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
      join(home, 'AppData', 'Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    ]
  }
  if (plat === 'linux') {
    return [join(home, '.config', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')]
  }
  return []
}

async function exists(path) {
  try {
    const s = await stat(path)
    return s.isFile()
  } catch {
    return false
  }
}

async function probe(path) {
  if (!(await exists(path))) {
    process.stdout.write(`  MISSING  ${path}\n`)
    return
  }
  const text = await readFile(path, 'utf8')
  process.stdout.write(`  FOUND    ${path}  (${text.length} bytes)\n`)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    process.stdout.write(`           not JSON: ${String(error).slice(0, 120)}\n`)
    return
  }
  process.stdout.write(`           shape: ${JSON.stringify(shape(parsed), null, 2).split('\n').join('\n           ')}\n`)
}

async function listDir(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    process.stdout.write(`  dir ${path}:\n`)
    for (const entry of entries) {
      process.stdout.write(`    - ${entry.isDirectory() ? 'd' : 'f'} ${entry.name}\n`)
    }
  } catch {
    process.stdout.write(`  dir ${path}: (absent)\n`)
  }
}

async function main() {
  process.stdout.write('== WorkBuddy desktop auth candidates ==\n')
  for (const candidate of candidates()) await probe(candidate)

  process.stdout.write('\n== sibling files in the auth directory ==\n')
  const home = homedir()
  if (platform() === 'darwin') {
    await listDir(join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
    await listDir(join(home, 'Library', 'Application Support', 'CodeBuddyExtension'))
  }

  process.stdout.write('\n== DSH home credential copy ==\n')
  const dshHome = process.env.DSH_HOME ?? join(home, '.dsh')
  await probe(join(dshHome, '.workbuddy-auth.json'))
  await listDir(dshHome)
}

await main()
