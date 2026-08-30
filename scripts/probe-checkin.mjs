#!/usr/bin/env node
/**
 * READ-ONLY probe: does WorkBuddy expose a daily check-in API?
 *
 * Only GET/POST requests that never grant anything are issued. If a claim
 * endpoint is found, it is NOT called — this script stops at "the endpoint
 * answers a status request" so no credit is ever granted by probing.
 *
 * Strategy: ask the endpoints Trae uses (adapted to WorkBuddy hosts), plus a
 * few obvious daily-reward spellings, and print only status + a redacted body
 * excerpt. Never prints tokens.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AUTH = join(homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')

function regionOf(domain) {
  const lowered = (domain ?? '').trim().toLowerCase()
  return lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai') ? 'global' : 'cn'
}

const STATUS_PATHS = [
  '/trae/api/v2/ug/checkin_credits/status',
  '/api/v2/ug/checkin_credits/status',
  '/v2/ug/checkin_credits/status',
  '/v2/checkin_credits/status',
  '/console/checkin/status',
  '/console/ug/checkin_credits/status',
  '/v2/billing/checkin/status',
  '/v2/billing/meter/checkin-activity-status',
  '/billing/meter/checkin-activity-status',
  '/billing/meter/checkin-status',
]

function redact(value) {
  return String(value)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(?:accessToken|refreshToken|token)["']?\s*[:=]\s*["']?[A-Za-z0-9._-]+/giu, '$1=[redacted]')
}

async function probe(credential, base, path) {
  const url = `${base}${path}`
  for (const method of ['GET', 'POST']) {
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
          'Origin': base,
          'Referer': `${base}/`,
          ...credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
          ...credential.domain === '' ? {} : { 'X-Domain': credential.domain },
        },
        ...method === 'POST' ? { body: '{}' } : {},
        signal: AbortSignal.timeout(15_000),
      })
      const text = (await response.text()).slice(0, 300)
      process.stdout.write(`  ${method.padEnd(4)} ${path}\n`)
      process.stdout.write(`       HTTP ${response.status}  ${redact(text).replace(/\s+/gu, ' ')}\n`)
    } catch (error) {
      process.stdout.write(`  ${method.padEnd(4)} ${path}\n       transport error: ${redact(error instanceof Error ? error.message : String(error))}\n`)
    }
  }
}

async function main() {
  const doc = JSON.parse(await readFile(AUTH, 'utf8'))
  const { auth, account = {} } = doc
  const credential = {
    accessToken: auth.accessToken,
    uid: account.uid ?? '',
    domain: auth.domain ?? '',
  }
  const region = regionOf(credential.domain)
  const bases = region === 'global'
    ? ['https://www.workbuddy.ai']
    : ['https://www.codebuddy.cn', 'https://copilot.tencent.com']

  process.stdout.write(`region=${region} uid=${credential.uid === '' ? '(none)' : credential.uid}\n`)
  for (const base of bases) {
    process.stdout.write(`\n===== ${base} =====\n`)
    for (const path of STATUS_PATHS) await probe(credential, base, path)
  }
  process.stdout.write('\nNOTE: no /claim endpoint was called; this probe grants nothing.\n')
}

await main()
