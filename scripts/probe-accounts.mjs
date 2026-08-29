#!/usr/bin/env node
/**
 * Do WorkBuddy's auth files ever carry MORE THAN ONE account?
 *
 * Answers the multi-account question empirically:
 *   - the live file's `accounts` / `allAccounts` arrays
 *   - every historical `workbuddy-desktop.<stamp>.info` backup in the same dir
 *
 * Structure only: token material is never printed, only lengths.
 */

import { readFile, readdir } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

const AUTH_DIR = join(homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')

/** Describe one account entry without leaking secrets. */
function describeAccount(value) {
  if (typeof value !== 'object' || value === null) return `(not an object: ${typeof value})`
  const a = value
  return {
    uid: typeof a.uid === 'string' ? `${a.uid.slice(0, 8)}… (len ${a.uid.length})` : typeof a.uid,
    uin: a.uin ?? '(none)',
    nickname: a.nickname ?? '(none)',
    type: a.type ?? '(none)',
    domain: a.sso?.domain === '' ? '(empty sso.domain)' : (a.sso?.domain ?? '(no sso)'),
    accountType: a.accountType ?? '(none)',
    lastLogin: typeof a.lastLogin,
    keys: Object.keys(a).join(','),
  }
}

function hasToken(value) {
  return typeof value === 'object' && value !== null && typeof value.accessToken === 'string' && value.accessToken.length > 0
}

async function inspect(file) {
  let text
  try {
    text = await readFile(join(AUTH_DIR, file), 'utf8')
  } catch (error) {
    process.stdout.write(`\n--- ${file}: unreadable (${String(error).slice(0, 60)})\n`)
    return
  }
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    process.stdout.write(`\n--- ${file}: not JSON\n`)
    return
  }
  const topKeys = Object.keys(doc).join(',')
  const accounts = Array.isArray(doc.accounts) ? doc.accounts : undefined
  const allAccounts = Array.isArray(doc.allAccounts) ? doc.allAccounts : undefined
  const current = doc.account
  const auth = doc.auth

  process.stdout.write(`\n--- ${file}\n`)
  process.stdout.write(`    top-level keys : ${topKeys}\n`)
  process.stdout.write(`    accounts[]     : ${accounts === undefined ? 'ABSENT' : `${accounts.length} entry(ies)`}\n`)
  process.stdout.write(`    allAccounts[]  : ${allAccounts === undefined ? 'ABSENT' : `${allAccounts.length} entry(ies)`}\n`)
  process.stdout.write(`    current account: ${current === undefined ? 'ABSENT' : JSON.stringify(describeAccount(current))}\n`)
  process.stdout.write(`    auth has token : ${hasToken(auth) ? `yes (len ${auth.accessToken.length})` : 'no'}\n`)
  process.stdout.write(`    auth.domain    : ${auth?.domain ?? '(none)'}\n`)
  process.stdout.write(`    auth.expiresAt : ${auth?.expiresAt ?? '(none)'}${typeof auth?.expiresAt === 'number' ? ` -> ${new Date(auth.expiresAt).toISOString()}` : ''}\n`)

  const perEntryTokens =
    accounts !== undefined
      ? accounts.filter(hasToken).length
      : 0
  process.stdout.write(`    entries w/ own accessToken: ${perEntryTokens}\n`)

  if (accounts !== undefined && accounts.length > 1) {
    process.stdout.write(`    *** MULTI-ACCOUNT FILE ***\n`)
    accounts.forEach((account, index) => {
      process.stdout.write(`      [${index}] ${JSON.stringify(describeAccount(account))}\n`)
    })
  }
  const distinctUins = new Set()
  for (const list of [accounts ?? [], allAccounts ?? []]) {
    for (const account of list) if (account?.uin !== undefined) distinctUins.add(String(account.uin))
  }
  if (current?.uin !== undefined) distinctUins.add(String(current.uin))
  process.stdout.write(`    distinct uins in this file: ${[...distinctUins].join(', ') || '(none)'}\n`)
}

async function main() {
  if (platform() !== 'darwin') {
    process.stdout.write(`This probe hardcodes the macOS path; platform=${platform()}\n`)
    return
  }
  let entries
  try {
    entries = await readdir(AUTH_DIR)
  } catch {
    process.stdout.write(`auth dir absent: ${AUTH_DIR}\n`)
    return
  }
  process.stdout.write(`Auth dir: ${AUTH_DIR}\n${entries.length} file(s)\n`)
  // Live file first, then backups newest-first.
  const ordered = [
    ...entries.filter(name => name === 'workbuddy-desktop.info'),
    ...entries.filter(name => name !== 'workbuddy-desktop.info').sort().reverse(),
  ]
  for (const file of ordered) await inspect(file)
}

await main()
