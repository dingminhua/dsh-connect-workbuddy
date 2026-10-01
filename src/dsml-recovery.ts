/**
 * Recovery for one upstream defect: the model writes its tool call into the
 * assistant TEXT (`delta.content`) instead of returning a structured
 * `delta.tool_calls`.
 *
 * `src/markup-diagnosis.ts` already establishes that this happens, and that it
 * is not this plugin's fault: the marker is the model's own transcript markup,
 * emitted into the wrong channel. What that module deliberately does NOT do is
 * act on it — it only reports. This module is the acting half: it recognises a
 * markup block, decides whether it is safe to treat as a real call, and hands
 * back either the call or the untouched text.
 *
 * ============================================================================
 * The four gates (why this is not "just parse the XML")
 * ============================================================================
 *
 * The obvious implementation — see markup looking like a call, call it a call —
 * shipped upstream and was rolled back after three classes of production
 * accident: truncated turns producing EMPTY-argument calls, prose that merely
 * DISCUSSED the markup being executed as a call, and names that the request
 * never declared being promoted to real calls. Each gate below exists because
 * of one of those:
 *
 *   1. CLOSE BEFORE COMMIT — a call is produced only once its closing tag has
 *      arrived. An unclosed block (token-limit truncation, stream cut) is
 *      handed back as text. It is never guessed at.
 *   2. NAME MUST BE DECLARED — the tool name must appear in THIS request's
 *      `tools`. A name that was not offered is not a call we may invent.
 *   3. NO TOOLS, NO RECOVERY — when the request declared no tools (which
 *      includes `tool_choice: "none"`, after `prepareChatBody` removes them),
 *      the caller must not run this at all. `declaredTools()` returning
 *      nothing is the signal.
 *   4. ANY DOUBT ROLLS BACK — required parameters missing, a name that does
 *      not match a pinned `tool_choice`, anything unparsable: the block is
 *      returned as text, VERBATIM. Gate 4 says "show it", not "hide it":
 *      silently dropping a block would lose content the user cannot see
 *      missing, and a check that swallows text looks exactly like a check that
 *      passes — a trap this project has already paid for once.
 *
 * The consequence worth stating plainly: this module converts only the shapes
 * that are unambiguously calls. The shape this project has actually captured —
 * `<｜DSML｜ validate>` where the tool name overwrote the `invoke name="…"`
 * clause — carries no tool name at all, so it can never pass gate 2 and is
 * returned as text (see `docs/DSML-RECOVERY-PLAN.md` §5 for the decided
 * fallback).
 *
 * ============================================================================
 * Provenance
 * ============================================================================
 *
 * The tag scanner, the ignored-region handling, the parameter parser and the
 * streaming buffer are a TypeScript port of `src/codebuddy_proxy/dsml_parser.py`
 * from <https://github.com/hawklithm/workbuddy2api> (MIT, Copyright (c) 2026
 * Mayer) — a DSH plugin proxying the same WorkBuddy/CodeBuddy upstream, which
 * is why its edge cases look so familiar. Three deviations are deliberate and
 * are called out at their sites:
 *
 *   - the reference defines `find_invoke_blocks` twice (the second shadows the
 *     first); only one implementation is carried here;
 *   - the reference's streaming injection reads `tc["name"]`/`tc["input"]`
 *     while its own parser returns `{id, type, function}`; this port has ONE
 *     call shape ({@link RecoveredToolCall}) so the two cannot disagree;
 *   - the reference has no gate 2 and no gate 3 at all (no declared-tool
 *     check anywhere in the repository). They are added here.
 *
 * Purity is a hard requirement: no filesystem, no network, no logging, no
 * clock. `vitest.config.ts` points `HOME`/`DSH_HOME` at an empty temp dir, so a
 * module that reached outside would simply not be testable.
 *
 * @module dsh-connect-workbuddy/dsml-recovery
 */

import { randomUUID } from 'node:crypto'

/**
 * Full-width vertical line U+FF5C.
 *
 * The model writes `｜` (U+FF5C), not the ASCII `|` this source is typed with.
 * They are near-identical in most fonts, which is why every pattern here is
 * built from this constant: a hand-typed `|` would simply never match, and a
 * matcher that never matches is indistinguishable from a clean result.
 */
export const FULLWIDTH_BAR = '\uff5c'

/**
 * The marker's reference spelling — doubled bars, `｜｜DSML｜｜`.
 *
 * Kept as the form documentation and callers quote. It is NOT the only legal
 * spelling: the bar count is a variable, not part of the token (measured on
 * this project's own transcript, five spellings appeared in a single block).
 * Matching must go through {@link MARKUP_RE}.
 */
export const MARKUP_TOKEN = `${FULLWIDTH_BAR}${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}${FULLWIDTH_BAR}`

/** One or two full-width bars — the count is a spelling variable. */
const BARS = `${FULLWIDTH_BAR}${FULLWIDTH_BAR}?`

/**
 * The marker in any spelling, global (callers reset `lastIndex`).
 *
 * @see FULLWIDTH_BAR for why this is built rather than typed.
 */
export const MARKUP_RE = new RegExp(`${BARS}DSML${BARS}`, 'g')

/**
 * Spellings a tag may carry before its name, longest first so the doubled form
 * is consumed before the single one can match its prefix.
 *
 * The ASCII spellings are accepted because the model mixes them: the marker is
 * normalised to ASCII by {@link normalizedPrefixLength}, which is also the only
 * way to catch a block that spells the two sides differently.
 */
const MARKUP_PREFIXES: readonly string[] = [
  `${FULLWIDTH_BAR}${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}${FULLWIDTH_BAR}`,
  '||DSML||',
  '|DSML|',
]

/** What the full-width marker looks like after {@link normalizedPrefixLength}. */
const ASCII_PREFIXES: readonly string[] = ['||DSML||', '|DSML|']

/**
 * Tag names that can OPEN a block worth recovering.
 *
 * Deliberately tiny. `parameter` and the model's ad-hoc tag names are NOT here:
 * they only ever appear inside a block, so treating one as a block start would
 * hold a response hostage waiting for a close that naming never promised.
 */
const BLOCK_TAGS: readonly string[] = ['tool_calls', 'invoke']

/**
 * Tag names whose content belongs to the markup rather than to the answer.
 *
 * Used by {@link stripMarkup} to decide whether removing a marker-bearing tag
 * should also remove everything up to its matching close. An INVENTED name is
 * not here on purpose: `<｜DSML｜ validate>` brackets nothing, so removing it
 * means removing the tag and nothing else.
 */
const KEYWORD_TAGS: readonly string[] = ['tool_calls', 'tool-calls', 'toolcalls', 'invoke', 'parameter', 'calls', 'tool']

/** Tag names normalised to their canonical spelling. */
const CANONICAL_TAG_NAMES: ReadonlyMap<string, string> = new Map([
  ['tool_calls', 'tool_calls'],
  ['tool-calls', 'tool_calls'],
  ['toolcalls', 'tool_calls'],
  ['invoke', 'invoke'],
  ['parameter', 'parameter'],
])

/**
 * Canonical names accepted ONLY in a marker form.
 *
 * `<toolcalls>` without the marker is somebody's HTML, not the model's markup;
 * the marker is what makes the misspelling meaningful.
 */
const MARKER_ONLY_TAG_NAMES: ReadonlySet<string> = new Set(['tool-calls', 'toolcalls'])

/** Fence markers at the start of a line. */
const FENCE_MARKERS: readonly string[] = ['```', '~~~']

/** A half-open span of text that is not markup: fences, code spans, CDATA, comments, PIs. */
interface IgnoredSpan {
  start: number
  end: number
  /** True when the span never closed — it runs to end-of-text because the closer has not arrived. */
  open: boolean
}

/** One scanned tag. */
interface MarkupTag {
  /** Index of the `<`. */
  start: number
  /** Index of the closing `>`. */
  end: number
  /** Canonical name, lowercased. */
  name: string
  closing: boolean
  selfClosing: boolean
  /** True when a marker prefix preceded the name. */
  marked: boolean
  /** Raw attribute text between the name and the closing `>`. */
  attributes: string
}

/** A tool call recovered from markup, in the ONE shape this module produces. */
export interface RecoveredToolCall {
  id: string
  name: string
  /** JSON-encoded arguments object, ready to drop into `function.arguments`. */
  arguments: string
}

/**
 * What this request allows recovery to produce.
 *
 * Constructed by the caller from the prepared request body — see
 * `declaredTools()` in `src/upstream.ts`. An empty {@link declaredNames} is not
 * an error: it is gate 3, and it makes every parse return nothing.
 */
export interface RecoveryGate {
  /** Tool names this request offered. Empty means recovery is off (gate 3). */
  declaredNames: ReadonlySet<string>
  /**
   * Required parameter names per tool, from each tool's JSON schema.
   *
   * Gate 4's second half: a declared tool whose required parameter is missing
   * from the parsed block is a truncated call, not a call.
   */
  requiredParameters?: ReadonlyMap<string, readonly string[]>
  /**
   * A `tool_choice` pinned to one function name, if the request pinned one.
   *
   * `prepareChatBody` rewrites `{type:'function',function:{name}}` into the
   * bare name, so a string that is not `auto`/`required`/`none` here means the
   * caller asked for exactly that tool and nothing else may be recovered.
   */
  pinnedToolName?: string
}

/** What one {@link DsmlStreamBuffer.add} call produced. */
export interface BufferOutcome {
  /** Text safe to forward. */
  text: string
  /** Calls committed by this chunk, if any. */
  calls?: RecoveredToolCall[]
  /**
   * True when {@link text} carries ordinary content — anything outside a
   * markup block. The caller uses this to decide that the response is a real
   * answer and to stop waiting for a possible retry.
   *
   * False means "markup residue only", which is what makes the
   * retry-when-the-turn-produced-nothing rule checkable rather than guessed.
   */
  prose: boolean
}

// ---------------------------------------------------------------------------
// Ignored regions
// ---------------------------------------------------------------------------

/**
 * Find every span that must not be scanned for markup.
 *
 * One pass, not a predicate call per character: the reference asks
 * `is_inside_markdown_fence(text, i)` inside a per-character loop, which is
 * quadratic in the size of the buffer. The buffer holds a whole block, and a
 * block can be large (a file's worth of arguments), so the port computes the
 * spans once and walks them.
 *
 * Semantics match the reference: fences only count at the start of a line,
 * code spans are runs of one or two backticks, and an unterminated span runs to
 * the end of the text (the closer may still be in flight).
 */
function ignoredSpans(text: string): IgnoredSpan[] {
  const spans: IgnoredSpan[] = []
  let i = 0
  let fence: string | undefined
  let fenceStart = 0

  while (i < text.length) {
    const atLineStart = i === 0 || text.charAt(i - 1) === '\n'

    if (fence !== undefined) {
      if (atLineStart && text.startsWith(fence, i)) {
        const lineEnd = text.indexOf('\n', i)
        const end = lineEnd === -1 ? text.length : lineEnd + 1
        spans.push({ start: fenceStart, end, open: false })
        fence = undefined
        i = end
        continue
      }
      i += 1
      continue
    }

    if (atLineStart) {
      const marker = FENCE_MARKERS.find(candidate => text.startsWith(candidate, i))
      if (marker !== undefined) {
        fence = marker
        fenceStart = i
        i += marker.length
        continue
      }
    }

    if (text.charAt(i) === '`') {
      const end = codeSpanEnd(text, i)
      if (end === -1) {
        spans.push({ start: i, end: text.length, open: true })
        break
      }
      spans.push({ start: i, end, open: false })
      i = end
      continue
    }

    const xml = xmlIgnoredEnd(text, i)
    if (xml !== undefined) {
      spans.push(xml)
      if (xml.end >= text.length && xml.open) break
      i = xml.end
      continue
    }

    i += 1
  }

  if (fence !== undefined) spans.push({ start: fenceStart, end: text.length, open: true })
  return spans
}

/**
 * End of the inline code span starting at `start`, or -1 when there is none.
 *
 * Three or more backticks are a fence, not a code span — {@link ignoredSpans}
 * handles those, and conflating the two is how a fence's opening ticks get
 * mistaken for an unclosed inline span.
 */
function codeSpanEnd(text: string, start: number): number {
  let ticks = 0
  let i = start
  while (i < text.length && text.charAt(i) === '`') {
    ticks += 1
    i += 1
  }
  if (ticks === 0 || ticks >= 3) return -1

  let end = i
  while (end < text.length) {
    if (text.charAt(end) !== '`') {
      end += 1
      continue
    }
    let closingTicks = 0
    let j = end
    while (j < text.length && text.charAt(j) === '`') {
      closingTicks += 1
      j += 1
    }
    if (closingTicks === ticks) return j
    end = j
  }
  return -1
}

/** CDATA / comment / processing instruction at `index`, if one starts there. */
function xmlIgnoredEnd(text: string, index: number): IgnoredSpan | undefined {
  const forms: ReadonlyArray<readonly [string, string]> = [
    ['<![CDATA[', ']]>'],
    ['<!--', '-->'],
    ['<?', '?>'],
  ]
  for (const [open, close] of forms) {
    if (!text.startsWith(open, index)) continue
    const found = text.indexOf(close, index + open.length)
    if (found === -1) return { start: index, end: text.length, open: true }
    return { start: index, end: found + close.length, open: false }
  }
  return undefined
}

/**
 * Index just past the ignored span containing `index`, or `index` unchanged.
 *
 * `cursor` is a hint into the sorted span list; callers that walk positions in
 * order get O(1) amortised lookup, which is why the parameter exists.
 */
function skipIgnored(spans: readonly IgnoredSpan[], index: number, cursor: { at: number }): number {
  while (cursor.at < spans.length) {
    const span = spans[cursor.at]
    if (span === undefined || index < span.start) return index
    if (index < span.end) return span.end
    cursor.at += 1
  }
  return index
}

// ---------------------------------------------------------------------------
// Tag scanning
// ---------------------------------------------------------------------------

/**
 * Length of the marker prefix at `index`, or 0 when none is there.
 *
 * Two passes on purpose. The literal spellings are tried first; then the text
 * is normalised character by character, which is the only way to recognise a
 * block that mixes the two bar styles — and mixing is normal: one captured
 * emission spelled the opening tags with single bars and the closer with double.
 */
function prefixLengthAt(text: string, index: number): number {
  for (const prefix of MARKUP_PREFIXES) {
    if (text.startsWith(prefix, index)) return prefix.length
  }

  // The longest spelling is 8 characters, the shortest 7.
  const normalized = normalizeFullwidth(text.slice(index, index + 8))
  for (const prefix of ASCII_PREFIXES) {
    if (normalized.startsWith(prefix)) return prefix.length
  }
  return 0
}

/** Is a single character usable inside a tag name? Mirrors Python's `isalnum()`. */
function isNameCharacter(text: string, index: number): boolean {
  return /[\p{L}\p{N}_-]/u.test(text.charAt(index))
}

/** Read a tag name at `index` (after any marker prefix). */
function readName(text: string, index: number): { name: string; end: number; marked: boolean } {
  const prefixLength = prefixLengthAt(text, index)
  const marked = prefixLength > 0
  let position = index + prefixLength
  // Whitespace is allowed between the marker and the name, and the shape this
  // project actually captured needs it: `<｜DSML｜ validate>` — the space is
  // there because `validate` (the tool name) was written where `invoke name="…"`
  // belongs. Without this skip the tag is not recognised at all, so it is not
  // classified as markup, and the retry rule stops firing for the one leak it
  // was written for.
  while (position < text.length && /\s/.test(text.charAt(position))) position += 1
  const start = position
  while (position < text.length && isNameCharacter(text, position)) position += 1
  if (position === start) return { name: '', end: index, marked }
  return { name: text.slice(start, position).toLowerCase(), end: position, marked }
}

/**
 * Scan a tag at `index`, or nothing when there is not one.
 *
 * Any name is accepted (the model invents parameter tags freely); only the ones
 * in {@link CANONICAL_TAG_NAMES} are normalised, and the misspellings are
 * normalised only in a marker form — `<toolcalls>` alone is somebody's HTML.
 */
function scanTag(text: string, index: number): MarkupTag | undefined {
  if (text.charAt(index) !== '<') return undefined
  let position = index + 1

  let closing = false
  if (text.charAt(position) === '/') {
    closing = true
    position += 1
  }
  while (position < text.length && /\s/.test(text.charAt(position))) position += 1

  const read = readName(text, position)
  if (read.name === '') return undefined

  const canonical = CANONICAL_TAG_NAMES.get(read.name)
  const name = canonical !== undefined && !(MARKER_ONLY_TAG_NAMES.has(read.name) && !read.marked)
    ? canonical
    : read.name

  const attributesStart = read.end
  let selfClosing = false
  let cursor = read.end
  while (cursor < text.length) {
    const character = text.charAt(cursor)
    if (character === '>') {
      return {
        start: index,
        end: cursor,
        name,
        closing,
        selfClosing,
        marked: read.marked,
        attributes: text.slice(attributesStart, cursor).trim(),
      }
    }
    if (character === '/' && text.charAt(cursor + 1) === '>') {
      selfClosing = true
      return {
        start: index,
        end: cursor + 1,
        name,
        closing,
        selfClosing,
        marked: read.marked,
        attributes: text.slice(attributesStart, cursor).trim(),
      }
    }
    cursor += 1
  }
  return undefined
}

/** The next markup tag outside every ignored span, at or after `from`. */
function findTag(text: string, spans: readonly IgnoredSpan[], from: number): MarkupTag | undefined {
  const cursor = { at: 0 }
  let index = Math.max(from, 0)
  while (index < text.length) {
    const skipped = skipIgnored(spans, index, cursor)
    if (skipped !== index) {
      index = skipped
      continue
    }
    if (text.charAt(index) === '<') {
      const tag = scanTag(text, index)
      if (tag !== undefined) return tag
    }
    index += 1
  }
  return undefined
}

/**
 * The close tag matching `open`, or nothing when it has not arrived yet.
 *
 * Depth counting so a nested block of the same name cannot terminate its parent
 * early. This is gate 1's teeth: no close, no call.
 */
function findMatchingClose(text: string, spans: readonly IgnoredSpan[], open: MarkupTag): MarkupTag | undefined {
  let depth = 1
  let index = open.end + 1
  while (index < text.length) {
    const tag = findTag(text, spans, index)
    if (tag === undefined) return undefined
    if (tag.name === open.name) {
      if (tag.closing) {
        depth -= 1
        if (depth === 0) return tag
      } else if (!tag.selfClosing) {
        depth += 1
      }
    }
    index = tag.end + 1
  }
  return undefined
}

/**
 * The first block-opening tag in `text`, with its close when one has arrived.
 *
 * The close is OPTIONAL on purpose, and the two callers need it differently:
 * the buffer holds from `open` while it is missing (gate 1 — the block may
 * still complete), whereas parsing already-complete text stops rather than
 * correcting a broken block and then trusting what follows it.
 */
function findFirstOpener(text: string, spans: readonly IgnoredSpan[]): { open: MarkupTag; close?: MarkupTag } | undefined {
  let index = 0
  while (index < text.length) {
    const tag = findTag(text, spans, index)
    if (tag === undefined) return undefined
    if (!tag.closing && BLOCK_TAGS.includes(tag.name)) {
      const close = findMatchingClose(text, spans, tag)
      return close === undefined ? { open: tag } : { open: tag, close }
    }
    index = tag.end + 1
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Attributes and parameters
// ---------------------------------------------------------------------------

/** Decode the five predefined XML entities plus numeric references. */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  const named: ReadonlyMap<string, string> = new Map([
    ['amp', '&'],
    ['lt', '<'],
    ['gt', '>'],
    ['quot', '"'],
    ['apos', "'"],
  ])
  return text.replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body.charAt(1).toLowerCase() === 'x'
      const digits = hex ? body.slice(2) : body.slice(1)
      const code = Number.parseInt(digits, hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      return String.fromCodePoint(code)
    }
    return named.get(body.toLowerCase()) ?? whole
  })
}

/** `name="value"` / `name='value'` pairs, entities decoded. */
function parseAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([a-z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
  let match = pattern.exec(text)
  while (match !== null) {
    const key = match[1]
    const value = match[2] ?? match[3]
    if (key !== undefined && value !== undefined) attributes[key] = decodeEntities(value)
    match = pattern.exec(text)
  }
  return attributes
}

/** A parsed parameter value: either text or a nested object. */
type ParameterValue = string | Record<string, unknown>

/**
 * Parse the parameters inside one block body.
 *
 * Two shapes, in the order the model prefers them:
 *   - `<｜DSML｜parameter name="cmd">value</…parameter>` (the explicit form);
 *   - `<cmd>value</cmd>` (the tag name IS the parameter name), used only when
 *     the explicit form has not already claimed that name — otherwise a nested
 *     tag echoing it would overwrite the real value.
 *
 * A `CDATA` body is taken verbatim; everything else is entity-decoded.
 *
 * Every scanner here computes its ignored spans from the string it is about to
 * scan. Span offsets are only meaningful against the text they were measured
 * on, and a body is a substring of its parent — reusing the parent's offsets
 * would misplace every fence and silently turn "quoted markup" into "called
 * markup", which is gate 4's worst failure. Each of these strings is small, so
 * recomputing is cheaper than passing a coordinate system around.
 */
function parseParameters(body: string): Record<string, ParameterValue> {
  const parameters: Record<string, ParameterValue> = {}
  const spans = ignoredSpans(body)
  let index = 0

  while (index < body.length) {
    const tag = findTag(body, spans, index)
    if (tag === undefined) break
    if (tag.closing || tag.selfClosing) {
      index = tag.end + 1
      continue
    }

    const close = findMatchingClose(body, spans, tag)
    if (close === undefined) {
      index = tag.end + 1
      continue
    }

    const value = body.slice(tag.end + 1, close.start).trim()
    const attributes = parseAttributes(tag.attributes)
    const explicitName = tag.name === 'parameter' ? attributes['name'] : undefined
    const name = explicitName ?? tag.name

    if (name !== undefined && name !== '' && (explicitName !== undefined || parameters[name] === undefined)) {
      parameters[name] = value.startsWith('<![CDATA[') && value.endsWith(']]>')
        ? value.slice(9, -3)
        : nestedOrText(value)
    }

    index = close.end + 1
  }

  return parameters
}

/** A value that itself contains a complete tag pair is a nested object. */
function nestedOrText(value: string): ParameterValue {
  if (!value.includes('<') || !value.includes('>')) return decodeEntities(value)
  const nested = parseParameters(value)
  return Object.keys(nested).length > 0 ? nested : decodeEntities(value)
}

// ---------------------------------------------------------------------------
// Gates and the public parse entry
// ---------------------------------------------------------------------------

/**
 * One block's worth of text → the calls it declares, or nothing.
 *
 * This is where gates 2 and 4 live. Returning nothing is the COMMON case for
 * mistaken input and is not an error: callers must show the block verbatim.
 */
function parseBlock(block: string, gate: RecoveryGate): RecoveredToolCall[] {
  const calls: RecoveredToolCall[] = []
  const spans = ignoredSpans(block)
  let index = 0

  while (index < block.length) {
    const tag = findTag(block, spans, index)
    if (tag === undefined) break
    if (!tag.closing && tag.name === 'invoke') {
      const close = findMatchingClose(block, spans, tag)
      if (close === undefined) break
      const call = parseInvoke(tag, close, block, gate)
      if (call !== undefined) calls.push(call)
      index = close.end + 1
      continue
    }
    index = tag.end + 1
  }

  return calls
}

/** One `<invoke>` element → a call, or nothing when a gate refuses it. */
function parseInvoke(
  open: MarkupTag,
  close: MarkupTag,
  block: string,
  gate: RecoveryGate,
): RecoveredToolCall | undefined {
  const attributes = parseAttributes(open.attributes)
  const name = attributes['name']
  if (name === undefined || name === '') return undefined

  // Gate 2: a name the request never offered is not a call we may invent.
  if (!gate.declaredNames.has(name)) return undefined

  // Gate 2, pinned form: the caller asked for one tool by name.
  const pinned = gate.pinnedToolName
  if (pinned !== undefined && pinned !== 'auto' && pinned !== 'required' && pinned !== 'none' && pinned !== name) {
    return undefined
  }

  const parameters = parseParameters(block.slice(open.end + 1, close.start))

  // Gate 4: a declared tool missing a required parameter is a truncated call.
  const required = gate.requiredParameters?.get(name)
  if (required !== undefined && required.some(parameter => parameters[parameter] === undefined)) return undefined

  return {
    id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    name,
    arguments: JSON.stringify(parameters),
  }
}

/**
 * Every call declared by `text`, or an empty list when nothing passes the gates.
 *
 * Stops at the first opener that never closes rather than stepping over it: a
 * broken block means the text after it cannot be trusted to be a separate
 * block, and guessing past it is exactly the eager-recovery mistake this
 * module's gates exist to prevent.
 *
 * @param text  A complete block (or any text containing one).
 * @param gate  What this request allows; see {@link RecoveryGate}.
 */
export function parseToolCalls(text: string, gate: RecoveryGate): RecoveredToolCall[] {
  // Gate 3, enforced here as well as by the caller: with nothing declared,
  // there is no name this parse could legitimately accept.
  if (gate.declaredNames.size === 0) return []

  const calls: RecoveredToolCall[] = []
  let remaining = text

  // One response can carry several blocks, and all of them are recovered.
  while (remaining !== '') {
    const found = findFirstOpener(remaining, ignoredSpans(remaining))
    if (found === undefined || found.close === undefined) break
    calls.push(...parseBlock(remaining.slice(found.open.start, found.close.end + 1), gate))
    remaining = remaining.slice(found.close.end + 1)
  }

  return calls
}

/**
 * `text` with every markup block removed — the check behind {@link hasProse}.
 *
 * ANY marker-bearing tag counts as markup, whatever it is called. Keying on the
 * known names alone was the first attempt and it got the one shape this project
 * has actually captured wrong: `<｜DSML｜ validate>` carries an invented name
 * (`validate` is the TOOL name, written where `invoke name="…"` belongs), so a
 * keyword-only rule left it standing, the response was classified as prose, and
 * the retry-when-the-turn-produced-nothing rule could never fire for the very
 * leak it was written for — a check that never fires, which is the trap this
 * project has already paid for twice.
 *
 * Removal reaches the matching close only for names that bracket content
 * ({@link KEYWORD_TAGS}); an invented name removes just its own tag, because
 * nothing says it opens anything.
 *
 * Ignored spans are KEPT: a fenced or back-ticked quotation of the marker is
 * prose, and the rule is explicitly about a turn that produced nothing usable.
 */
export function stripMarkup(text: string): string {
  const spans = ignoredSpans(text)
  const cursor = { at: 0 }
  let result = ''
  let index = 0

  while (index < text.length) {
    const skipped = skipIgnored(spans, index, cursor)
    if (skipped !== index) {
      result += text.slice(index, skipped)
      index = skipped
      continue
    }
    const tag = text.charAt(index) === '<' ? scanTag(text, index) : undefined
    if (tag === undefined || !tag.marked) {
      result += text.charAt(index)
      index += 1
      continue
    }
    const bracketed = !tag.closing && !tag.selfClosing && KEYWORD_TAGS.includes(tag.name)
    const close = bracketed ? findMatchingClose(text, spans, tag) : undefined
    index = close === undefined ? tag.end + 1 : close.end + 1
  }

  return result
}

/**
 * Does `text` carry content outside markup blocks?
 *
 * This is what makes "the turn produced nothing usable" a checkable fact rather
 * than a guess: a response whose only content is markup residue returns false,
 * and the caller may then consider a single retry. Text inside a fence or code
 * span counts as content — a documented quotation of the marker is prose.
 */
export function hasProse(text: string): boolean {
  return stripMarkup(text).trim() !== ''
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * Which of `text`'s tail must wait for more bytes.
 *
 * Two reasons to hold, and only these two:
 *   - the tail starts a tag that is not closed yet, and could still turn out to
 *     be a block opener (`…<｜DSML｜inv`), so committing it as text would make
 *     the block unparseable;
 *   - the tail opens a code span whose closer is still in flight, because
 *     whether the following markup is *quoted* depends on that span.
 *
 * Anything else is emitted immediately. In particular a COMPLETE tag that is
 * not a block opener — `<｜DSML｜ validate>`, the shape this project actually
 * captured — is not held: it is prose as far as this layer is concerned, and
 * holding it would delay every ordinary answer that mentions the markup.
 */
function holdFrom(text: string, spans: readonly IgnoredSpan[]): number {
  let hold = text.length

  const lastLt = text.lastIndexOf('<')
  if (lastLt !== -1 && looksLikeTagStart(text.slice(lastLt))) hold = Math.min(hold, lastLt)

  for (const span of spans) {
    if (span.open) hold = Math.min(hold, span.start)
  }

  return hold
}

/**
 * Could this fragment be the beginning of a block-opening tag?
 *
 * Conservative by construction: it requires an unterminated `<`, and after
 * stripping an optional `/`, whitespace and marker, the remainder must be a
 * prefix of (or extend) a known opener. That is what keeps `a < b`, `<50%` and
 * `i < n` in ordinary prose from stalling a stream — each of them either
 * contains a `>` or fails the opener test.
 *
 * A marker that is STILL ARRIVING also holds (`<｜`, `<｜DSML`, `||D`). Without
 * that case the leading `<｜` is emitted as text the moment it arrives, and the
 * block can never be recovered afterwards because its opening tag has already
 * been split in two — a byte-by-byte feed is how this was found, and the
 * reference implementation has the same hole.
 */
function looksLikeTagStart(tail: string): boolean {
  if (!tail.startsWith('<')) return false
  if (tail.includes('>')) return false

  let body = tail.slice(1)
  if (body.startsWith('/')) body = body.slice(1)
  if (body === '' || isPartialMarker(body)) return true

  const prefixLength = prefixLengthAt(body, 0)
  body = body.slice(prefixLength).trim().toLowerCase()
  if (body === '' || isPartialMarker(body)) return true

  const openers = ['tool', 'invoke', 'tool_calls', 'tool-calls', 'toolcalls', 'tool_call', 'tool-call']
  return openers.some(opener => opener.startsWith(body) || body.startsWith(opener))
}

/**
 * Is this the start of a marker whose remainder has not arrived yet?
 *
 * Compared both literally and full-width-normalised, because the model mixes
 * the two bar styles and a mixture splits at an unpredictable character.
 */
function isPartialMarker(body: string): boolean {
  const trimmed = body.trimStart()
  if (trimmed === '') return true
  const forms = [...MARKUP_PREFIXES, ...ASCII_PREFIXES]
  const candidates = [trimmed, normalizeFullwidth(trimmed.slice(0, 8))]
  return candidates.some(candidate => candidate !== ''
    && forms.some(form => form.startsWith(candidate) && candidate.length < form.length))
}

/** Full-width ASCII (U+FF01..U+FF5E) mapped to its ASCII counterpart. */
function normalizeFullwidth(text: string): string {
  let normalized = ''
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    normalized += code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : character
  }
  return normalized
}

/**
 * Buffers `delta.content` and commits a call only when the block that declares
 * it is complete.
 *
 * Ported from the reference's `ToolCallStreamBuffer` with its hard-won
 * behaviour intact:
 *
 *   - a block with no close tag yet holds the ENTIRE block (not a partial
 *     guess), and only the tail that could still become a tag is held back
 *     from otherwise-finished text;
 *   - a block that fails the gates is emitted VERBATIM (gate 4), not dropped;
 *   - {@link flush} hands back whatever is still held, so a truncated block
 *     loses none of its text.
 *
 * The reference's own comment explains why the tail rule is not "hold
 * everything from the first `<`": an architecture document that shows
 * `<tool_calls><invoke>` as an EXAMPLE would otherwise starve the rest of the
 * response until the stream ended, and then lose it.
 */
export class DsmlStreamBuffer {
  private pending = ''
  private readonly gate: RecoveryGate

  constructor(gate: RecoveryGate) {
    this.gate = gate
  }

  /** Feed one `delta.content` chunk; returns text and any call it completed. */
  add(chunk: string): BufferOutcome {
    this.pending += chunk
    const parts: string[] = []
    const calls: RecoveredToolCall[] = []

    // Gate 3 is enforced by the caller (and again inside parseToolCalls), so a
    // disabled buffer simply forwards bytes.
    if (this.gate.declaredNames.size === 0) {
      const text = this.pending
      this.pending = ''
      return { text, prose: hasProse(text) }
    }

    for (;;) {
      const found = findFirstOpener(this.pending, ignoredSpans(this.pending))
      if (found === undefined) break

      const head = this.pending.slice(0, found.open.start)
      if (head !== '') parts.push(head)

      // Gate 1: the close has not arrived, so nothing may be committed. The
      // whole block is held — emitting it now would make it unparseable when
      // the rest finally arrives.
      if (found.close === undefined) {
        this.pending = this.pending.slice(found.open.start)
        return finish(parts, calls)
      }

      const body = this.pending.slice(found.open.start, found.close.end + 1)
      const recovered = parseBlock(body, this.gate)
      if (recovered.length > 0) calls.push(...recovered)
      // Gate 4: refused, so the block is shown exactly as it arrived.
      else parts.push(body)

      this.pending = this.pending.slice(found.close.end + 1)
    }

    // Nothing committable left: emit everything except a tail that could still
    // turn into a tag, or that sits inside an unclosed code span.
    const hold = holdFrom(this.pending, ignoredSpans(this.pending))
    if (hold > 0) parts.push(this.pending.slice(0, hold))
    this.pending = this.pending.slice(hold)

    return finish(parts, calls)
  }

  /** End of stream: hand back everything still held, verbatim. */
  flush(): BufferOutcome {
    const text = this.pending
    this.pending = ''
    return { text, prose: hasProse(text) }
  }
}

/** Assemble one `add()` outcome without ever emitting a `calls: undefined` key. */
function finish(parts: readonly string[], calls: readonly RecoveredToolCall[]): BufferOutcome {
  const text = parts.join('')
  const outcome: BufferOutcome = { text, prose: hasProse(text) }
  if (calls.length > 0) outcome.calls = [...calls]
  return outcome
}
