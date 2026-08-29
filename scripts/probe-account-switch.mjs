#!/usr/bin/env node
/**
 * Can WorkBuddy genuinely support MULTI-ACCOUNT switching?
 *
 * Takes every auth file in the WorkBuddy auth directory, groups them by uin
 * (distinct account), and for each distinct account asks the upstream:
 *   - is the access token still accepted (model catalog returns 200/code 0)?
 *   - how many cli models does that account see?
 *   - what is that account's remaining credit?
 *
 * STRICTLY READ-ONLY: no token refresh, no writes, no chat completion.
 * Token material is never printed.
 */

import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AUTH_DIR = join(homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')

function regionOf(domain) {
  const lowered = (domain ?? '').trim().toLowerCase()
  return lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai') ? 'global' : 'cn'
}

const pad = n => String(n).padStart(2, '0')
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

async function loadFiles() {
  const entries = await readdir(AUTH_DIR)
  const ordered = [
    ...entries.filter(n => n === 'workbuddy-desktop.info'),
    ...entries.filter(n => n !== 'workbuddy-desktop.info').sort().reverse(),
  ]
  const out = []
  for (const name of ordered) {
    try {
      const doc = JSON.parse(await readFile(join(AUTH_DIR, name), 'utf8'))
      if (typeof doc.auth?.accessToken !== 'string' || doc.auth.accessToken === '') continue
      out.push({ name, doc })
    } catch {
      // unparsable backup: skip
    }
  }
  return out
}

async function probeAccount({ name, doc }) {
  const { auth, account = {} } = doc
  const domain = auth.domain ?? ''
  const region = regionOf(domain)
  const chatBase = region === 'global' ? 'https://www.workbuddy.ai' : 'https://copilot.tencent.com'
  const billingBase = region === 'global' ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn'
  const headers = {
    'Authorization': `Bearer ${auth.accessToken}`,
    'Accept': 'application/json',
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': billingBase,
    'Referer': `${billingBase}/`,
    ...account.uid === '' ? {} : { 'X-User-Id': account.uid },
    ...domain === '' ? {} : { 'X-Domain': domain },
  }

  const result = { file: name, uin: account.uin ?? '(none)', nickname: account.nickname ?? '(none)', domain: domain || '(empty)', expiresAt: auth.expiresAt }

  // 1. model catalog
  try {
    const response = await fetch(`${chatBase}/console/enterprises/personal/models`, { headers, signal: AbortSignal.timeout(30_000) })
    const body = await response.json()
    result.catalogHttp = response.status
    result.catalogCode = body.code
    const data = body.data ?? {}
    const agents = Array.isArray(data.agents) ? data.agents : []
    const cli = agents.find(a => a?.name === 'cli')
    result.cliModels = Array.isArray(cli?.models) ? cli.models.length : 0
    result.totalModels = Array.isArray(data.models) ? data.models.length : 0
  } catch (error) {
    result.catalogHttp = `error: ${String(error).slice(0, 60)}`
  }

  // 2. credits (read-only)
  try {
    const now = new Date()
    const response = await fetch(`${billingBase}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3],
        PackageEndTimeRangeBegin: fmt(now),
        PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const body = await response.json()
    result.creditsHttp = response.status
    result.creditsCode = body.code
    const inner = body.data?.Response?.Data ?? {}
    const accounts = Array.isArray(inner.Accounts) ? inner.Accounts : []
    let total = 0
    for (const a of accounts) {
      const size = a.CycleCapacitySize ?? a.CapacitySize ?? 0
      const cycleRemain = a.CycleCapacityRemain ?? 0
      const cycleUsed = a.CycleCapacityUsed ?? 0
      const capacityRemain = a.CapacityRemain ?? 0
      const remain = size > 0 ? cycleRemain : (cycleRemain > 0 || cycleUsed > 0 ? cycleRemain : capacityRemain)
      total += Math.max(0, remain)
    }
    result.creditTotal = Math.round(total)
    result.packages = accounts.length
  } catch (error) {
    result.creditsHttp = `error: ${String(error).slice(0, 60)}`
  }
  return result
}

async function main() {
  const files = await loadFiles()
  process.stdout.write(`${files.length} parsable auth file(s)\n\n`)

  // Group by uin: one probe per distinct account, preferring the newest file.
  const byUin = new Map()
  for (const file of files) {
    const uin = file.doc.account?.uin ?? '(none)'
    if (!byUin.has(uin)) byUin.set(uin, file)
  }

  process.stdout.write(`distinct accounts (by uin): ${byUin.size}\n`)
  for (const [uin, file] of byUin) {
    process.stdout.write(`  uin ${uin}: ${file.doc.account?.nickname ?? '(none)'}  <- ${file.name}\n`)
  }
  process.stdout.write('\n')

  for (const [uin, file] of byUin) {
    const result = await probeAccount(file)
    process.stdout.write(`===== uin ${uin} (${result.nickname}) =====\n`)
    process.stdout.write(`  source file : ${result.file}\n`)
    process.stdout.write(`  domain      : ${result.domain}\n`)
    process.stdout.write(`  token expiry: ${typeof result.expiresAt === 'number' ? new Date(result.expiresAt).toISOString() : '(none)'}\n`)
    process.stdout.write(`  catalog     : HTTP ${result.catalogHttp} code=${result.catalogCode}`
      + ` models=${result.totalModels ?? '?'} cliModels=${result.cliModels ?? '?'}\n`)
    process.stdout.write(`  credits     : HTTP ${result.creditsHttp} code=${result.creditsCode}`
      + ` total=${result.creditTotal ?? '?'} packages=${result.packages ?? '?'}\n\n`)
  }
}

await main()
