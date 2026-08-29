#!/usr/bin/env node
/**
 * End-to-end acceptance against the real WorkBuddy upstream, using the
 * built bundle (lib/index.js) rather than re-implementing the protocol.
 *
 * Read-only: model catalog + credit balance + one tiny chat completion.
 * Token material is never printed.
 */

import { WorkBuddyCredentialStore, WorkBuddyUpstreamClient } from '../lib/index.js'

function redact(value) {
  if (typeof value !== 'string') return value
  if (/^[\w-]{40,}$/.test(value)) return `<redacted len=${value.length}>`
  return value
}

async function main() {
  const client = new WorkBuddyUpstreamClient()
  const store = new WorkBuddyCredentialStore({ refresh: c => client.refreshToken(c) })

  console.log('=== 1. 多账号发现 ===')
  const accounts = await store.accounts()
  console.log(`发现 ${accounts.length} 个账号`)
  for (const a of accounts) {
    console.log(`  - ${a.accountName}  uin=${a.uin}  domain=${a.domain || '(空)'}  selected=${a.selected}`)
  }
  if (accounts.length === 0) {
    console.log('未发现凭据，终止')
    process.exitCode = 1
    return
  }

  console.log('\n=== 2. 默认选中的凭据 ===')
  const credential = await store.resolve()
  console.log(`  account: ${credential.nickname}  domain: ${credential.domain}`)
  console.log(`  source:  ${credential.source}  expires: ${new Date(credential.expiresAtMs).toISOString()}`)
  console.log(`  file:    ${credential.filePath}`)

  console.log('\n=== 3. 模型目录（含上游能力字段）===')
  const models = await client.fetchModels(credential)
  console.log(`  ${models.length} 个模型`)
  for (const m of models) {
    const rate = m.creditMultiplier === undefined ? '-' : `${m.creditMultiplier}x`
    const efforts = m.reasoning?.supportedEfforts?.join('/') ?? '-'
    console.log(`  ${m.id.padEnd(20)} ${m.name.padEnd(22)} in=${String(m.contextWindow).padEnd(9)} out=${String(m.maxTokens).padEnd(7)} rate=${rate.padEnd(6)} img=${String(m.multimodal ?? '-').padEnd(5)} efforts=${efforts}`)
  }

  console.log('\n=== 4. 积分（按套餐聚合）===')
  const credits = await client.fetchCredits(credential)
  console.log(`  合计: ${credits.total}`)
  for (const a of credits.accounts) {
    console.log(`  ${a.packageName.padEnd(30)} remain=${String(a.remain).padEnd(8)} size=${String(a.size).padEnd(8)} count=${a.count}`)
  }

  console.log('\n=== 5. 一次最小 chat 请求（SSE）===')
  const body = JSON.stringify({
    model: models[0].id,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    stream: true,
  })
  const result = await client.chatStream(credential, body, AbortSignal.timeout(60_000))
  if (!result.ok) {
    console.log(`  失败: kind=${result.kind} status=${result.status} msg=${result.message.slice(0, 200)}`)
    process.exitCode = 1
    return
  }
  const text = await result.response.text()
  const chunks = text.split('\n').filter(Boolean).slice(0, 6)
  console.log(`  HTTP 200, ${text.length} 字节, 前 ${chunks.length} 个事件:`)
  for (const chunk of chunks) console.log(`    ${chunk.slice(0, 120)}`)
  if (/Reply with exactly/.test(text) === false && text.includes('data:')) {
    console.log('  （SSE 事件已返回，内容未逐字打印以避免输出模型文本）')
  }
}

await main()
