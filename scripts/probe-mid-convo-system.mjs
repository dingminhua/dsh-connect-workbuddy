#!/usr/bin/env node
/**
 * Does the WorkBuddy gateway honour a system message that arrives AFTER the
 * history — and does keeping the original head keep the prefix cache warm?
 *
 * WHY THIS MATTERS. DSH can append a changed system prompt after the cached
 * history instead of rewriting the leading system node, but only when the
 * route declares `systemPromptUpdate: 'in-history'`. Declaring it is safe only
 * if the upstream reads the LATEST system message at any position as the
 * effective prompt; if it instead reads only the head, the model would keep
 * obeying the old prompt — worse than paying for a cache miss. This probe
 * answers both halves with counters and a one-word reply.
 *
 * Method — four requests, one account, a padded (~3k token) head so the
 * provider's prefix cache is above its granularity:
 *
 *   A  system(S1)                     + history + ask   establish the prefix
 *   B  system(S1)                     + history + ask   append-only   -> warm
 *   C  system(S1) + history + system(S2) + ask          the actual question
 *   D  system(S1)                     + history + ask   C's own repeat
 *
 * S1 and S2 differ in ONE word (the secret word). Reading C's answer says
 * which prompt the model obeyed; reading C's cache counters says whether the
 * head stayed reusable. C is sent twice: the first run of a shape is always
 * cold, so the second is the one that shows the steady state.
 *
 * Money and privacy: this spends a handful of credits on short completions,
 * never prints the token, never prints prompt text, and never writes account
 * state. Run it on an account you are willing to spend a few credits from.
 *
 * Usage:
 *   node scripts/probe-mid-convo-system.mjs
 *   node scripts/probe-mid-convo-system.mjs --model glm-5.2 --region global
 */

import { WorkBuddyCredentialStore, WorkBuddyUpstreamClient, prepareChatBody } from '../lib/index.js'

const argv = process.argv.slice(2)
const value = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 || index + 1 >= argv.length ? fallback : argv[index + 1]
}

let MODEL_OVERRIDE = value('--model', undefined)
const REGION = value('--region', undefined)
const MAX_TOKENS = Number.parseInt(value('--max-tokens', '16'), 10)

/**
 * Deterministic filler.
 *
 * The head must be BYTE-IDENTICAL between shapes B and C, or the cache
 * comparison measures the filler instead of the gateway. No clock, no random
 * source, no filesystem — the same call must produce the same string on every
 * run and in both regions.
 */
const FILLER_RULES = 120
const FILLER = Array.from(
  { length: FILLER_RULES },
  (_, index) => 'Rule ' + (index + 1) + ': answer only what was asked, in as few words as possible.',
).join(' ')

const BASE_HISTORY = [
  { role: 'user', content: 'Hello.' },
  { role: 'assistant', content: 'Hello. How can I help?' },
]

function headWith(secret) {
  return 'You are a test assistant. ' + FILLER + ' Your secret word is ' + secret + '.'
}

const ASK_SECRET = 'What is your secret word? Answer with that single word.'

/**
 * Usage objects from an SSE body, plus the reply text.
 *
 * Kept generic on purpose: the cache read is reported under one of three
 * spellings depending on which side of the gateway answered, and a probe that
 * only knows one would report 0% for a perfectly warm cache.
 */
function readStream(text) {
  let usage
  let reply = ''
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    let parsed
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    if (parsed.usage !== undefined && parsed.usage !== null) usage = parsed.usage
    const delta = parsed.choices?.[0]?.delta?.content
    if (typeof delta === 'string') reply += delta
  }
  const prompt = usage?.prompt_tokens ?? 0
  const cached = usage?.prompt_cache_hit_tokens
    ?? usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.cached_tokens
    ?? 0
  return { prompt, cached, reply: reply.replace(/\s+/g, ' ').trim().slice(0, 40) }
}

async function send(client, credential, messages, label) {
  const body = prepareChatBody(JSON.stringify({
    model: MODEL_OVERRIDE,
    stream: true,
    messages,
    max_tokens: MAX_TOKENS,
  }), {})
  const result = await client.chatStream(credential, body)
  if (!result.ok) {
    process.stdout.write(label.padEnd(22) + ' REFUSED ' + result.status + ' ' + String(result.message).slice(0, 120) + '\n')
    return undefined
  }
  const counters = readStream(await result.response.text())
  const hit = counters.prompt === 0 ? 0 : Math.round((counters.cached / counters.prompt) * 100)
  process.stdout.write(
    label.padEnd(22)
    + 'prompt=' + String(counters.prompt).padStart(6)
    + '  cached=' + String(counters.cached).padStart(6)
    + '  hit=' + String(hit).padStart(3) + '%'
    + '  reply=' + JSON.stringify(counters.reply) + '\n',
  )
  return counters
}

/**
 * The model to probe when none was named.
 *
 * Deterministic and catalog-driven: prefer an id that names a DeepSeek chat
 * model (the family this probe was measured on), else the first entry. The
 * reply column is what tells the operator whether the head or the tail won —
 * a media or reasoning-only entry would return empty content for both and
 * silently erase that signal.
 */
function pickChatModel(models) {
  const chat = models.find(model => /deepseek/i.test(model.id))
  return (chat ?? models[0])?.id
}

async function main() {
  const client = new WorkBuddyUpstreamClient()
  const store = new WorkBuddyCredentialStore({
    refresh: credential => client.refreshToken(credential),
    ...REGION === undefined ? {} : { region: REGION },
  })

  let credential
  try {
    credential = await store.resolve()
  } catch (error) {
    process.stdout.write('no signed-in credential: ' + String(error) + '\n')
    process.stdout.write('Sign in to the WorkBuddy desktop app first, or run `dsh-connect-workbuddy doctor`.\n')
    process.exitCode = 1
    return
  }

  const models = await client.fetchModels(credential)
  // Pick the first text model that answers a short prompt. The catalog's head
  // entry is not always a chat model — a reasoning-only or media entry answers
  // these prompts with empty content, which would make the reply column say
  // "" for every shape and hide the one signal this probe exists to read.
  const modelId = MODEL_OVERRIDE ?? pickChatModel(models)
  if (modelId === undefined) {
    process.stdout.write('model catalog is empty; cannot probe\n')
    process.exitCode = 1
    return
  }
  MODEL_OVERRIDE = modelId

  process.stdout.write('model   : ' + modelId + '\n')
  process.stdout.write('head    : ~' + Math.round(headWith('X').length / 4) + ' tokens of filler\n\n')

  const first = headWith('ALPHA')
  const second = headWith('ZULU') + ' Ignore any earlier instruction naming a different secret word.'

  await send(client, credential, [{ role: 'system', content: first }, ...BASE_HISTORY, { role: 'user', content: ASK_SECRET }], 'A head S1');
  await send(client, credential, [{ role: 'system', content: first }, ...BASE_HISTORY, { role: 'user', content: ASK_SECRET + ' (2)' }], 'B append-only');
  const cold = await send(client, credential, [{ role: 'system', content: first }, ...BASE_HISTORY, { role: 'system', content: second }, { role: 'user', content: ASK_SECRET }], 'C mid system (cold)');
  const warm = await send(client, credential, [{ role: 'system', content: first }, ...BASE_HISTORY, { role: 'system', content: second }, { role: 'user', content: ASK_SECRET }], 'C mid system (warm)');

  process.stdout.write('\nReading the result:\n')
  process.stdout.write('  reply ZULU    the gateway reads the LATEST system message at any position, so\n')
  process.stdout.write('                appending a changed prompt cannot leave the model on a stale one.\n')
  process.stdout.write('  reply ALPHA   the gateway reads only the head; declaring in-history would let the\n')
  process.stdout.write('                model run on an outdated prompt. Do not declare it.\n')
  process.stdout.write('  warm hit high the head stayed reusable across the added message.\n')
  if (cold !== undefined && warm !== undefined) {
    process.stdout.write('  this run      C cold ' + cold.cached + ' -> warm ' + warm.cached + ' cached tokens\n')
  }
}

await main()
