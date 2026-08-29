#!/usr/bin/env node
/**
 * Probe the WorkBuddy upstream model catalog (READ-ONLY, no credits consumed).
 *
 * Answers: what can the Trae-style model card actually show?
 *   - full field set per model (multimodal? reasoning? context? credit rate?)
 *   - the `agents` list (which agent owns which models)
 *   - which agent the original project hardcodes (`cli`) vs what else exists
 *   - the credit/billing document shape
 *
 * Token material is never printed.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AUTH = join(homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')

/** One shape sample per key, with long strings reduced to lengths. */
function shape(value, key = '', depth = 0) {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.slice(0, depth > 2 ? 1 : 3).map(item => shape(item, key, depth + 1))
    return `[${value.length}] ${JSON.stringify(items)}${value.length > 3 ? ' …' : ''}`
  }
  if (typeof value === 'object') {
    if (depth > 3) return '{…}'
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = shape(v, k, depth + 1)
    return out
  }
  if (typeof value === 'string') {
    if (/token|secret/i.test(key)) return `<redacted len=${value.length}>`
    if (value.length > 40) return `<str len=${value.length}>`
    return value
  }
  return value
}

function regionOf(domain) {
  const lowered = (domain ?? '').trim().toLowerCase()
  return lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai') ? 'global' : 'cn'
}

async function main() {
  const doc = JSON.parse(await readFile(AUTH, 'utf8'))
  const auth = doc.auth
  const account = doc.account ?? {}
  const domain = auth.domain ?? ''
  const region = regionOf(domain)
  const chatBase = region === 'global' ? 'https://www.workbuddy.ai' : 'https://copilot.tencent.com'
  const billingBase = region === 'global' ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn'

  process.stdout.write(`account : ${account.nickname ?? '(none)'} / uin ${account.uin ?? '(none)'}\n`)
  process.stdout.write(`domain  : ${domain || '(empty)'} -> region ${region}\n`)
  process.stdout.write(`chatBase: ${chatBase}\n`)
  process.stdout.write(`expires : ${new Date(auth.expiresAt).toISOString()}\n\n`)

  const common = {
    'Authorization': `Bearer ${auth.accessToken}`,
    'Accept': 'application/json',
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': billingBase,
    'Referer': `${billingBase}/`,
  }

  // ---- model catalog ----
  process.stdout.write('===== GET /console/enterprises/personal/models =====\n')
  let modelsResponse
  try {
    modelsResponse = await fetch(`${chatBase}/console/enterprises/personal/models`, {
      headers: { ...common, ...account.uid === '' ? {} : { 'X-User-Id': account.uid } },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    process.stdout.write(`transport error: ${String(error)}\n`)
    return
  }
  process.stdout.write(`HTTP ${modelsResponse.status}\n`)
  const modelsText = await modelsResponse.text()
  let modelsDoc
  try {
    modelsDoc = JSON.parse(modelsText)
  } catch {
    process.stdout.write(`non-JSON: ${modelsText.slice(0, 200)}\n`)
    return
  }
  process.stdout.write(`code=${modelsDoc.code} msg=${JSON.stringify(modelsDoc.msg)}\n\n`)

  const data = modelsDoc.data ?? {}
  const rawModels = Array.isArray(data.models) ? data.models : []
  const agents = Array.isArray(data.agents) ? data.agents : []

  process.stdout.write(`--- agents (${agents.length}) ---\n`)
  for (const agent of agents) {
    process.stdout.write(`  name=${JSON.stringify(agent?.name)} models=${Array.isArray(agent?.models) ? agent.models.length : '?'}`
      + `${Array.isArray(agent?.models) ? ` [${agent.models.slice(0, 12).join(', ')}${agent.models.length > 12 ? ' …' : ''}]` : ''}\n`)
  }

  process.stdout.write(`\n--- models (${rawModels.length}) ---\n`)
  process.stdout.write(`first model FULL shape:\n${JSON.stringify(shape(rawModels[0] ?? {}), null, 2)}\n\n`)
  const keyUnion = new Set()
  for (const model of rawModels) for (const k of Object.keys(model ?? {})) keyUnion.add(k)
  process.stdout.write(`union of model keys (${keyUnion.size}): ${[...keyUnion].sort().join(', ')}\n\n`)

  const cli = agents.find(a => a?.name === 'cli')
  const cliIds = new Set(Array.isArray(cli?.models) ? cli.models : [])
  process.stdout.write(`--- table (cli membership marked *) ---\n`)
  for (const model of rawModels) {
    if (typeof model !== 'object' || model === null) continue
    const id = String(model.id ?? '?')
    const mark = cliIds.has(id) ? '*' : ' '
    process.stdout.write(`  ${mark} ${id.padEnd(26)} name=${String(model.name ?? '?').padEnd(24)}`
      + ` in=${String(model.maxInputTokens ?? '?').padEnd(9)} out=${String(model.maxOutputTokens ?? '?').padEnd(8)}`
      + ` disabled=${String(model.disabled ?? false).padEnd(5)}`
      + ` multimodal=${String(model.multimodal ?? model.supportsVision ?? '?').padEnd(5)}`
      + ` reasoning=${String(model.reasoning ?? model.supportsReasoning ?? '?')}\n`)
  }
  process.stdout.write(`\n(*) cli-agent models: ${cliIds.size}\n`)

  // ---- credits ----
  process.stdout.write('\n===== POST /v2/billing/meter/get-user-resource =====\n')
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  try {
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
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: fmt(now),
        PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(30_000),
    })
    process.stdout.write(`HTTP ${creditsResponse.status}\n`)
    const creditsDoc = await creditsResponse.json()
    process.stdout.write(`code=${creditsDoc.code} msg=${JSON.stringify(creditsDoc.msg)}\n`)
    process.stdout.write(`shape: ${JSON.stringify(shape(creditsDoc), null, 2)}\n`)
  } catch (error) {
    process.stdout.write(`credits error: ${String(error)}\n`)
  }
}

await main()
