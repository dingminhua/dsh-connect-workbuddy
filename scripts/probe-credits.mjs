#!/usr/bin/env node
/**
 * Dump the per-model `credits` field and the billing Accounts detail —
 * READ-ONLY. Decides what the Trae-style card can show per model and per
 * credit package.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AUTH = join(homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')

function regionOf(domain) {
  const lowered = (domain ?? '').trim().toLowerCase()
  return lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai') ? 'global' : 'cn'
}

async function main() {
  const doc = JSON.parse(await readFile(AUTH, 'utf8'))
  const { auth, account = {} } = doc
  const domain = auth.domain ?? ''
  const region = regionOf(domain)
  const chatBase = region === 'global' ? 'https://www.workbuddy.ai' : 'https://copilot.tencent.com'
  const billingBase = region === 'global' ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn'
  const common = {
    'Authorization': `Bearer ${auth.accessToken}`,
    'Accept': 'application/json',
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': billingBase,
    'Referer': `${billingBase}/`,
  }

  const modelsResponse = await fetch(`${chatBase}/console/enterprises/personal/models`, {
    headers: { ...common, ...account.uid === '' ? {} : { 'X-User-Id': account.uid } },
    signal: AbortSignal.timeout(30_000),
  })
  const modelsDoc = await modelsResponse.json()
  const rawModels = modelsDoc.data?.models ?? []
  const agents = modelsDoc.data?.agents ?? []
  const cli = agents.find(a => a?.name === 'cli')
  const cliIds = new Set(Array.isArray(cli?.models) ? cli.models : [])

  process.stdout.write('===== per-model credits / capability fields (cli models) =====\n')
  for (const model of rawModels) {
    if (!cliIds.has(model?.id)) continue
    process.stdout.write(`\n${model.id}  (${model.name})\n`)
    process.stdout.write(`  credits      : ${JSON.stringify(model.credits)}\n`)
    process.stdout.write(`  reasoning    : ${JSON.stringify(model.reasoning)}\n`)
    process.stdout.write(`  images       : ${JSON.stringify(model.supportsImages)}   toolCall: ${JSON.stringify(model.supportsToolCall)}   onlyReasoning: ${JSON.stringify(model.onlyReasoning)}\n`)
    process.stdout.write(`  multimodalOff: ${JSON.stringify(model.disabledMultimodal)}\n`)
    process.stdout.write(`  descZh       : ${String(model.descriptionZh ?? '').slice(0, 60)}\n`)
  }

  process.stdout.write('\n\n===== billing Accounts detail =====\n')
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const creditsResponse = await fetch(`${billingBase}/v2/billing/meter/get-user-resource`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${auth.accessToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...account.uid === '' ? {} : { 'X-User-Id': account.uid },
      ...domain === '' ? {} : { 'X-Domain': domain },
    },
    body: JSON.stringify({
      PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3],
      PackageEndTimeRangeBegin: fmt(now),
      PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const creditsDoc = await creditsResponse.json()
  const inner = creditsDoc.data?.Response?.Data ?? {}
  const accounts = Array.isArray(inner.Accounts) ? inner.Accounts : []
  process.stdout.write(`TotalCount=${inner.TotalCount} TotalDosage=${inner.TotalDosage} returned=${accounts.length}\n`)
  process.stdout.write(`first account FULL shape:\n${JSON.stringify(accounts[0], null, 2)}\n\n`)
  const union = new Set()
  for (const a of accounts) for (const k of Object.keys(a)) union.add(k)
  process.stdout.write(`union of account keys: ${[...union].sort().join(', ')}\n\n`)

  process.stdout.write('non-zero-remaining packages:\n')
  for (const a of accounts) {
    const size = a.CycleCapacitySize ?? a.CapacitySize ?? 0
    const cycleRemain = a.CycleCapacityRemain ?? 0
    const cycleUsed = a.CycleCapacityUsed ?? 0
    const capacityRemain = a.CapacityRemain ?? 0
    const remain = size > 0 ? cycleRemain : (cycleRemain > 0 || cycleUsed > 0 ? cycleRemain : capacityRemain)
    if (remain <= 0) continue
    process.stdout.write(`  ${String(a.PackageName).padEnd(34)} remain=${String(remain).padEnd(8)} size=${String(size).padEnd(8)}`
      + ` cycleUsed=${String(cycleUsed).padEnd(8)} capRemain=${String(capacityRemain).padEnd(8)} end=${String(a.PackageEndTime ?? '?').slice(0, 19)}\n`)
  }
}

await main()
