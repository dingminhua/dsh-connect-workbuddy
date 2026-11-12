/**
 * Body-composition report: WHAT was sent upstream, in counts (issue #59).
 *
 * WHY THIS EXISTS. Issue #59's reporter measured the SAME conversation charged
 * ~708K tokens by the CN gateway and ~1.374M by the international one (1.94×),
 * which turns a region switch into an instant `code 11115 prompt is too long`.
 * Two worlds explain that, and they have opposite owners:
 *
 *   - the gateways count identical bytes differently (upstream's business); or
 *   - the two requests did not carry the same messages (ours to fix).
 *
 * Neither world, it turned out — the answer was a third one, and this report is
 * what produced it. A paired capture in one session (4.6.7) measured
 * `bodyBytes` 3,628,068 vs 3,626,374, a ratio of 0.9995: both requests carried
 * the same bytes. What differed was the BUCKET each byte was counted in — CN
 * text 741,687 vs GL 184,821, CN reasoning 72,270 vs GL 627,994, with a
 * complementary residual of 0.3%. The gateways did not miscount; the same
 * history was labelled differently on the two sides.
 *
 * The labelling is pi-ai's replay — which assistant messages it lets survive as
 * thinking at all. `transform-messages.js` (1.1.0, the version the host bundled
 * when this report was written) computes
 *
 *     isSameModel = assistantMsg.provider === model.provider
 *                && assistantMsg.api      === model.api
 *                && assistantMsg.model    === model.id;
 *
 * and for a message that fails it, it returned the surviving thinking as
 * `{ type: "text", text: block.thinking }` — downgraded, not dropped — while it
 * dropped redacted thinking and stripped tool-call `thoughtSignature`. The
 * comparison is what this report explains and it is unchanged in every pi-ai
 * generation this plugin declares; only the ELSE branch moved, and pi-ai 1.3
 * now discards the block instead of rewriting it.
 * `buildParams` runs that transform at `openai-completions.js:896`, before
 * anything is assembled, so a thinking block only stays a thinking block when
 * its message was recorded under the same provider AND the same model id as the
 * request now in flight. Survivors leave as the raw field: `:1002–1008` writes
 * `assistantMsg[signature] = <thinking>`, `signature` being the field name the
 * stream used, recorded per block at `:399–416` (`reasoning_content` for this
 * vendor, uniformly — 790 replay records in one real session held that value
 * and no other). Non-survivors are text by the time `:964–971` collects
 * `assistantText`, so they land in `assistantMsg.content` instead. This plugin
 * sets `compat.supportsReasoningEffort` and `compat.supportsMidConvoSystemMessages`
 * (`src/adapter.ts`), neither of which touches `requiresThinkingAsText`, which
 * leaves `requiresThinkingAsText` at its `false` default (`:1270`), so the raw
 * field route is the live one rather than the fold-into-content route at `:983`.
 *
 * Two provider ids for one model is therefore two identities for one model, and
 * a region switch flips the sign for the entire other side at once: everything
 * that side ever thought is replayed as content instead of as a reasoning field,
 * and the gateways count content. That is the 1.94× above; the same formula read
 * in the other direction is the 0.696× the reverse switch produces (text
 * 642,800 vs 447,306 across the same bytes). The model-id leg of `isSameModel`
 * matters for the same reason — switching models inside ONE region has the same
 * effect — which is why the symptom belongs in `README`'s 已知限制, where users
 * meet it, and not only here.
 *
 * The retraction trail, because this header has misled twice. The first version
 * claimed historical `reasoning` never reaches the wire, because
 * `requiresThinkingAsText` is unset and the `reasoning_details` route needs a
 * signature the parser never writes. Both halves are wrong: the unset flag is
 * precisely what routes thinking out as a raw field. The second version — the
 * one this paragraph replaces — claimed the difference was the field NAME,
 * signature-driven, citing 0.85.1's `:428`/`:1006` and concluding that a gateway
 * saying `reasoning` replays as `reasoning`. That cannot be right either: both
 * gateways say `reasoning_content`, so a name-keyed story predicts NO difference
 * between them, and the host ships 1.1.0, not 0.85.1. What differs is survival,
 * not naming. The file keeps both dead ends on purpose — each one shaped what
 * this report measures, and the third version only settled the question because
 * the report could show bytes equal while buckets were not.
 *
 * This module exists to settle exactly that, and it can do it WITHOUT either
 * region having credit: the body is assembled locally, before the upstream ever
 * gets a chance to answer `14018 Credits exhausted`. Capture one composition per
 * region in the same session and diff them.
 *
 * It records COUNTS ONLY — never a byte of message text, no account name, no
 * token. That is a hard rule, not a default: the point is to compare shape
 * (`messages.length`, per-block type, CJK vs non-CJK characters, total bytes),
 * and every one of those is answerable arithmetically. `tests/issue59-body-report.spec.ts`
 * asserts the report cannot leak a fixture's text.
 */

import { appendFile, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome, withFileLock } from './host-peers.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/**
 * Environment variable that enables the report.
 *
 * Unset or blank means OFF — a diagnostic that writes files must be opt-in.
 * `1`/`true` writes to `<DSH home>/body-reports/`; anything else is read as a
 * directory path, so a user can point it at an existing folder (and, on
 * Windows, one with spaces).
 */
export const WORKBUDDY_BODY_REPORT_ENV = 'WORKBUDDY_BODY_REPORT'

/** One block inside one message, counted by kind. */
export interface WorkBuddyBodyBlockReport {
  /**
   * What kind of block this is on the wire.
   *
   * `system` / `text` / `tool-call` / `tool-result` / `reasoning` / `image` cover
   * everything an OpenAI chat-completions body can carry here, and they map onto
   * the concepts the question is asked in: whether a `reasoning` block exists at
   * all is the direct, empirical check on the code trace that says it should not.
   */
  type: string
  /** Characters (code points), so a CJK character counts once. */
  chars: number
  /** Of {@link chars}, how many are CJK — they bill ~3× an ASCII character. */
  cjkChars: number
}

/** One message, counted by kind. */
export interface WorkBuddyBodyMessageReport {
  role: string
  chars: number
  cjkChars: number
  blocks: WorkBuddyBodyBlockReport[]
}

/** What one request body was made of. Counts only — never content. */
export interface WorkBuddyBodyReport {
  /** ISO timestamp, so two captures can be lined up in time. */
  at: string
  region: WorkBuddyRegion
  /** The model id the body asked for, when the body carries one. */
  model?: string
  /** Total bytes of the serialized body, as sent. */
  bodyBytes: number
  messageCount: number
  /**
   * What the UPSTREAM counted for this request, when it said.
   *
   * This is the other half of the #59 comparison, and it is the half that was
   * missing. `bodyBytes`/`chars` say what we SENT; `promptTokens` says what the
   * gateway CHARGED for it. With only the sent side, a difference between two
   * captures is ambiguous — "the gateway counted the same bytes differently" and
   * "the two bodies were not the same" have the same shape.
   *
   * `undefined` rather than 0 when the upstream reported no usage (a failed
   * request, or a stream cut before its final `usage` frame). An absent
   * measurement must stay unreadable as "charged nothing" — telling those two
   * apart is the entire point of the field.
   */
  promptTokens?: number
  /** The upstream's completion tokens for the same request, when reported. */
  completionTokens?: number
  /**
   * The cache-hit portion of `promptTokens`, when the upstream splits it out.
   *
   * Kept separate because the two gateways were measured to spell the hit count
   * differently, and a cached prompt is not billed like a fresh one — folding it
   * into `promptTokens` would blur the one number the comparison turns on.
   */
  cachedTokens?: number
  /** Characters (code points) across every message block. */
  chars: number
  cjkChars: number
  /**
   * The `tools` array, which is re-sent with every request and is easy to forget
   * when accounting for a prompt. Counted the same way as a message.
   */
  tools: WorkBuddyBodyBlockReport
  messages: WorkBuddyBodyMessageReport[]
}

/**
 * Character ranges that tokenize (and therefore bill) like CJK.
 *
 * Deliberately generous: the caller's question is "how much of this is the ~3×
 * kind", and the measured spread is 0.669 vs 0.224 tokens/char, so a character
 * class that is borderline costs far less than mis-attributing a whole bucket.
 * Ranges follow Unicode blocks, plus the compatibility forms and the two
 * extension planes where rare Han characters live.
 */
const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x2e80, 0x2eff], // radicals
  [0x3000, 0x303f], // CJK punctuation
  [0x3040, 0x30ff], // kana
  [0x3400, 0x4dbf], // extension A
  [0x4e00, 0x9fff], // unified ideographs
  [0xf900, 0xfaff], // compatibility ideographs
  [0xfe30, 0xfe4f], // compatibility forms
  [0xff00, 0xffef], // fullwidth / halfwidth forms
  [0x20000, 0x2fa1f], // extensions B–F
]

/** Whether one code point bills like CJK. */
function isCjkCodePoint(code: number): boolean {
  return CJK_RANGES.some(([low, high]) => code >= low && code <= high)
}

/** Count characters (code points) and how many of them are CJK. */
export function countChars(text: string): { chars: number, cjkChars: number } {
  let chars = 0
  let cjkChars = 0
  // `for…of` iterates code points, so a character outside the BMP counts once
  // rather than as its two surrogate halves — the difference matters for the
  // emoji and rare-Han cases that would otherwise inflate the ASCII bucket.
  for (const character of text) {
    chars += 1
    const code = character.codePointAt(0)
    if (code !== undefined && isCjkCodePoint(code)) cjkChars += 1
  }
  return { chars, cjkChars }
}

/** Build one block report from already-extracted text. */
function block(type: string, text: string): WorkBuddyBodyBlockReport {
  return { type, ...countChars(text) }
}

/** Whether a value is a plain object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Describe one message's blocks.
 *
 * The role decides what a content string IS, and that is not cosmetic: a
 * `tool` message's payload is a tool result, so counting it as `text` would hide
 * the very bucket a long agentic session is mostly made of.
 */
function describeMessage(message: Record<string, unknown>): WorkBuddyBodyMessageReport {
  const role = typeof message['role'] === 'string' ? message['role'] : 'unknown'
  const blocks: WorkBuddyBodyBlockReport[] = []
  const content = message['content']

  /**
   * The block type a plain string carries, by the ROLE carrying it.
   *
   * A `tool` message's string is a tool RESULT and a `system` one is the system
   * prompt; calling both `text` would fold the biggest bucket of a long agentic
   * session into the smallest one, which is the opposite of what a composition
   * report is for.
   */
  const stringType = role === 'tool' ? 'tool-result' : role === 'system' || role === 'developer' ? 'system' : 'text'

  if (typeof content === 'string') {
    if (content !== '') blocks.push(block(stringType, content))
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part)) continue
      const type = typeof part['type'] === 'string' ? part['type'] : 'unknown'
      if (type === 'text') {
        const text = part['text']
        if (typeof text === 'string' && text !== '') blocks.push(block(stringType, text))
        continue
      }
      // Structured parts (image_url, input_audio, …) carry no prose to count,
      // but their PRESENCE is the fact worth recording: they are billed too, and
      // an image part is invisible in any character-based accounting.
      blocks.push({ type: type === 'image_url' ? 'image' : type, chars: 0, cjkChars: 0 })
    }
  }

  // Tool calls the assistant made: the name plus the argument JSON is what the
  // upstream sees, so it is what the count must include.
  const toolCalls = message['tool_calls']
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (!isRecord(call)) continue
      const fn = call['function']
      const name = isRecord(fn) && typeof fn['name'] === 'string' ? fn['name'] : ''
      const args = isRecord(fn) && typeof fn['arguments'] === 'string' ? fn['arguments'] : ''
      blocks.push(block('tool-call', `${name}${args}`))
    }
  }

  // A reasoning-carrying field on an ASSISTANT message. This one DOES appear:
  // pi-ai replays each historical thinking block under the field name its own
  // upstream stream used, so a transcript that talked to a `reasoning` gateway
  // carries `reasoning` and one that talked to a `reasoning_content` gateway
  // carries `reasoning_content`. All three spellings are counted into a single
  // `reasoning` bucket on purpose — the number that matters for #59 is the size
  // of that bucket on each side, not which spelling produced it.
  for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    const value = message[field]
    if (typeof value === 'string' && value !== '') blocks.push(block('reasoning', value))
  }

  const chars = blocks.reduce((sum, entry) => sum + entry.chars, 0)
  const cjkChars = blocks.reduce((sum, entry) => sum + entry.cjkChars, 0)
  return { role, chars, cjkChars, blocks }
}

/**
 * Describe one serialized request body.
 *
 * Returns `undefined` when the body is not a JSON object — a diagnostic must
 * never be the reason a chat request fails, so every caller treats `undefined`
 * as "nothing to report" rather than an error.
 */
export function describeBody(bodyJson: string, region: WorkBuddyRegion, nowMs: number): WorkBuddyBodyReport | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyJson)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined

  const rawMessages = parsed['messages']
  const messages = Array.isArray(rawMessages)
    ? rawMessages.filter(isRecord).map(describeMessage)
    : []

  const rawTools = parsed['tools']
  const tools = Array.isArray(rawTools)
    ? block('tools', rawTools.map(tool => (isRecord(tool) ? JSON.stringify(tool) : '')).join(''))
    : { type: 'tools', chars: 0, cjkChars: 0 }

  const chars = messages.reduce((sum, message) => sum + message.chars, 0) + tools.chars
  const cjkChars = messages.reduce((sum, message) => sum + message.cjkChars, 0) + tools.cjkChars

  return {
    at: new Date(nowMs).toISOString(),
    region,
    ...typeof parsed['model'] === 'string' ? { model: parsed['model'] } : {},
    bodyBytes: Buffer.byteLength(bodyJson, 'utf8'),
    messageCount: messages.length,
    chars,
    cjkChars,
    tools,
    messages,
  }
}

/**
 * What the upstream said it counted, as read from the stream's `usage` block.
 *
 * Kept distinct from the report so the two halves can arrive at different times:
 * the sent side is known before the request leaves, whereas these fields only
 * exist once the answer is over.
 */
export interface WorkBuddyUsageCounts {
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
}

/** A finite, non-negative token count, or undefined for anything else. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Read the token counts out of one already-parsed SSE chunk.
 *
 * Returns undefined when the chunk carries no `usage` — which is every chunk but
 * the last one on a streamed answer, so this is called for each frame and must
 * stay cheap and total. The cache-hit count is looked for under BOTH spellings
 * observed on the two gateways (`prompt_tokens_details.cached_tokens`, OpenAI's,
 * and `prompt_cache_hit_tokens`, which the domestic gateway also emits); taking
 * the first one present keeps the report comparable across regions instead of
 * showing 0 on whichever side uses the other name.
 */
export function usageOfChunk(chunk: Record<string, unknown>): WorkBuddyUsageCounts | undefined {
  const usage = chunk['usage']
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return undefined
  const record = usage as Record<string, unknown>
  const promptTokens = tokenCount(record['prompt_tokens'])
  const completionTokens = tokenCount(record['completion_tokens'])
  const details = record['prompt_tokens_details']
  const fromDetails = typeof details === 'object' && details !== null && !Array.isArray(details)
    ? tokenCount((details as Record<string, unknown>)['cached_tokens'])
    : undefined
  const cachedTokens = fromDetails ?? tokenCount(record['prompt_cache_hit_tokens'])
  if (promptTokens === undefined && completionTokens === undefined && cachedTokens === undefined) return undefined
  return {
    ...promptTokens === undefined ? {} : { promptTokens },
    ...completionTokens === undefined ? {} : { completionTokens },
    ...cachedTokens === undefined ? {} : { cachedTokens },
  }
}

/**
 * Resolve the directory the report writes to, or `undefined` when disabled.
 *
 * Exported for the same reason the other env-var resolvers in this plugin are:
 * the behaviour is worth a unit test, and the test must not have to set a real
 * process-wide variable to get one.
 */
export function bodyReportDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env[WORKBUDDY_BODY_REPORT_ENV]
  if (configured === undefined) return undefined
  const trimmed = configured.trim()
  if (trimmed === '') return undefined
  if (trimmed === '1' || trimmed.toLowerCase() === 'true') return join(resolveDshHome(), 'body-reports')
  return trimmed
}

/**
 * Byte cap for ONE region file (issue #118).
 *
 * An append that would push the file past this rolls it to `<region>.jsonl.1`
 * (replacing any previous roll) and starts a fresh file, so a session left with
 * the env var on can no longer grow a file without bound — the reporter's
 * 508 MB `global.jsonl` is the shape this prevents. One roll is kept rather
 * than none because the diagnostic's value is in comparing two captures, and a
 * capture that vanishes the moment it fills up is worse than one that keeps
 * its immediate predecessor.
 *
 * The cap is generous on purpose: a real session's line is a few kilobytes, so
 * 32 MB is thousands of requests — far past the point where anyone is still
 * reading the file.
 */
export const BODY_REPORT_MAX_BYTES = 32 * 1024 * 1024

/**
 * How many bytes from the END of the file {@link attachUsage} reads when it
 * looks for the line it wrote (issue #118).
 *
 * The old implementation read the WHOLE file, split it, rewrote the WHOLE file —
 * so every streamed answer cost ~3× the file size in heap (the string, the line
 * array, the re-joined string), which is what OOMed the host at ~500 MB. The
 * usage callback fires seconds after its own append, so its line is always
 * near the tail; a bounded tail read makes the cost O(window) instead of
 * O(file). A line older than the window is simply left un-annotated — the
 * annotation is best-effort by design (see the header of {@link attachUsage}).
 *
 * Exported because the boundary behaviour is exactly what a regression would
 * break first, and a test that pins it must be able to size a file against it
 * without reaching into the module.
 */
export const USAGE_ATTACH_TAIL_BYTES = 1024 * 1024

/**
 * Append one composition to `<dir>/<region>.jsonl`.
 *
 * One file per region is the whole point: the reporter captures a session, then
 * diffs `cn.jsonl`'s last line against `global.jsonl`'s. JSON Lines rather than
 * one file per request because a single turn makes many upstream calls (one per
 * tool step) and the LAST one is the interesting one.
 *
 * Read-modify-write is avoided on purpose — a long session would rewrite a
 * growing file on every step. The lock keeps two concurrent requests from
 * interleaving a line, and the size check inside the SAME lock keeps two
 * concurrent appends from both deciding "no roll needed" and then writing past
 * the cap together.
 */
export async function appendBodyReport(directory: string, report: WorkBuddyBodyReport): Promise<void> {
  const file = join(directory, `${report.region}.jsonl`)
  await mkdir(directory, { recursive: true })
  const line = `${JSON.stringify(report)}\n`
  await withFileLock(file, async () => {
    const size = await stat(file).then(entry => entry.size).catch(() => 0)
    if (size > 0 && size + Buffer.byteLength(line, 'utf8') > BODY_REPORT_MAX_BYTES) {
      const rolled = `${file}.1`
      await rm(rolled, { force: true })
      await rename(file, rolled)
    }
    await appendFile(file, line, 'utf8')
  })
}

/**
 * Record one outgoing body, if the report is enabled, and return a handle that
 * can carry the upstream's `usage` back onto the SAME line.
 *
 * NEVER THROWS and never awaits long: this is called on the request path, and a
 * chat request must not fail (or stall) because a diagnostic could not write a
 * file. A failure is reported through `onError` so the caller can log it.
 *
 * The returned function exists because the two halves of the #59 comparison are
 * only available at different times: what we SENT is known before the request
 * leaves, what the gateway CHARGED only after the stream ends. Writing a second
 * line for the usage would be worse than useless — the reporter diffs "the last
 * line of cn.jsonl against the last line of global.jsonl", and a trailing
 * usage-only line would silently become the one being compared.
 */
export async function recordBodyReport(
  region: WorkBuddyRegion,
  bodyJson: string,
  options: {
    env?: NodeJS.ProcessEnv
    nowMs?: number
    onError?: (error: unknown) => void
  } = {},
): Promise<((usage: WorkBuddyUsageCounts | undefined) => void)> {
  const directory = bodyReportDirectory(options.env)
  if (directory === undefined) return () => {}
  try {
    const report = describeBody(bodyJson, region, options.nowMs ?? Date.now())
    if (report === undefined) return () => {}
    await appendBodyReport(directory, report)
    return attachUsage(directory, report, options.onError)
  } catch (error: unknown) {
    options.onError?.(error)
    return () => {}
  }
}

/**
 * Return a callback that rewrites its own line with the upstream's counts.
 *
 * Matched by `at` + `region` + `bodyBytes` + `messageCount`, all four being
 * stable for a finished request: `at` alone can collide when two requests are
 * timestamped in the same millisecond, and `bodyBytes` tells apart the two
 * different bodies a failover or a retry can produce. A line that is already
 * annotated is left alone, so a second call cannot double-apply.
 *
 * The rewrite touches ONLY the tail window (issue #118): the file is opened
 * `r+`, the last {@link USAGE_ATTACH_TAIL_BYTES} are read, the window is split
 * into lines, the target line is replaced, and the new window is written back
 * at the SAME offset with the file truncated to the new end. Nothing before the
 * window is ever read or written, so a 500 MB file costs one megabyte of heap
 * here instead of three copies of itself.
 *
 * Two consequences of the bounded window, both deliberate:
 *
 *   - a line pushed out of the window by later appends is left un-annotated.
 *     The annotation is a convenience for the #59 diff, never a correctness
 *     requirement — the sent side is already on disk;
 *   - the window must start on a line boundary, so the read takes ONE byte of
 *     lookback before it: when that byte is a newline the window already starts
 *     on a boundary and its first line is complete (kept in search and rewrite);
 *     otherwise the first partial line is dropped from the SEARCH and preserved
 *     byte-for-byte by starting the write at the first complete line's offset.
 */
function attachUsage(
  directory: string,
  report: WorkBuddyBodyReport,
  onError?: (error: unknown) => void,
): (usage: WorkBuddyUsageCounts | undefined) => void {
  /**
   * Two independent idempotence guards, kept redundant on purpose.
   *
   * `done` avoids a second disk read within one handle's lifetime; the
   * "already annotated" check inside the loop catches the OTHER case — a second
   * handle for the same body, which is what a failover retry produces (it opens
   * its own stream, and therefore its own handle). Either alone is enough for
   * the common path, so removing just one is not observable behaviourally;
   * removing BOTH is, and `tests/issue59-body-report.spec.ts` pins that.
   */
  let done = false
  return usage => {
    if (usage === undefined || done) return
    done = true
    const file = join(directory, `${report.region}.jsonl`)
    void (async () => {
      try {
        await withFileLock(file, async () => {
          const handle = await open(file, 'r+')
          try {
            const { size } = await handle.stat()
            if (size === 0) return
            const windowBytes = Math.min(size, USAGE_ATTACH_TAIL_BYTES)
            const windowStart = size - windowBytes
            // One byte of LOOKBACK: whether the window starts on a line boundary
            // decides whether its first line is complete (searchable and
            // rewritable) or a tail fragment of an earlier line (neither).
            // Guessing wrong in either direction is a data-loss bug — dropping
            // a complete line from the rewrite deletes it from the file.
            const readStart = windowStart === 0 ? 0 : windowStart - 1
            const readLength = size - readStart
            const buffer = Buffer.allocUnsafe(readLength)
            const { bytesRead } = await handle.read(buffer, 0, readLength, readStart)
            if (bytesRead === 0) return
            const raw = buffer.toString('utf8', 0, bytesRead)
            let contentStart: number
            let text: string
            if (readStart === 0) {
              contentStart = 0
              text = raw
            } else if (raw.startsWith('\n')) {
              // The lookback byte IS the previous line's terminator, so the
              // window begins exactly on a line boundary: the first line is
              // complete and must stay in both the search and the rewrite.
              contentStart = readStart + 1
              text = raw.slice(1)
            } else {
              const firstNewline = raw.indexOf('\n')
              if (firstNewline === -1) return // one giant line; nothing to do
              contentStart = readStart + firstNewline + 1
              text = raw.slice(firstNewline + 1)
            }
            const lines = text.split('\n')
            // The final element after a trailing newline is '' — ignored below.
            for (let index = lines.length - 1; index >= 0; index -= 1) {
              const line = lines[index]
              if (line === undefined || line === '') continue
              let parsed: unknown
              try {
                parsed = JSON.parse(line)
              } catch {
                continue
              }
              if (!isRecord(parsed)) continue
              if (parsed['at'] !== report.at) continue
              if (parsed['region'] !== report.region) continue
              if (parsed['bodyBytes'] !== report.bodyBytes) continue
              if (parsed['messageCount'] !== report.messageCount) continue
              // Already annotated: leave it alone. This is the guard that makes
              // "first measurement wins" hold when a SECOND handle exists for
              // the same body (a failover retry starts a fresh stream); `done`
              // above only saves a disk read within one handle's lifetime.
              if (parsed['promptTokens'] !== undefined) return
              lines[index] = JSON.stringify({ ...parsed, ...usage })
              const rewritten = lines.join('\n')
              await handle.write(rewritten, contentStart, 'utf8')
              await handle.truncate(contentStart + Buffer.byteLength(rewritten, 'utf8'))
              return
            }
          } finally {
            await handle.close()
          }
        })
      } catch (error: unknown) {
        onError?.(error)
      }
    })()
  }
}
