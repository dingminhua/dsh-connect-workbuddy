#!/usr/bin/env node
/**
 * Which turns paid for the WHOLE context instead of a cache hit, and why?
 *
 * DSH sends the model a session surface whose node 0 is the system prompt. The
 * upstream's prefix cache is a byte match, so the moment that node changes —
 * a plugin installed, an MCP server added, a skill edited — the cache misses
 * from the first changed token onwards and the ENTIRE context is re-billed at
 * the uncached price. One such turn on a long session can cost more than a
 * hundred ordinary ones, and nothing in the log calls it out: it is a normal
 * assistant/message with a large inputTokens and a near-zero cacheReadTokens.
 *
 * This script finds those turns across every session log under DSH_HOME,
 * attributes each to one of two causes, and prints them worst-first:
 *
 *   prompt-changed  a system/message event landed in the few events before the
 *                   request, so the prompt itself had just changed. This is the
 *                   cause a route avoids by declaring
 *                   systemPromptUpdate: 'in-history', which appends the new
 *                   prompt AFTER the cached history instead of rewriting node 0.
 *   cache-expired   nothing in the log changed; the provider's prefix cache had
 *                   aged out (DeepSeek documents clearing an unused prefix
 *                   within hours to days). No configuration avoids this one.
 *
 * READ-ONLY and offline: it decodes local session logs and spends no credits.
 *
 * Usage:
 *   node scripts/audit-prompt-cache.mjs
 *   node scripts/audit-prompt-cache.mjs --dsh-home "/path/to/dsh"
 *   node scripts/audit-prompt-cache.mjs --min-surface 100000 --json
 *   node scripts/audit-prompt-cache.mjs --credits-per-k 0.06005 --offpeak-factor 0.5
 *
 * Every figure is a token count unless --credits-per-k is supplied: the price
 * per 1k uncached input tokens differs by model and by day, so the script
 * refuses to bake one in. --offpeak-factor exists because some catalogs
 * discount off-peak hours (pass 0.5 and the documented peak window applies);
 * with no flags every turn is priced at the flat rate.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

/** Zstd frame magic; DSH appends one frame per flush, so a log is many frames. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * The event distance within which a system/message still explains a request.
 *
 * The prompt is written by agent/pre-step, so it lands a handful of events
 * before the request/header and the answer: in the measured sessions the gap
 * was 4–7 events. Eight covers it without reaching into the previous turn.
 */
const PROMPT_CHANGE_WINDOW = 8

/** A request is "re-billed" below this cache-hit share of its surface. */
const REBILL_HIT_SHARE = 0.05

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const value = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 || index + 1 >= argv.length ? fallback : argv[index + 1]
}

const DSH_HOME = value('--dsh-home', process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const MIN_SURFACE = Number.parseInt(value('--min-surface', '100000'), 10)
const CREDITS_PER_K = Number.parseFloat(value('--credits-per-k', '0'))
const OFFPEAK_FACTOR = Number.parseFloat(value('--offpeak-factor', '1'))
const AS_JSON = flag('--json')

/**
 * Decode one multi-frame zstd log into text.
 *
 * zlib.zstdDecompressSync stops at the FIRST frame's end and silently returns
 * only its 200-odd bytes of session header — no error, no warning. Splitting
 * on the frame magic and decoding each slice is what makes the rest of the log
 * visible at all; getting this wrong looks exactly like "a session with one
 * event".
 */
export function decodeLog(raw) {
  const starts = []
  for (let index = raw.indexOf(ZSTD_MAGIC); index !== -1; index = raw.indexOf(ZSTD_MAGIC, index + 1)) {
    starts.push(index)
  }
  if (starts.length === 0) return raw.toString('utf8')
  let text = ''
  for (let frame = 0; frame < starts.length; frame++) {
    const slice = raw.subarray(starts[frame], frame + 1 < starts.length ? starts[frame + 1] : raw.length)
    try {
      text += zlib.zstdDecompressSync(slice).toString('utf8')
    } catch {
      // A torn trailing frame is the normal state of a log written a moment
      // ago; everything decoded so far is still valid.
    }
  }
  return text
}

/** Every durable event of one log; unparsable lines are skipped, not fatal. */
export function readEvents(raw) {
  const events = []
  for (const line of decodeLog(raw).split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // Torn tail line.
    }
  }
  return events
}

/**
 * Fold one session's events into the requests worth reporting.
 *
 * promptSeqs is the whole attribution signal: a system/message is emitted
 * only when the assembled prompt differs from the previous one, so "a prompt
 * event shortly before this request" means the surface head moved.
 */
export function summarizeSession(events, options = {}) {
  const minSurface = options.minSurface ?? MIN_SURFACE
  const window = options.promptChangeWindow ?? PROMPT_CHANGE_WINDOW
  const promptSeqs = events.filter(event => event.type === 'system/message').map(event => event.seq)

  const requests = []
  let first = true
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (usage === undefined) continue
    const surface = usage.totalTokens ?? 0
    const cached = usage.cacheReadTokens ?? 0
    const nearPromptChange = promptSeqs.some(seq => seq < event.seq && event.seq - seq < window)
    // The first request of a session has no prefix to reuse yet: it is the
    // cost of starting, not a re-bill.
    if (!first && surface >= minSurface && cached / Math.max(surface, 1) < REBILL_HIT_SHARE) {
      requests.push({
        seq: event.seq,
        time: event.time,
        turn: event.data?.turn,
        surface,
        cached,
        uncached: usage.inputTokens ?? Math.max(0, surface - cached),
        cause: nearPromptChange ? 'prompt-changed' : 'cache-expired',
      })
    }
    first = false
  }
  return requests
}

/** Every session.*.jsonl.zstd under <home>/sessions/<workspace>/<session>/. */
export function sessionFiles(home) {
  const root = join(home, 'sessions')
  const files = []
  let workspaces
  try {
    workspaces = readdirSync(root)
  } catch {
    return files
  }
  for (const workspace of workspaces) {
    const workspacePath = join(root, workspace)
    if (!statSync(workspacePath).isDirectory()) continue
    for (const session of readdirSync(workspacePath)) {
      const sessionPath = join(workspacePath, session)
      if (!statSync(sessionPath).isDirectory()) continue
      for (const name of readdirSync(sessionPath)) {
        if (!name.endsWith('.jsonl.zstd') || name.includes('.bak')) continue
        files.push({
          label: workspace.replace(/^--|--$/g, '').slice(0, 24) + '/' + session.replace(/^session-/, '').slice(0, 8),
          path: join(sessionPath, name),
        })
      }
    }
  }
  return files
}

/** Local clock for one epoch-ms, plus whether it falls in a weekday peak window. */
export function stamp(ms) {
  const date = new Date(ms)
  const hour = date.getHours()
  const weekday = date.getDay()
  const peak = weekday >= 1 && weekday <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
  const pad = n => String(n).padStart(2, '0')
  return {
    text: pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(hour) + ':' + pad(date.getMinutes()),
    peak,
  }
}

/**
 * Pricing for one re-bill.
 *
 * Zero unless a rate was supplied: the per-1k price is model- and
 * day-specific, and a wrong constant here would silently become "the" cost of
 * the bug.
 */
export function creditsOf(uncached, peak, creditsPerK, offpeakFactor) {
  if (!(creditsPerK > 0)) return 0
  return (uncached / 1000) * creditsPerK * (peak ? 1 : offpeakFactor)
}

/**
 * The `credits` FIELD for one row: present only when a rate was supplied.
 *
 * Not `creditsOf`, which keeps returning 0 for callers that want a number. A row
 * carrying `credits: 0` tells anything consuming `--json` that this re-bill was
 * free, when the truth is "no rate was given, so we refuse to price it". Absence
 * says that; zero contradicts it.
 */
export function creditsFieldOf(uncached, peak, creditsPerK, offpeakFactor) {
  return creditsPerK > 0 ? { credits: creditsOf(uncached, peak, creditsPerK, offpeakFactor) } : {}
}

function main() {
  const files = sessionFiles(DSH_HOME)
  if (files.length === 0) {
    process.stdout.write('no session logs under ' + join(DSH_HOME, 'sessions') + '\n')
    process.stdout.write('Pass --dsh-home (or set DSH_HOME) if DSH keeps them elsewhere.\n')
    process.exitCode = 1
    return
  }

  const rows = []
  let requestCount = 0
  for (const file of files) {
    let events
    try {
      events = readEvents(readFileSync(file.path))
    } catch (error) {
      process.stdout.write('skip ' + file.label + ': ' + String(error) + '\n')
      continue
    }
    requestCount += events.filter(event => event.type === 'assistant/message' && event.data?.usage !== undefined).length
    for (const row of summarizeSession(events)) {
      const when = stamp(row.time)
      rows.push({
        ...row,
        session: file.label,
        when: when.text,
        peak: when.peak,
        ...creditsFieldOf(row.uncached, when.peak, CREDITS_PER_K, OFFPEAK_FACTOR),
      })
    }
  }

  // Seeded (forked) sessions replay their source's log, so one real re-bill
  // appears in both files. Same moment, turn and uncached count is the same
  // request; keep it once.
  const seen = new Set()
  const unique = rows.filter(row => {
    const key = row.when + '|' + String(row.turn ?? '-') + '|' + row.uncached
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  unique.sort((a, b) => b.uncached - a.uncached)

  if (AS_JSON) {
    process.stdout.write(JSON.stringify({ dshHome: DSH_HOME, requests: requestCount, rebills: unique }, null, 2) + '\n')
    return
  }

  const byCause = {}
  for (const row of unique) byCause[row.cause] = (byCause[row.cause] ?? 0) + row.uncached
  const totalUncached = unique.reduce((sum, row) => sum + row.uncached, 0)

  process.stdout.write('dsh home : ' + DSH_HOME + '\n')
  process.stdout.write('sessions : ' + files.length + ' files, ' + requestCount + ' requests\n')
  process.stdout.write('re-bills : ' + unique.length + ' (surface >= ' + MIN_SURFACE + ' tokens, cache hit < ' + (REBILL_HIT_SHARE * 100) + '%)\n')
  process.stdout.write('uncached : ' + totalUncached + ' tokens\n')
  for (const [cause, uncached] of Object.entries(byCause)) {
    process.stdout.write('  ' + cause.padEnd(15) + ' ' + uncached + ' tokens\n')
  }
  if (CREDITS_PER_K > 0) {
    const credits = unique.reduce((sum, row) => sum + row.credits, 0)
    process.stdout.write('credits  : ' + credits.toFixed(1) + ' at ' + CREDITS_PER_K + '/1k, off-peak x' + OFFPEAK_FACTOR + '\n')
  } else {
    process.stdout.write('credits  : (pass --credits-per-k to price these turns)\n')
  }
  process.stdout.write('\n')
  process.stdout.write('when'.padEnd(12) + 'turn'.padStart(5) + '  ' + 'uncached'.padStart(9) + '  ' + 'surface'.padStart(9) + '  cause            session\n')
  for (const row of unique) {
    process.stdout.write(
      row.when.padEnd(12)
      + String(row.turn ?? '-').padStart(5) + '  '
      + String(row.uncached).padStart(9) + '  '
      + String(row.surface).padStart(9) + '  '
      + row.cause.padEnd(17) + row.session + '\n',
    )
  }
  process.stdout.write('\n"prompt-changed" rows are the ones a route can avoid by declaring\n')
  process.stdout.write("systemPromptUpdate: 'in-history' (see src/adapter.ts).\n")
}

// Importable for tests; a direct run does the work.
if (process.argv[1]?.endsWith('audit-prompt-cache.mjs')) main()
