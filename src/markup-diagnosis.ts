/**
 * Diagnosis for a WorkBuddy upstream defect this project first hit in
 * production and can neither prevent nor fix: the model sometimes writes its
 * tool call into the assistant TEXT (`delta.content`) using its own transcript
 * markup instead of returning a structured `delta.tool_calls`, and the gateway
 * does not convert it. DeepSeek Harness then has nothing to route — the markup
 * is rendered verbatim as prose, which is the "red wall of text" users report.
 *
 * This module exists because that claim was once made in a session and could
 * not be checked by the person reading it. Everything here is a PURE function
 * over captured bytes: no filesystem, no network, no DSH home. That is what
 * makes it testable — `vitest.config.ts` deliberately points `HOME`/`DSH_HOME`
 * at an empty temp dir, so a module that read the real session store could not
 * be covered by the suite at all. The CLI that DOES read the real machine is
 * `scripts/verify-dsml.mjs`, which calls into these functions.
 *
 * The three questions, in the order the CLI asks them:
 *   1. {@link classifyStream}      — did the upstream answer with a real call,
 *                                    or with markup buried in the text?
 *   2. {@link analyzeSessionEvents} — does a recorded transcript actually
 *                                    contain such markup, and did that message
 *                                    carry a structured call alongside it? Split
 *                                    by {@link classifyRecordedText} into real
 *                                    emissions and mere quotations.
 *   3. {@link findMarkup}          — where exactly does the markup sit, so a
 *                                    human can look at it rather than trust us.
 *
 * Deliberate scope limit: these functions only DECIDE and REPORT. They do not
 * rewrite, strip or convert markup, because that would be the actual fix — a
 * change to the response path every request passes through — and it must not
 * arrive as a side effect of a diagnostic tool. See `docs/` for the open
 * decision.
 *
 * @module dsh-connect-workbuddy/markup-diagnosis
 */

/**
 * Full-width vertical line U+FF5C.
 *
 * The model's markup uses `｜` (U+FF5C), NOT the ASCII `|` (U+007C) this code
 * is written with. The two look nearly identical in most fonts, which is why
 * every regex here is built from this constant instead of a literal — a hand-
 * typed `|` would silently never match, and a check that never matches looks
 * exactly like a clean bill of health.
 */
export const FULLWIDTH_BAR = '\uff5c'

/**
 * The identifying token of the model's tool-call markup: `｜｜DSML｜｜`.
 *
 * One token, not the whole grammar. The grammar around it is unstable (this
 * project has captured opening tags with and without a trailing space, and
 * closing tags doubled to `｜｜DSML｜｜ calls>`), so anything that pattern-
 * matched the full shape would miss the next variant. Detection keys on the
 * token; {@link findMarkup} reports the messy surroundings as-is.
 */
export const MARKUP_TOKEN = `${FULLWIDTH_BAR}${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}${FULLWIDTH_BAR}`

/** How one upstream response answered the request. */
export type StreamShape =
  /** A real `delta.tool_calls` array carried the call — the healthy path. */
  | 'native-tool-call'
  /** The text carried the markup: the defect this module diagnoses. */
  | 'markup-in-content'
  /** Ordinary prose, no call attempted. Not a defect. */
  | 'text-only'
  /** No usable assistant delta at all (error frame, empty body, truncation). */
  | 'empty'

/** One `data:` frame of an OpenAI-style SSE stream, parsed. */
export interface StreamChunk {
  /** Concatenated `delta.content` of this frame (`''` when absent). */
  content: string
  /** Number of entries in this frame's `delta.tool_calls`. */
  toolCallCount: number
  /** Function name of the first tool call in this frame, when present. */
  toolName?: string | undefined
  /** This frame's `finish_reason` (`''` when absent). */
  finishReason: string
}

/** Verdict over a whole captured response. */
export interface StreamVerdict {
  shape: StreamShape
  /** Every frame that parsed, in order. Malformed `data:` lines are counted, not thrown. */
  chunks: StreamChunk[]
  /** Total `data:` frames seen, including ones that failed to parse. */
  dataFrames: number
  /** Frames whose payload was not valid JSON. */
  unparsableFrames: number
  /** Frames carrying non-empty `delta.content`. */
  contentFrames: number
  /** Frames carrying at least one `delta.tool_calls` entry. */
  toolCallFrames: number
  /** Summed length of all `delta.content`. */
  contentChars: number
  /** Last non-empty `finish_reason` seen. */
  finishReason: string
  /** True when {@link MARKUP_TOKEN} appears anywhere in the raw response. */
  hasMarkup: boolean
  /** Where the markup sits, when present. */
  markup: MarkupHit | null
}

/**
 * Parse an SSE body into frames.
 *
 * Tolerant by design: a diagnostic that threw on the one malformed frame it was
 * meant to describe would be useless. Unparseable payloads are counted so
 * {@link classifyStream} can still speak about them, and `data: [DONE]` is
 * skipped rather than reported as garbage.
 */
export function parseStream(body: string): { chunks: StreamChunk[]; dataFrames: number; unparsableFrames: number } {
  const chunks: StreamChunk[] = []
  let dataFrames = 0
  let unparsableFrames = 0
  for (const raw of body.split('\n')) {
    if (!raw.startsWith('data:')) continue
    const payload = raw.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    dataFrames += 1
    let frame: unknown
    try {
      frame = JSON.parse(payload)
    } catch {
      unparsableFrames += 1
      continue
    }
    const first = ((frame as { choices?: unknown[] })?.choices?.[0] ?? {}) as Record<string, unknown>
    const delta = (first.delta ?? {}) as Record<string, unknown>
    const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    const name = (calls[0] as { function?: { name?: unknown } } | undefined)?.function?.name
    chunks.push({
      content: typeof delta.content === 'string' ? delta.content : '',
      toolCallCount: calls.length,
      toolName: typeof name === 'string' && name !== '' ? name : undefined,
      finishReason: typeof first.finish_reason === 'string' ? first.finish_reason : '',
    })
  }
  return { chunks, dataFrames, unparsableFrames }
}

/**
 * Decide how one captured response answered, and gather the counts that back
 * the verdict.
 *
 * The ordering matters. Markup wins over everything else: a response can carry
 * BOTH a cosmetic content preamble and the markup, and calling that "native"
 * because some frame also has a `tool_calls` array would hide the defect this
 * function exists to find.
 */
export function classifyStream(body: string): StreamVerdict {
  const { chunks, dataFrames, unparsableFrames } = parseStream(body)
  const contentFrames = chunks.filter(c => c.content !== '').length
  const toolCallFrames = chunks.filter(c => c.toolCallCount > 0).length
  const contentChars = chunks.reduce((n, c) => n + c.content.length, 0)
  const finishReason = chunks.map(c => c.finishReason).filter(r => r !== '').slice(-1)[0] ?? ''
  const markup = findMarkup(body)

  let shape: StreamShape
  if (markup !== null) shape = 'markup-in-content'
  else if (toolCallFrames > 0) shape = 'native-tool-call'
  else if (contentFrames > 0) shape = 'text-only'
  else shape = 'empty'

  return {
    shape,
    chunks,
    dataFrames,
    unparsableFrames,
    contentFrames,
    toolCallFrames,
    contentChars,
    finishReason,
    hasMarkup: markup !== null,
    markup,
  }
}

/** One located occurrence of the markup token. */
export interface MarkupHit {
  /** Number of {@link MARKUP_TOKEN} occurrences in the text. */
  count: number
  /** Text around the FIRST occurrence, for a human to eyeball. */
  excerpt: string
  /** Character offset of the first occurrence. */
  at: number
}

/**
 * Locate the markup token in a string.
 *
 * Returns `null` when absent, so callers test one value instead of a count.
 * The excerpt is deliberately raw — including any damaged brackets or unclosed
 * quoting — because the damage IS the evidence: a well-formed call would have
 * been routed, so what a reader needs to see is how it was malformed.
 */
export function findMarkup(text: string, radius = 160): MarkupHit | null {
  const at = text.indexOf(MARKUP_TOKEN)
  if (at < 0) return null
  let count = 0
  for (let i = text.indexOf(MARKUP_TOKEN); i >= 0; i = text.indexOf(MARKUP_TOKEN, i + 1)) count += 1
  return { count, excerpt: text.slice(Math.max(0, at - radius), at + radius), at }
}

/**
 * A call attempt: markup carrying `invoke name="…"`.
 *
 * Requiring the `invoke` clause is what separates a CALL ATTEMPT from a bare
 * mention of the token. Without it, an assistant writing "the marker looks like
 * `｜｜DSML｜｜`" counts as an occurrence of the defect.
 */
const CALL_ATTEMPT = new RegExp(`${MARKUP_TOKEN}\\s*invoke\\s+name="([^"]+)"`)

/** One recorded message, reduced to what the diagnosis needs. */
export interface RecordedMessage {
  /** Content block `type` values in order, e.g. `['reasoning','text','tool-call']`. */
  blockTypes: string[]
  /** Concatenated text blocks. */
  text: string
  /** Provider of the route in effect for this message, when resolvable. */
  provider?: string
  /** Model of that route. */
  model?: string
  /** Event sequence number, so a reader can find the original. */
  seq?: number
}

/** How one recorded message relates to the markup. */
export type RecordedMarkupKind =
  /** A call attempt the host did not route — the defect itself. */
  | 'emission'
  /** Markup quoted inside a code fence: the assistant discussing it. */
  | 'mention'
  /** No call attempt present. */
  | 'none'

/** What a recorded transcript shows about the defect. */
export interface SessionMarkupReport {
  /** Messages containing a call attempt that was NOT routed. */
  emissions: number
  /**
   * Of those, how many carried a real `tool-call` block TOO.
   *
   * This is the number that settles "was it ever fixed?": an emission with zero
   * tool-call blocks was rendered as prose by definition — there was no
   * structured call for the host to route. Reported beside `emissions` rather
   * than folded into it, because the pair together is the finding.
   */
  emissionsWithStructuredCall: number
  /**
   * Messages that merely QUOTE the markup inside a code fence.
   *
   * Counted separately and never added to `emissions`: an assistant explaining
   * the defect (this project's own sessions do exactly that) must not enlarge
   * the count of times it happened, or the number is meaningless.
   */
  mentions: number
  /** Tool name of the first emission, when there is one. */
  sampleTool?: string | undefined
  /** First emission, for a human to read. */
  sample: RecordedMessage | null
}

/**
 * Decide whether a recorded message EMITTED the markup or merely MENTIONED it.
 *
 * Not a cosmetic distinction. Measured against this project's own sessions, a
 * token-only test reported 20 affected messages; most of them were an assistant
 * quoting the markup while explaining it, and one was the token sitting inside a
 * `dsh-ui` spec. Counting those would have overstated the defect several times
 * over — and the inflated number is the one a reader would have been asked to
 * believe.
 *
 * The rule: an emission is a call attempt (`invoke name="…"`) that is NOT inside
 * an open code fence. A fenced attempt is the assistant showing the damage.
 *
 * Known limit, stated rather than hidden: an emission the model itself wrapped
 * in a fence would be read as a mention. That direction is chosen deliberately —
 * undercounting one odd case beats inflating the count with prose, because the
 * number exists to justify a decision, not to alarm.
 */
export function classifyRecordedText(text: string): RecordedMarkupKind {
  const attempt = CALL_ATTEMPT.exec(text)
  if (attempt === null) return 'none'
  // An odd number of fences before the attempt means it sits inside an open one.
  const fencesBefore = text.slice(0, attempt.index).split('```').length - 1
  return fencesBefore % 2 === 1 ? 'mention' : 'emission'
}

/**
 * Summarise the markup defect across recorded messages.
 *
 * Pure: the caller does the reading (zstd, jsonl, event shapes). Keeping the
 * file format out of here is what lets the suite cover the arithmetic with
 * hand-written fixtures instead of a captured transcript that ages out.
 */
export function analyzeSessionEvents(messages: RecordedMessage[]): SessionMarkupReport {
  const emissions = messages.filter(m => classifyRecordedText(m.text) === 'emission')
  const mentions = messages.filter(m => classifyRecordedText(m.text) === 'mention')
  const sample = emissions[0] ?? null
  return {
    emissions: emissions.length,
    emissionsWithStructuredCall: emissions.filter(m => m.blockTypes.includes('tool-call')).length,
    mentions: mentions.length,
    sampleTool: sample === null ? undefined : CALL_ATTEMPT.exec(sample.text)?.[1],
    sample,
  }
}

/**
 * Explain a verdict in one plain sentence, for a reader who does not want to
 * interpret counts.
 *
 * Kept here rather than in the CLI so the wording is covered by tests — the
 * point of this whole module is that a claim about the defect is checkable, and
 * that includes the sentence the reader is asked to believe.
 */
export function explainShape(verdict: StreamVerdict): string {
  switch (verdict.shape) {
    case 'markup-in-content':
      return `模型把工具调用写进了正文（${verdict.markup?.count ?? 0} 处标记），没有走结构化调用通道 —— 这就是正文里出现那段文字的原因。`
    case 'native-tool-call':
      return `模型返回了结构化的 tool_calls（${verdict.toolCallFrames} 个分片），路径正常，本次没有复现。`
    case 'text-only':
      return '模型只回了普通文字，没有尝试调用工具，本次不能作为证据。'
    case 'empty':
      return '响应里没有可用的助手内容（可能是错误帧或被截断），本次不能作为证据。'
  }
}
