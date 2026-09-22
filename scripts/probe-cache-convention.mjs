#!/usr/bin/env node
/**
 * Probe whether the WorkBuddy upstream actually reports prompt cache usage,
 * and — if it does — whether it uses a field spelling DSH can read.
 *
 * Background: dsh-connect-trae issue #10 ("一直0缓存") turned out to be the
 * PLUGIN dropping the upstream's cache fields while re-encoding the stream.
 * dsh-connect-workbuddy has no re-encoding layer — `shim.ts` pipes the
 * upstream's SSE bytes through untouched (`body.pipe(res)`) — so it cannot
 * commit that bug. But it can still display 0 forever, for a different reason:
 *
 *   pi-ai's `parseChunkUsage` only recognises three cache-read spellings —
 *     - usage.prompt_tokens_details.cached_tokens   (OpenAI)
 *     - usage.prompt_cache_hit_tokens               (DeepSeek)
 *     - usage.cached_tokens                         (Kimi)
 *   and one cache-write spelling —
 *     - usage.prompt_tokens_details.cache_write_tokens
 *
 * and `dsh-llm-pi-ai` then forwards cache fields only when non-zero. A native
 * spelling like Trae's `cache_read_input_tokens` is invisible to DSH even
 * though the bytes reach it perfectly intact. This probe answers which case
 * WorkBuddy is in.
 *
 * Method (mirrors trae's probe): turn 1 sends PREFIX only, warming the prefix
 * server-side; turns 2..N send the byte-identical PREFIX+SUFFIX. Prefix
 * caching only pays off on a byte-identical prefix, and the first request of a
 * fresh prefix is always cold — so the signal is "prompt_tokens stays constant
 * while cache_read climbs across turns 2..N", never "some single turn is
 * non-zero".
 *
 * READ-ONLY w.r.t. account state, but it DOES spend a few credits: N short
 * completions over a long prompt. Message text and token material are never
 * printed — only usage counters and field names.
 *
 * Usage:
 *   node scripts/probe-cache-convention.mjs
 *   node scripts/probe-cache-convention.mjs --model glm-5.2 --turns 4
 *   node scripts/probe-cache-convention.mjs --no-stream-options
 */

import { WorkBuddyCredentialStore, WorkBuddyUpstreamClient, prepareChatBody } from '../lib/index.js'

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const value = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 || index + 1 >= argv.length ? fallback : argv[index + 1]
}

const MODEL_OVERRIDE = value('--model', undefined)
const TURNS = Number.parseInt(value('--turns', '3'), 10)
const USE_STREAM_OPTIONS = !flag('--no-stream-options')
const REGION = value('--region', undefined)
const MAX_TOKENS = Number.parseInt(value('--max-tokens', '16'), 10)

/**
 * Deterministic filler. The prefix must be BYTE-IDENTICAL across turns for
 * prefix caching to hit, so it is built from a fixed string — never from
 * timestamps, randomness, or anything environment-dependent.
 */
const FILLER = 'The quick brown fox jumps over the lazy dog. Prometheus bound the cache key to the prefix. '
const PREFIX_REPEATS = 420
const SUFFIX = 'Reply with exactly: OK'

/** Split an SSE body into decoded `data:` payloads. */
function decodeSse(text) {
  const payloads = []
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (raw === '' || raw === '[DONE]') continue
      try {
        payloads.push(JSON.parse(raw))
      } catch {
        // Non-JSON keepalive/comment lines are never usage events.
      }
    }
  }
  return payloads
}

/**
 * Collect every usage-looking object in one decoded payload.
 *
 * Deliberately generic: rather than assume OpenAI's shape, walk the object and
 * pick up any nested object carrying numeric token/cache fields, so a
 * provider-native spelling cannot slip past unnoticed.
 */
function collectUsage(payload) {
  const found = []
  const seen = new Set()
  const visit = (value, path) => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    const numeric = Object.entries(value)
      .filter(([k, v]) => /token|cache/i.test(k) && typeof v === 'number')
      .map(([k]) => k)
    if (numeric.length > 0) found.push({ path: path === '' ? 'usage' : path, object: value })
    for (const [k, v] of Object.entries(value)) visit(v, path === '' ? k : `${path}.${k}`)
  }
  visit(payload, '')
  return found
}

/** The only cache spellings pi-ai's parseChunkUsage reads. */
const RECOGNISED_READ = [
  'prompt_tokens_details.cached_tokens',
  'prompt_cache_hit_tokens',
  'cached_tokens',
]
const RECOGNISED_WRITE = ['prompt_tokens_details.cache_write_tokens']

function dig(object, dotted) {
  return dotted.split('.').reduce(
    (acc, key) => (typeof acc === 'object' && acc !== null ? acc[key] : undefined),
    object,
  )
}

/** What pi-ai would compute from this usage object, using its exact rules. */
function simulatePiAi(usage) {
  const promptTokens = usage['prompt_tokens'] ?? 0
  const cacheRead = usage['prompt_tokens_details']?.['cached_tokens']
    ?? usage['prompt_cache_hit_tokens']
    ?? usage['cached_tokens']
    ?? 0
  const cacheWrite = usage['prompt_tokens_details']?.['cache_write_tokens'] ?? 0
  const output = usage['completion_tokens'] ?? 0
  const input = Math.max(0, promptTokens - cacheRead - cacheWrite)
  return { input, output, cacheRead, cacheWrite, promptTokens, totalTokens: input + output + cacheRead + cacheWrite }
}

async function main() {
  const client = new WorkBuddyUpstreamClient()
  const store = new WorkBuddyCredentialStore({
    refresh: c => client.refreshToken(c),
    ...REGION === undefined ? {} : { region: REGION },
  })

  let credential
  try {
    credential = await store.resolve()
  } catch (error) {
    process.stdout.write(`no signed-in credential: ${String(error)}\n`)
    process.stdout.write('Sign in to the WorkBuddy desktop app first, or run `dsh-connect-workbuddy doctor`.\n')
    process.exitCode = 1
    return
  }

  process.stdout.write(`account : ${credential.nickname ?? '(none)'} / uin ${credential.uin ?? '(none)'}\n`)
  process.stdout.write(`domain  : ${credential.domain || '(empty)'}\n`)
  process.stdout.write(`source  : ${credential.source}\n`)
  process.stdout.write(`stream_options: ${USE_STREAM_OPTIONS ? 'include_usage:true' : '(omitted)'}\n`)
  process.stdout.write(`turns   : ${TURNS}\n\n`)

  const models = await client.fetchModels(credential)
  const modelId = MODEL_OVERRIDE ?? models[0]?.id
  if (modelId === undefined) {
    process.stdout.write('model catalog is empty; cannot probe\n')
    process.exitCode = 1
    return
  }
  const rate = models.find(m => m.id === modelId)?.creditMultiplier
  process.stdout.write(`model   : ${modelId}  rate=${rate === undefined ? '(unknown)' : `x${rate.toFixed(2)}`}\n`)

  const prefix = FILLER.repeat(PREFIX_REPEATS)
  const probePrompt = `${prefix}\n\n${SUFFIX}`
  process.stdout.write(`prompt  : prefix ${prefix.length} chars (~${Math.round(prefix.length / 3.6)} est. tokens), identical every turn\n`)
  process.stdout.write('          turn 1 = PREFIX only (warms cache); turn 2..N = PREFIX + SUFFIX, byte-identical\n\n')

  const turns = []

  for (let turn = 1; turn <= TURNS; turn += 1) {
    const warming = turn === 1
    const content = warming ? prefix : probePrompt
    const body = prepareChatBody(JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content }],
      stream: true,
      ...USE_STREAM_OPTIONS ? { stream_options: { include_usage: true } } : {},
      max_tokens: MAX_TOKENS,
    }))

    let result
    try {
      result = await client.chatStream(credential, body, AbortSignal.timeout(180_000))
    } catch (error) {
      process.stdout.write(`turn ${turn}: transport error: ${String(error)}\n`)
      return
    }

    const label = warming ? 'PREFIX only (warms cache)' : `PREFIX + SUFFIX (identical #${turn})`
    process.stdout.write(`=== turn ${turn}: ${label} ===\n`)

    if (!result.ok) {
      process.stdout.write(`  FAILED kind=${result.kind} status=${result.status}\n`)
      process.stdout.write(`  ${result.message.slice(0, 300)}\n`)
      if (USE_STREAM_OPTIONS && (result.status === 400 || result.status === 0)) {
        process.stdout.write('\n  Hint: retry with --no-stream-options to check whether\n')
        process.stdout.write('  `stream_options` is what the upstream rejected.\n')
      }
      return
    }

    const text = await result.response.text()
    const usageHits = decodeSse(text).flatMap(collectUsage)
    process.stdout.write(`  usage objects: ${usageHits.length}\n`)

    if (usageHits.length === 0) {
      process.stdout.write('  no token/cache counters anywhere in the stream\n')
      process.stdout.write(`  raw tail: ${JSON.stringify(text.slice(-200))}\n\n`)
      turns.push({ turn, warming, usage: undefined })
      continue
    }

    // The terminal usage object is the one carrying completion_tokens.
    const terminal = usageHits.find(hit => typeof hit.object['completion_tokens'] === 'number')
      ?? usageHits[usageHits.length - 1]
    const simulated = simulatePiAi(terminal.object)

    process.stdout.write(`  at  : ${terminal.path}\n`)
    process.stdout.write(`  raw : ${JSON.stringify(terminal.object)}\n`)
    process.stdout.write(`  pi-ai would report: input=${simulated.input} cacheRead=${simulated.cacheRead}`
      + ` cacheWrite=${simulated.cacheWrite} output=${simulated.output} total=${simulated.totalTokens}\n\n`)

    turns.push({ turn, warming, usage: terminal.object, simulated })
  }

  // ---------- verdict ----------
  process.stdout.write('===== verdict =====\n')
  const withUsage = turns.filter(t => t.usage !== undefined)
  if (withUsage.length === 0) {
    process.stdout.write('The upstream returned no usage counters at all.\n')
    process.stdout.write('Caching cannot be displayed because nothing is reported — a different\n')
    process.stdout.write('situation from trae #10, where counters existed and were dropped.\n')
    return
  }

  const first = withUsage[0]
  const allKeys = new Set()
  for (const t of withUsage) for (const key of Object.keys(t.usage)) allKeys.add(key)
  const details = typeof first.usage['prompt_tokens_details'] === 'object' && first.usage['prompt_tokens_details'] !== null
    ? Object.keys(first.usage['prompt_tokens_details'])
    : []
  const cacheKeys = [...allKeys].filter(k => /cache/i.test(k))

  process.stdout.write(`usage keys seen      : ${[...allKeys].sort().join(', ')}\n`)
  process.stdout.write(`cache-related keys   : ${cacheKeys.length === 0 ? '(none)' : cacheKeys.join(', ')}\n`)
  if (details.length > 0) process.stdout.write(`prompt_tokens_details: ${details.join(', ')}\n`)

  const recognisedRead = RECOGNISED_READ.find(name => dig(first.usage, name) !== undefined)
  const recognisedWrite = RECOGNISED_WRITE.find(name => dig(first.usage, name) !== undefined)
  process.stdout.write(`pi-ai-recognised read : ${recognisedRead ?? '(NONE — DSH displays 0)'}\n`)
  process.stdout.write(`pi-ai-recognised write: ${recognisedWrite ?? '(none)'}\n`)

  const nonZero = withUsage.filter(t => t.simulated.cacheRead > 0 || t.simulated.cacheWrite > 0)
  process.stdout.write(`turns with non-zero cache: ${nonZero.length}/${withUsage.length}\n`)

  process.stdout.write('\n')
  if (cacheKeys.length === 0) {
    process.stdout.write('=> Upstream reports NO cache fields. Nothing for DSH to show; this is not\n')
    process.stdout.write('   the trae #10 failure mode (there, the fields existed and were dropped).\n')
  } else if (recognisedRead === undefined) {
    process.stdout.write('=> Upstream reports cache fields, but NOT in a spelling pi-ai reads.\n')
    process.stdout.write('   The bytes reach DSH intact yet cacheRead stays 0 — the trae #10 symptom\n')
    process.stdout.write('   arriving by a different route. Fixing it requires a translation layer,\n')
    process.stdout.write('   which the shim does not have today (it pipes bytes through untouched).\n')
  } else {
    process.stdout.write(`=> Upstream uses a pi-ai-recognised spelling (${recognisedRead}).\n`)
    process.stdout.write('   DSH can display cache as-is; no translation layer needed.\n')
  }

  // Convention check: does prompt_tokens INCLUDE the cached tokens?
  // Only comparable across turns that sent byte-identical prompts (turn 2..N).
  const comparable = withUsage.filter(t => !t.warming)
  process.stdout.write('\nconvention check (OpenAI vs Anthropic accounting), identical prompts only:\n')
  if (comparable.length < 2) {
    process.stdout.write('  need at least 2 identical-prompt turns; re-run with --turns 3 or more\n')
    return
  }
  const prompts = comparable.map(t => t.simulated.promptTokens)
  const reads = comparable.map(t => t.simulated.cacheRead)
  process.stdout.write(`  prompt_tokens: ${prompts.join(' -> ')} (${new Set(prompts).size === 1 ? 'constant' : 'VARIES'})\n`)
  process.stdout.write(`  cacheRead    : ${reads.join(' -> ')}\n`)

  /**
   * Decisive check, independent of whether reads happen to climb.
   *
   * WorkBuddy reports `prompt_cache_hit_tokens` + `prompt_cache_miss_tokens`
   * alongside `prompt_tokens`. If their sum equals prompt_tokens, cached
   * tokens are a SUBSET of prompt_tokens (OpenAI convention) and pi-ai's
   * `input = prompt - cacheRead - cacheWrite` is a correct partition. If
   * prompt_tokens instead equals the miss count alone, cached tokens sit
   * OUTSIDE it (Anthropic convention) and subtracting would double-count.
   */
  const partitioned = comparable.every(t => {
    const hit = t.usage['prompt_cache_hit_tokens']
    const miss = t.usage['prompt_cache_miss_tokens']
    if (typeof hit !== 'number' || typeof miss !== 'number') return false
    return hit + miss === t.simulated.promptTokens
  })
  const hasHitMiss = typeof first.usage['prompt_cache_hit_tokens'] === 'number'
    && typeof first.usage['prompt_cache_miss_tokens'] === 'number'
  if (hasHitMiss) {
    process.stdout.write(`  hit + miss   : ${comparable.map(t => `${t.usage['prompt_cache_hit_tokens']}+${t.usage['prompt_cache_miss_tokens']}=${t.usage['prompt_cache_hit_tokens'] + t.usage['prompt_cache_miss_tokens']}`).join(', ')}`
      + ` vs prompt ${[...new Set(prompts)].join('/')}\n`)
    process.stdout.write(`  ${partitioned ? 'MATCHES' : 'DOES NOT match'} prompt_tokens\n`)
  }

  const constantPrompt = new Set(prompts).size === 1
  const climbing = reads[reads.length - 1] > reads[0]
  const hitCache = reads.some(r => r > 0)

  if (partitioned || (constantPrompt && climbing)) {
    process.stdout.write('  => OpenAI convention: prompt_tokens INCLUDES cached tokens, so pi-ai\'s\n')
    process.stdout.write('     `input = prompt - cacheRead - cacheWrite` is arithmetically correct.\n')
  } else if (!constantPrompt && climbing) {
    process.stdout.write('  => Anthropic convention suspected: prompt_tokens EXCLUDES cached tokens,\n')
    process.stdout.write('     so pi-ai\'s subtraction would DOUBLE-COUNT the deduction.\n')
    process.stdout.write('     Cache display would need a translation layer that also rescales input.\n')
  } else if (!hitCache) {
    process.stdout.write('  => No cache hits observed. A fresh prefix is always cold, and the cache\n')
    process.stdout.write('     survives across processes/sessions — re-run now that the prefix is warm.\n')
  } else {
    process.stdout.write('  => Inconclusive; re-run with --turns 4.\n')
  }
}

await main()
