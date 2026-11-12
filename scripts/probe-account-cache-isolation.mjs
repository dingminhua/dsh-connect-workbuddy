#!/usr/bin/env node
/**
 * Cross-account prompt-cache isolation, measured rather than argued.
 *
 * QUESTION: if this plugin switches accounts (account-pool rotation, or the user
 * picking another row), does the next request pay a full COLD prefix?
 *
 * Method: pick two accounts that can actually complete a request, warm a prefix
 * on A, then send the SAME bytes to B and back to A. If cache is per-account, B's
 * first request is cold. If it is shared, B hits.
 *
 * Two things this script learned the hard way and now does on purpose:
 *
 * 1. FRESH RANDOM CONTENT EVERY ROUND. The upstream cache outlives the process
 *    and is keyed on content, so a fixed filler can arrive already warm from an
 *    earlier run — the first version of this script reported "cache is shared"
 *    for exactly that reason. Random bytes make "B's first request" mean it.
 *
 * 2. THE FIRST REPEAT IS NOT THE BASELINE. Measured on the CN gateway with a
 *    brand-new random prefix: request 2 (byte-identical to 1) still reported
 *    `cached_tokens: 0`, while request 4 reported 4096. The cache write lands
 *    asynchronously, so a turn-2-only baseline reads as "no cache at all". Each
 *    round therefore repeats on A until it hits (bounded), and only then asks B.
 *
 * STRICTLY READ-ONLY on account state; spends a few credits (short completions
 * over an ~8 k-token prompt). Token material is never printed, and account
 * identity is masked to its last four digits.
 *
 * Usage:
 *   node scripts/probe-account-cache-isolation.mjs
 *   node scripts/probe-account-cache-isolation.mjs --model glm-5.2 --rounds 3
 */

import { randomBytes } from 'node:crypto'

import { WorkBuddyCredentialStore, WorkBuddyUpstreamClient, prepareChatBody } from '../lib/index.js'

const argv = process.argv.slice(2)
const value = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 || index + 1 >= argv.length ? fallback : argv[index + 1]
}

const MODEL = value('--model', 'deepseek-v4.1-flash')
const ROUNDS = Number.parseInt(value('--rounds', '2'), 10)
const MAX_TOKENS = Number.parseInt(value('--max-tokens', '16'), 10)
const WARM_ATTEMPTS = Number.parseInt(value('--warm-attempts', '4'), 10)

/** Same-sized ~8 k-token body, different bytes on every call. */
const randomBody = () => Array.from({ length: 700 }, () => randomBytes(4).toString('hex')).join(' ')

const SUFFIX = '\n\nReply with exactly: OK'

/** `uin 100000000001` -> `…0001`: enough to tell accounts apart, useless as an id. */
const maskUin = uin => typeof uin !== 'string' || uin.length < 6 ? '(masked)' : `…${uin.slice(-4)}`

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
        // keepalive / comment lines
      }
    }
  }
  return payloads
}

/**
 * The LAST usage object carrying `prompt_tokens`.
 *
 * Last, not first: a stream can carry intermediate usage, and an early frame
 * reported `cached_tokens: 0` where the terminal frame reported 8192. Reading
 * any but the last turns a real 97% hit into a false "no cache".
 */
function terminalUsage(payloads) {
  const seen = new Set()
  let best
  const visit = value => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return
    seen.add(value)
    if (!Array.isArray(value) && typeof value['prompt_tokens'] === 'number') best = value
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child)
  }
  for (const payload of payloads) visit(payload)
  return best
}

/** What pi-ai would report, using its exact spelling order. */
function simulatePiAi(usage) {
  const promptTokens = usage['prompt_tokens'] ?? 0
  const cacheRead = usage['prompt_tokens_details']?.['cached_tokens']
    ?? usage['prompt_cache_hit_tokens']
    ?? usage['cached_tokens']
    ?? 0
  return { promptTokens, cacheRead }
}

/** One real completion reduced to the two facts this script needs. */
async function live(client, credential, modelId, content) {
  const body = prepareChatBody(JSON.stringify({
    model: modelId,
    messages: [{ role: 'user', content }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: MAX_TOKENS,
  }))
  let result
  try {
    result = await client.chatStream(credential, body, AbortSignal.timeout(180_000))
  } catch (error) {
    return { kind: 'transport', detail: String(error).slice(0, 100) }
  }
  if (!result.ok) return { kind: result.kind, status: result.status, detail: result.message.slice(0, 90) }
  const usage = terminalUsage(decodeSse(await result.response.text()))
  if (usage === undefined) return { kind: 'no-usage' }
  return { kind: 'ok', ...simulatePiAi(usage) }
}

async function main() {
  const client = new WorkBuddyUpstreamClient()
  // No `region`: this store reads every signed-in account on the machine, which
  // is what a cross-account experiment needs. Nothing here changes the saved
  // selection, and no token is refreshed for its own sake.
  const store = new WorkBuddyCredentialStore({ refresh: c => client.refreshToken(c) })

  // A live catalog read proves only that the TOKEN is accepted. Measured while
  // building this script: two accounts that answered a catalog read with 200
  // then refused every completion with `11140 account_restricted`. So every
  // candidate is SCREENED with one tiny real completion first.
  const screen = []
  for (const choice of await store.accounts()) {
    const credential = await store.credentialFor(choice.id)
    if (credential === undefined) continue
    const models = await client.fetchModels(credential).catch(() => [])
    if (models.length === 0) continue
    screen.push({ credential, models })
  }

  process.stdout.write(`model     : ${MODEL}\n`)
  const capable = []
  for (const account of screen) {
    if (!account.models.some(model => model.id === MODEL)) continue
    const probe = await live(client, account.credential, MODEL, 'Reply with exactly: OK')
    if (probe.kind !== 'ok') {
      process.stdout.write(`skip uin ${maskUin(account.credential.uin)} (${account.credential.domain}):`
        + ` ${probe.kind} ${probe.detail ?? ''}\n`)
      continue
    }
    capable.push(account)
  }

  if (capable.length < 2) {
    process.stdout.write(`\nneed TWO accounts that can COMPLETE a request on ${MODEL};`
      + ` ${capable.length} of ${screen.length} signed-in accounts did.\n`)
    process.stdout.write('The question "does switching accounts cost a cold prefix" needs two usable'
      + ' accounts. Nothing was measured; re-run when a second account is neither rate-limited'
      + ' nor restricted.\n')
    process.exitCode = 1
    return
  }

  const [a, b] = capable
  process.stdout.write(`account A : uin ${maskUin(a.credential.uin)} / ${a.credential.domain}\n`)
  process.stdout.write(`account B : uin ${maskUin(b.credential.uin)} / ${b.credential.domain}\n`)
  process.stdout.write(`rounds    : ${ROUNDS} (fresh random prefix each round)\n\n`)

  const rounds = []
  for (let round = 1; round <= ROUNDS; round += 1) {
    const bodyText = randomBody()
    process.stdout.write(`--- round ${round} ---\n`)

    // Warm A until it hits: the write is asynchronous, so one repeat is not a
    // baseline (see the module comment).
    let baseline
    for (let attempt = 1; attempt <= WARM_ATTEMPTS; attempt += 1) {
      const result = await live(client, a.credential, MODEL, bodyText + SUFFIX)
      if (result.kind !== 'ok') {
        process.stdout.write(`  A attempt ${attempt}: FAILED ${result.kind} ${result.detail ?? ''}\n`)
        break
      }
      process.stdout.write(`  A attempt ${attempt}: prompt=${result.promptTokens} cached=${result.cacheRead}\n`)
      if (result.cacheRead > 0) {
        baseline = result
        break
      }
    }
    if (baseline === undefined) {
      process.stdout.write('  A never warmed; this round cannot say anything about switching\n\n')
      continue
    }

    const onB = await live(client, b.credential, MODEL, bodyText + SUFFIX)
    if (onB.kind !== 'ok') {
      process.stdout.write(`  B first : FAILED ${onB.kind} ${onB.detail ?? ''}\n\n`)
      continue
    }
    process.stdout.write(`  B first : prompt=${onB.promptTokens} cached=${onB.cacheRead}\n`)

    const backOnA = await live(client, a.credential, MODEL, bodyText + SUFFIX)
    if (backOnA.kind === 'ok') {
      process.stdout.write(`  A again : prompt=${backOnA.promptTokens} cached=${backOnA.cacheRead}\n`)
    } else {
      process.stdout.write(`  A again : FAILED ${backOnA.kind}\n`)
    }

    rounds.push({ baseline, onB, backOnA })
    process.stdout.write('\n')
  }

  // ---------- verdict ----------
  process.stdout.write('===== verdict =====\n')
  const usable = rounds.filter(round => round.onB.kind === 'ok')
  if (usable.length === 0) {
    process.stdout.write('no round produced both a warm A baseline and a B answer; nothing concluded\n')
    return
  }
  const bHits = usable.filter(round => round.onB.cacheRead > 0).length
  const aHits = usable.filter(round => round.backOnA.kind === 'ok' && round.backOnA.cacheRead > 0).length
  process.stdout.write(`B's first request hit on ${bHits}/${usable.length} rounds\n`)
  process.stdout.write(`A after B's traffic hit on ${aHits}/${usable.length} rounds\n\n`)

  if (bHits === usable.length) {
    process.stdout.write('=> Account B hit the prefix A had just warmed. For this pair and model the\n')
    process.stdout.write('   cache is NOT isolated per account; a switch cost nothing measurable here.\n')
    process.stdout.write('   This measures THIS pair, model and moment — it does not overturn the older\n')
    process.stdout.write('   per-account reading for other models (docs/CACHE-HIT-70-RESEARCH.md §3).\n')
    process.stdout.write('   Quote it as a pair-specific result, not as a general law.\n')
  } else if (bHits === 0) {
    process.stdout.write('=> Account B was COLD on every round while A was warm on the same bytes.\n')
    process.stdout.write('   Cache is PER-ACCOUNT here: a switch pays a full uncached prefix.\n')
  } else {
    process.stdout.write('=> Mixed: B hit on some rounds and not others. Not enough signal to call it\n')
    process.stdout.write('   per-account; re-run with more rounds before quoting a rate.\n')
  }
}

await main()
