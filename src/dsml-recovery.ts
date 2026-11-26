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
 *
 * `calls` is here because a REAL capture wrote the wrapper's closer that way.
 * See {@link CANONICAL_TAG_NAMES} for the defect that disagreement caused.
 */
const KEYWORD_TAGS: readonly string[] = ['tool_calls', 'tool-calls', 'toolcalls', 'invoke', 'parameter', 'calls', 'tool']

/**
 * Tag names normalised to their canonical spelling.
 *
 * WHY `calls` IS MAPPED HERE (issue #207). Pairing is decided by comparing the
 * NORMALISED names ({@link findMatchingClose}: `tag.name === open.name`), so a
 * closer spelled `calls` could never match an opener spelling `tool_calls`:
 * the block read as never closed, was held to end of stream, and gate 4 then
 * rolled the whole thing back into visible prose.
 *
 * That is not a hypothetical spelling. `docs/DSML-LEAK-RESEARCH.md` records a
 * REAL captured block whose closing tag is `</｜DSML｜｜ calls>` — the document
 * knew the closer could be abbreviated while this table did not. The two
 * spellings are also inconsistent WITHIN this file: {@link KEYWORD_TAGS}
 * already lists `calls`, because {@link stripMarkup} has to know it is markup,
 * while pairing did not. Two tables disagreeing about one spelling was the
 * whole defect.
 *
 * `git log -S"'calls', 'tool_calls'"` is empty: this mapping never existed, so
 * no release ever behaved differently.
 */
const CANONICAL_TAG_NAMES: ReadonlyMap<string, string> = new Map([
  ['tool_calls', 'tool_calls'],
  ['tool-calls', 'tool_calls'],
  ['toolcalls', 'tool_calls'],
  ['calls', 'tool_calls'],
  ['invoke', 'invoke'],
  ['parameter', 'parameter'],
])

/**
 * Canonical names accepted ONLY in a marker form.
 *
 * `<toolcalls>` without the marker is somebody's HTML, not the model's markup;
 * the marker is what makes the misspelling meaningful.
 *
 * `calls` belongs here for the same reason, and more strongly: it is an ordinary
 * English word that also appears in HTML (`<calls>`) and in prose about
 * telephones, so normalising a BARE `<calls>` would turn somebody's own text
 * into the model's protocol and start deleting what follows it.
 */
const MARKER_ONLY_TAG_NAMES: ReadonlySet<string> = new Set(['tool-calls', 'toolcalls', 'calls'])

/**
 * The protocol's OWN vocabulary — names the model never writes in prose.
 *
 * This is the trigger for bare-markup recovery (issue #298) and the reason it
 * is safe. A response whose `delta.content` carries tool calls with the marker
 * stripped still keeps the protocol's skeleton: the `tool_call` wrapper, the
 * `arg_key`/`arg_value` pair, a `parameter` element. Those words exist only
 * because the model was speaking the wire protocol.
 *
 * A TOOL NAME ALONE IS NOT ENOUGH, and that distinction is the whole design.
 * The two shapes below are ordinary prose about a tool, and both were
 * reproduced against the first version of this feature:
 *
 *     You can write <bash>ls -la</bash> to list files.
 *     Set <command> now and later.
 *
 * The first names a declared tool and brackets a plausible argument; the second
 * names a declared parameter. Recovering either would delete a sentence the
 * user wrote about the tool and replace it with a tool call they never asked
 * for — strictly worse than showing markup. Neither carries one of these words,
 * so neither is ever a candidate.
 */
const PROTOCOL_VOCABULARY: readonly string[] = [
  'tool_call', 'tool_calls', 'tool-call', 'tool-calls', 'toolcalls',
  'invoke', 'parameter', 'arg_key', 'arg_value', 'arguments',
]

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
   * Parameter names each declared tool accepts, from its JSON schema
   * (`properties`). Read by the schema-gated recovery below and by nothing
   * else; absent means "unknown", which refuses that recovery rather than
   * guessing.
   */
  acceptedParameters?: ReadonlyMap<string, ReadonlySet<string>>
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
  /**
   * Opt in to naming a call from its ARGUMENTS when the opener names no tool.
   *
   * Captured from `session-333b5f2d` (turns 8–10, 2026-10-18): the model wrote
   *
   *     <｜DSML｜ invoke>
   *     <｜DSML｜ parameter name="command">grep …</｜DSML｜ parameter>
   *     <｜DSML｜ parameter name="description">…</｜DSML｜ parameter>
   *     </｜DSML｜ invoke>
   *
   * with no `name` anywhere. Gate 2 cannot accept it there is no name to check,
   * and gate 4 correctly refused to invent one — so the user received the raw
   * markup as the answer, four times in one session.
   *
   * The recovery that fixes this does NOT invent a name either. It picks a
   * declared tool only when the evidence is the model's own: every parameter
   * tag the block carries is accepted by that tool's schema, every required
   * parameter is present, and exactly ONE declared tool satisfies both. Two
   * tools that fit, or an unknown parameter, or a missing schema: the block is
   * returned untouched, exactly as gate 4 says.
   *
   * Off unless the caller turns it on, and only ever consulted for a block
   * with NO opener attributes at all.
   */
  inferFromSchema?: boolean
  /**
   * Opt in to repairing a DECLARED name that differs from one declared tool by
   * a single-character edit (issue #152).
   *
   * Captured on 2026-10-27: the model wrote `name="pwdsh"` where the request
   * had offered `pwsh` — one inserted `d` between `pw` and `sh`. Gate 2 refused
   * it (correctly: the name was never on offer), so the whole block fell back
   * to plain text and the user read a wall of markup.
   *
   * WHY THIS IS NOT "GUESSING A NAME". The candidate set is the request's OWN
   * `body.tools`; a repair can only ever select a name that was already on
   * offer, and only when exactly one declared name is within one edit of the
   * written one. It never invents anything, and the pin in gate 2 still runs
   * on the repaired name — so a request pinned to another tool still refuses.
   *
   * The guards that make "one edit" safe rather than reckless:
   *
   *   - both names must be at least {@link NEAR_NAME_MIN_LENGTH} long, because
   *     short names collide trivially (`bash`/`dash` are 1 apart);
   *   - the written name must have NO exact match — an exact match always
   *     wins and is never "repaired" into a neighbour;
   *   - exactly one candidate may be within one edit, or nothing is returned;
   *   - only a DECLARED name is repaired. A block with no name at all keeps
   *     going to {@link inferFromSchema} (or stays refused), and parameter
   *     names are never touched — rewriting those would change what the call
   *     MEANS, which is a far worse failure than showing markup.
   *
   * Off unless the caller turns it on, so the default stays fail-closed.
   */
  repairNearMissName?: boolean
  /**
   * Opt in to recovering a block written with NO marker at all (issue #298).
   *
   * Captured in the wild: `delta.content` carried the whole call with not one
   * `｜｜DSML｜｜` in it, so `scanTag` classified every tag as prose, `stripMarkup`
   * deleted nothing, and `hasProse` answered true because a Chinese sentence
   * preceded the block — the user was handed the raw protocol as the answer.
   *
   *     <ask_user_question>
   *     <questions</arg_key><arg_value>[{"header":"…"}]</arg_value></tool_call>
   *
   * THE TRIGGER IS THE PROTOCOL'S OWN VOCABULARY, never a tool or parameter
   * name. See {@link PROTOCOL_VOCABULARY} for the two prose shapes that a
   * name-based rule deletes and this one cannot: a user explaining
   * `<bash>ls -la</bash>` produces a recoverable call under that rule, which is
   * a worse defect than the markup it fixes.
   *
   * OFF BY DEFAULT and byte-identical when off: `scanTag` still requires the
   * marker, so nothing about the existing path changes.
   */
  bareMarkup?: boolean
  /**
   * Called once per withheld block, when the stream declined to recover AND
   * declined to show what it found.
   *
   * A hook rather than a second return channel because the reason belongs to
   * the response, not the buffer: one notice per turn, whatever the number of
   * blocks. The plugin never throws through this — a diagnostic must not fail
   * a chat request.
   */
  onWithheld?: (reason: 'unnamed-invoke' | 'stray-markup') => void
}

/**
 * Shortest tool name a near-miss repair may act on (issue #152).
 *
 * Below this, "one edit apart" stops being evidence: `dash` and `bash` are one
 * edit apart, and so are any two four-letter names sharing a prefix. At 4 the
 * reported `pwsh` → `pwdsh` still qualifies (both are 4+), which is the shape
 * this exists for.
 */
const NEAR_NAME_MIN_LENGTH = 4

/**
 * Whether `a` and `b` are at most one edit apart (insertion, deletion, or
 * substitution).
 *
 * Only ever asked for a ceiling of 1, where the general Levenshtein matrix is
 * unnecessary: the lengths must differ by at most one, and after skipping the
 * first position where they differ, the remaining tails must still agree.
 *
 * The equal-length case is a SUBSTITUTION, not an insertion, so it is checked
 * separately — skipping the differing character on one side only would leave
 * tails of different length and silently miss every one-character typo of the
 * same length (`pwdsh`/`pwdss`, `bash`/`dash`), which is the whole point here.
 */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (long.length - short.length > 1) return false
  let i = 0
  while (i < short.length && short[i] === long[i]) i++
  if (short.length === long.length) {
    // Substitution: the single differing position is skipped on BOTH sides.
    return short.slice(i + 1) === long.slice(i + 1)
  }
  // Insertion/deletion: skip the extra character in the longer string only.
  return long.slice(i + 1) === short.slice(i)
}

/**
 * The one declared tool within a single edit of `written`, or `undefined`.
 *
 * Refuses when the name is already declared (nothing to repair), when either
 * side is shorter than {@link NEAR_NAME_MIN_LENGTH}, and when more than one
 * declared tool is in reach — ambiguity is exactly what gate 2 exists to stop.
 */
function nearMissNameFor(
  written: string,
  declaredNames: ReadonlySet<string>,
): string | undefined {
  if (declaredNames.has(written)) return undefined
  if (written.length < NEAR_NAME_MIN_LENGTH) return undefined
  let fit: string | undefined
  for (const candidate of declaredNames) {
    if (candidate.length < NEAR_NAME_MIN_LENGTH) continue
    if (!withinOneEdit(written, candidate)) continue
    if (fit !== undefined) return undefined
    fit = candidate
  }
  return fit
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
  /**
   * True when {@link text} WITHHELD something the model wrote: an unanswered
   * name-less `<｜DSML｜ invoke>` block, or a marker-bearing tag that was
   * dropped from otherwise-ordinary prose.
   *
   * This is not a recovery, and the caller must not treat it as one. It exists
   * because gate 4's "show it, do not hide it" rule only applies where the
   * block might be content a person would want (the `validate` shape, a
   * quotation). A partial invocation — parameters, no name — is a defect being
   * surfaced in the answer, not an answer, and the caller reports it as
   * {@link RecoveryGate.onWithheld} instead of printing the markup. See
   * `docs/DSML-RECOVERY-PLAN.md` §6 for the session that forced this split.
   */
  withheld: boolean
  /**
   * Why content was withheld, for the caller's notice. Only the FIRST reason
   * ever observed is kept: the user needs to know the turn was interfered
   * with, and repeating the same cause per block is noise.
   */
  withheldReason?: 'unnamed-invoke' | 'stray-markup'
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
function parseBlock(block: string, gate: RecoveryGate, seen: Withheld): {
  calls: RecoveredToolCall[]
  /**
   * True when this block held a refused invocation that named no tool AND there
   * was a listener to report it to — i.e. the caller must drop the block.
   *
   * Returned rather than re-derived by the caller. It used to be re-derived
   * (`isUnnamedInvoke(body)`), and the two disagreed on a block written without
   * a single newline: the body's first tag is then the `tool_calls` wrapper, so
   * the caller saw a named tag, printed the whole block, and *simultaneously*
   * reported "withheld" from in here — a notice for a removal that did not
   * happen. One judgement, one answer.
   */
  withheld: boolean
} {
  const calls: RecoveredToolCall[] = []
  let withheld = false
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
      // A complete invocation the gates refused AND that names no tool is not
      // something the model intended the user to read. It is either a defect
      // (see `inferFromSchema`) or, if unrecoverable, something to withhold and
      // report — never something to hand the user as an answer. Gate 4 still
      // shows every REFUSAL that carries a tool name, exactly as before.
      //
      // Only when a report can actually be delivered: the caller showing the
      // block instead is the safe outcome, and marking it withheld while
      // printing it would make the notice a lie.
      else if (tag.attributes.trim() === '' && gate.onWithheld !== undefined) {
        seen.reason ??= 'unnamed-invoke'
        withheld = true
      }
      index = close.end + 1
      continue
    }
    index = tag.end + 1
  }

  return { calls, withheld }
}

/** The first reason anything was withheld anywhere in one outcome. */
interface Withheld {
  reason?: 'unnamed-invoke' | 'stray-markup'
}

/** One `<invoke>` element → a call, or nothing when a gate refuses it. */
function parseInvoke(
  open: MarkupTag,
  close: MarkupTag,
  block: string,
  gate: RecoveryGate,
): RecoveredToolCall | undefined {
  const attributes = parseAttributes(open.attributes)
  const declared = attributes['name']
  const parameters = parseParameters(block.slice(open.end + 1, close.start))

  let name: string | undefined
  if (declared !== undefined && declared !== '') {
    // Gate 2: a name the request never offered is not a call we may invent.
    if (!gate.declaredNames.has(declared)) {
      // Issue #152: a name one character away from exactly one declared tool
      // (`pwdsh` for `pwsh`) is treated as that tool, but ONLY when the caller
      // opted in. The repair still cannot leave `declaredNames`, and the pin
      // below still runs on the repaired name.
      const repaired = gate.repairNearMissName === true
        ? nearMissNameFor(declared, gate.declaredNames)
        : undefined
      if (repaired === undefined) return undefined
      name = repaired
    } else {
      name = declared
    }
  } else if (open.attributes.trim() === '') {
    // No attributes at all — the shape the upstream produced in
    // session-333b5f2d. If the caller turned on `inferFromSchema`, the name is
    // read from the model's own evidence (its parameter tags) under the
    // request's schemas; anything less than certainty returns undefined and
    // the block keeps its gate-4 fate.
    name = inferNameFromSchema(parameters, gate)
    if (name === undefined) return undefined
  } else {
    // A name-bearing opener with an empty `name=""` is a refused call, not an
    // inference candidate: there is no parameter evidence that could repair it.
    return undefined
  }

  // Gate 2, pinned form: the caller asked for one tool by name.
  const pinned = gate.pinnedToolName
  if (pinned !== undefined && pinned !== 'auto' && pinned !== 'required' && pinned !== 'none' && pinned !== name) {
    return undefined
  }

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
 * Name a call from its ARGUMENTS when the opener names no tool — or refuse.
 *
 * The evidence is the model's own parameter tags; the constraint is the
 * request's schemas. A tool qualifies only when every tag the block carries is
 * accepted by its schema AND every required parameter is already present, and
 * exactly ONE declared tool qualifies. Everything less certain refuses:
 *
 *   - a block with no parameter tags at all (no evidence to read);
 *   - a tool whose schema is unknown here (it cannot be cleared — silence must
 *     not let an unverified tool win or lose);
 *   - a parameter no accepted set lists;
 *   - two tools that both fit ("the only tool on offer" was the whole point).
 */
function inferNameFromSchema(
  parameters: Record<string, ParameterValue>,
  gate: RecoveryGate,
): string | undefined {
  const tags = Object.keys(parameters)
  if (tags.length === 0) return undefined

  let fit: string | undefined
  for (const tool of gate.declaredNames) {
    const accepted = gate.acceptedParameters?.get(tool)
    if (accepted === undefined) return undefined
    if (tags.some(tag => !accepted.has(tag))) continue
    const required = gate.requiredParameters?.get(tool)
    if (required !== undefined && required.some(parameter => parameters[parameter] === undefined)) continue
    if (fit !== undefined) return undefined
    fit = tool
  }
  return fit
}

// ---------------------------------------------------------------------------
// Bare markup (issue #298)
// ---------------------------------------------------------------------------

/**
 * Is `name` one of the protocol's own words, in any spelling the model uses?
 *
 * Compared after lowercasing and with `-` folded to `_`, because the model
 * mixes `tool_call` / `tool-call` / `toolcall` freely.
 */
function isProtocolWord(name: string): boolean {
  const folded = name.toLowerCase().replace(/-/gu, '_')
  return PROTOCOL_VOCABULARY.some(word => word.replace(/-/gu, '_') === folded)
}

/**
 * A bare (unmarked) OPENING tag at `index`, or nothing.
 *
 * STRICTER THAN {@link scanTag} IN TWO WAYS, both load-bearing:
 *
 *   - the `<` must be followed IMMEDIATELY by `/`, a letter, or `_`. `scanTag`
 *     tolerates whitespace after `<` because the marker form needs it
 *     (`<｜DSML｜ invoke>` writes the tool name where `name="…"` belongs);
 *     tolerating it here would read `a < b and tool_call` as a tag.
 *   - the name must be a declared tool, a declared parameter, or protocol
 *     vocabulary — the caller decides, but a name outside all three is ordinary
 *     text and must never enter the recovery path.
 *
 * Closing tags are returned too: the truncated-key rule below needs `</arg_value>`
 * while its opener never arrived with a `>`.
 */
function scanBareTag(text: string, index: number): MarkupTag | undefined {
  if (text.charAt(index) !== '<') return undefined
  let position = index + 1
  let closing = false
  if (text.charAt(position) === '/') {
    closing = true
    position += 1
  }
  // The no-whitespace rule: `< tool_call>` is prose about the word.
  if (position >= text.length || !/[\p{L}_]/u.test(text.charAt(position))) return undefined

  const start = position
  while (position < text.length && isNameCharacter(text, position)) position += 1
  const name = text.slice(start, position).toLowerCase()
  if (name === '') return undefined

  const attributesStart = position
  let selfClosing = false
  let cursor = position
  while (cursor < text.length) {
    const character = text.charAt(cursor)
    if (character === '>') {
      return { start: index, end: cursor, name, closing, selfClosing, marked: false, attributes: text.slice(attributesStart, cursor).trim() }
    }
    if (character === '/' && text.charAt(cursor + 1) === '>') {
      return { start: index, end: cursor + 1, name, closing, selfClosing: true, marked: false, attributes: text.slice(attributesStart, cursor).trim() }
    }
    // A `<` before the `>` means this was never a tag: `a < b and c > d`.
    if (character === '<') return undefined
    cursor += 1
  }
  return undefined
}

/**
 * Is this bare name something the request itself put on offer?
 *
 * Three sources, all the caller's own data: a declared TOOL name (the wrapper
 * may be named after the tool), a declared PARAMETER name (argument tags), and
 * protocol vocabulary. Absent schemas refuse rather than permit.
 */
function isBareCandidate(name: string, gate: RecoveryGate): boolean {
  if (isProtocolWord(name)) return true
  if (gate.declaredNames.has(name)) return true
  for (const accepted of gate.acceptedParameters?.values() ?? []) {
    if (accepted.has(name)) return true
  }
  return false
}

/**
 * Does `text` carry protocol vocabulary in a BARE form?
 *
 * The gate for the whole feature. A response that merely mentions a tool name
 * in angle brackets — `<bash>ls</bash>`, `<command>` — carries none of these
 * words and is never considered. The vocabulary check is what separates "the
 * model spoke the protocol without the marker" from "the user wrote about a
 * tool", and it is deliberately about the protocol's own skeleton rather than
 * about anything the request declared.
 */
function hasBareProtocolWord(text: string): boolean {
  // QUOTED PROTOCOL VOCABULARY IS NOT EVIDENCE (review, safety). Every other
  // scanner in this file skips fences, code spans and quoted spans; this one did
  // not, and that asymmetry was exploitable:
  //
  //     You can write <ask_user_question><questions>hi</questions></ask_user_question> to ask.
  //     (The format uses `<arg_key>`.)
  //
  // `<arg_key>` inside backticks made this return true, the tool-named wrapper in
  // the FIRST sentence became the block start, and `stripBareBlock` cut the rest
  // of the paragraph — the output was `"You can write "`. A model explaining the
  // protocol is an ordinary thing to do, and deleting what it wrote is the one
  // outcome the module refuses on principle: visible debris beats lost content.
  //
  // Sharing `ignoredSpans` with the other scanners is what makes the trigger and
  // the block locator agree about which bytes count.
  const spans = ignoredSpans(text)
  const cursor = { at: 0 }
  for (let index = 0; index < text.length; index++) {
    index = skipIgnored(spans, index, cursor)
    if (index >= text.length) break
    if (text.charAt(index) !== '<') continue
    const tag = scanBareTag(text, index)
    if (tag !== undefined && isProtocolWord(tag.name)) return true
  }
  return false
}

/**
 * One bare block → a call, or nothing when any gate refuses it.
 *
 * THE WRAPPER NAMES THE TOOL when it is not protocol vocabulary: the captured
 * shape is `<ask_user_question>` — the tool name written where `<invoke
 * name="…">` belongs. Parameter evidence is `<arg_key>k</arg_key><arg_value>v</arg_value>`
 * pairs, which are the protocol's own spelling and are read here rather than
 * by {@link parseParameters} (that one expects `<parameter name="k">`).
 *
 * Gate 2 still runs on whatever name this resolves to, and gate 4 still
 * refuses a declared tool whose required parameter is missing — this function
 * INSPECTS a name, it never invents one.
 */
function parseBareBlock(block: string, gate: RecoveryGate): RecoveredToolCall | undefined {
  const spans = ignoredSpans(block)
  const first = findBareOpener(block, spans)
  if (first === undefined) return undefined

  // The name: protocol wrapper means "read the attributes / infer", a tool or
  // parameter name IS the tool.
  let name: string | undefined
  const attributes = parseAttributes(first.attributes)
  const declared = attributes['name']
  if (first.name === 'tool_call' || first.name === 'tool_calls' || first.name === 'tool-call'
    || first.name === 'tool-calls' || first.name === 'toolcalls' || first.name === 'invoke') {
    if (declared !== undefined && declared !== '') name = declared
  } else if (!isProtocolWord(first.name)) {
    name = first.name
  }
  if (name === undefined) return undefined
  // Gate 2: only a name this request offered.
  if (!gate.declaredNames.has(name)) return undefined
  const pinned = gate.pinnedToolName
  if (pinned !== undefined && pinned !== 'auto' && pinned !== 'required' && pinned !== 'none' && pinned !== name) {
    return undefined
  }

  // GATE 1, ENFORCED HERE (review): a bare block must be PROVEN COMPLETE before
  // its call is committed. Without this the truncated shape
  //
  //     <ask_user_question>\n<arg_key>questions</arg_key><arg_value>x</arg_value>
  //
  // — no closer anywhere, the stream simply ran out — produced a real call whose
  // arguments were a half-written JSON string. That is the accident gate 1 exists
  // for: executing a call the model never finished writing. Docs §14.4 and the
  // commit message both claimed "a cut-off block is shown as text", which was
  // only true for blocks that failed to PARSE, not for ones that parsed from a
  // partial stream.
  //
  // The closer may be the wrapper's own (`</ask_user_question>`), the protocol's
  // (`</tool_call>` / `</invoke>`, alternated freely by real responses), or — for
  // the truncated-key shape — nothing else is needed once a complete
  // `arg_value` pair closed. Accepting all three keeps the captured shapes
  // recoverable while refusing a stream that stopped mid-block.
  // ONE closer, computed once and reused as the parameter scope's upper bound.
  //
  // REVIEW: `parseBareParameters` used to scan to the END of the pending text,
  // not to the end of the block. Two bare blocks in one response were therefore
  // MERGED into a single call (`{"a":"1","b":"2"}`, the second call lost), and
  // prose after a block was absorbed as a parameter of it (`…</tool_call>` then
  // `To run it, use <b>2</b>.` became `{"a":"1","b":"2"}`). A wrong argument list
  // is the worst failure mode here: it deletes nothing visible, it EXECUTES the
  // wrong thing — for `bash`, a command the model never asked for.
  const closer = bareBlockClose(block, spans, first)
  if (closer === undefined) return undefined

  const parameters = parseBareParameters(block.slice(0, closer), spans, name, gate)
  if (parameters === undefined) return undefined

  const required = gate.requiredParameters?.get(name)
  if (required !== undefined && required.some(parameter => parameters[parameter] === undefined)) return undefined

  return {
    id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    name,
    arguments: JSON.stringify(parameters),
  }
}

/**
 * Index just past the tag that CLOSES the block opened by `opener`, or
 * `undefined` when no closer exists.
 *
 * The closer's name is NOT required to match the wrapper: real responses write
 * `<ask_user_question>` and close it with `</tool_call>`, which is the captured
 * shape itself. Any protocol wrapper name is accepted, and the EARLIEST match
 * wins so a following block is never swallowed.
 */
function bareBlockClose(
  text: string,
  spans: readonly IgnoredSpan[],
  opener: MarkupTag,
): number | undefined {
  const names = [opener.name, 'tool_call', 'tool_calls', 'tool-call', 'tool-calls', 'toolcalls', 'invoke']
  let best: number | undefined
  for (const name of names) {
    const close = findBareClose(text, spans, name, opener.end)
    if (close === undefined) continue
    // `MarkupTag.end` is the index OF the `>`, so the cursor past it is +1.
    const after = close.end + 1
    if (best === undefined || after < best) best = after
  }
  return best
}

/** The first bare opening tag that is a candidate for this request. */
function findBareOpener(text: string, spans: readonly IgnoredSpan[]): MarkupTag | undefined {
  const cursor = { at: 0 }
  let index = 0
  while (index < text.length) {
    const skipped = skipIgnored(spans, index, cursor)
    if (skipped !== index) { index = skipped; continue }
    if (text.charAt(index) === '<') {
      const tag = scanBareTag(text, index)
      if (tag !== undefined && !tag.closing) return tag
    }
    index += 1
  }
  return undefined
}

/**
 * Read `<arg_key>k</arg_key><arg_value>v</arg_value>` pairs, or `<k>v</k>`.
 *
 * THE TRUNCATED-KEY RULE (the fifth layer of #298): the captured shape ends
 * `<questions</arg_key><arg_value>[…]</arg_value></tool_call>` — the opener of
 * the LAST key never got its `>`, so no scanner can see the name. That key is
 * accepted ONLY when the tool's schema has exactly one required parameter still
 * missing and this pair is the last thing before the wrapper closes. With no
 * required list, or with more than one gap, the pair is refused and the block
 * keeps its verbatim fate: a guess here writes an argument the model never
 * named, which is worse than showing markup.
 */
function parseBareParameters(
  block: string,
  spans: readonly IgnoredSpan[],
  toolDisplay: string,
  gate: RecoveryGate,
): Record<string, ParameterValue> | undefined {
  const parameters: Record<string, ParameterValue> = {}
  const accepted = gate.acceptedParameters?.get(toolDisplay)
  const required = gate.requiredParameters?.get(toolDisplay) ?? []
  let truncatedKey: string | undefined
  let index = 0

  while (index < block.length) {
    const skipped = skipIgnored(spans, index, { at: 0 })
    if (skipped !== index) { index = skipped; continue }
    if (block.charAt(index) !== '<') { index += 1; continue }
    const tag = scanBareTag(block, index)
    if (tag === undefined) { index += 1; continue }
    if (tag.name === 'arg_key' && !tag.closing) {
      const close = findBareClose(block, spans, 'arg_key', tag.end + 1)
      if (close === undefined) {
        // The opener itself may be truncated (`<questions` with no `>`), which
        // scanBareTag rejects — handled by the regex probe below.
        index += 1
        continue
      }
      const key = block.slice(tag.end + 1, close.start).trim()
      // The value tag that must follow immediately.
      const valueTag = scanBareTag(block, skipWhitespace(block, close.end + 1))
      if (valueTag !== undefined && valueTag.name === 'arg_value' && !valueTag.closing) {
        const valueClose = findBareClose(block, spans, 'arg_value', valueTag.end + 1)
        if (valueClose !== undefined && key !== '') {
          parameters[key] = block.slice(valueTag.end + 1, valueClose.start).trim()
          index = valueClose.end + 1
          continue
        }
      }
      index = close.end + 1
      continue
    }
    if (tag.closing) { index = tag.end + 1; continue }
    // `<k>v</k>` form: only for names this request accepts for this tool.
    if (isProtocolWord(tag.name) || accepted === undefined || !accepted.has(tag.name)) {
      index = tag.end + 1
      continue
    }
    const close = findBareClose(block, spans, tag.name, tag.end + 1)
    if (close === undefined) { index = tag.end + 1; continue }
    parameters[tag.name] = block.slice(tag.end + 1, close.start).trim()
    index = close.end + 1
  }

  // Truncated key: `<name` with no `>` immediately before an arg_value pair.
  const truncated = /<([\p{L}\p{N}_-]+)(?=\s*<\/arg_key>)/u.exec(block)
  if (truncated?.[1] !== undefined) {
    const key = truncated[1].toLowerCase()
    // Only a name the schema accepts, and only when it is the sole gap.
    const known = accepted?.has(key) === true
    const gaps = required.filter(parameter => parameters[parameter] === undefined)
    if (known && gaps.length === 1 && gaps[0] === key) {
      const valueTag = afterTruncatedKeyValue(block, truncated.index + truncated[0].length)
      if (valueTag !== undefined) {
        parameters[key] = valueTag
        truncatedKey = key
      }
    }
  }
  void truncatedKey

  if (Object.keys(parameters).length === 0) return undefined
  return parameters
}

/** Skip whitespace forward, returning the next non-space index. */
function skipWhitespace(text: string, from: number): number {
  let index = from
  while (index < text.length && /\s/u.test(text.charAt(index))) index += 1
  return index
}

/** The bare close tag for `name` at or after `from`. */
function findBareClose(text: string, spans: readonly IgnoredSpan[], name: string, from: number): MarkupTag | undefined {
  const cursor = { at: 0 }
  let index = from
  while (index < text.length) {
    const skipped = skipIgnored(spans, index, cursor)
    if (skipped !== index) { index = skipped; continue }
    if (text.charAt(index) === '<') {
      const tag = scanBareTag(text, index)
      if (tag !== undefined && tag.closing && tag.name === name) return tag
    }
    index += 1
  }
  return undefined
}

/**
 * The `arg_value` payload that follows a truncated `</arg_key>`.
 *
 * Split out because the truncated opener has no tag to scan: the text runs
 * `<questions</arg_key><arg_value>…</arg_value>`, so the value is found by
 * looking for the NEXT `<arg_value>` element after that point.
 */
function afterTruncatedKeyValue(text: string, from: number): string | undefined {
  const open = text.indexOf('<arg_value>', from)
  if (open === -1) return undefined
  const close = text.indexOf('</arg_value>', open)
  if (close === -1) return undefined
  return text.slice(open + '<arg_value>'.length, close).trim()
}

/**
 * `text` with the first bare block REMOVED and everything around it kept.
 *
 * The block's own bytes carry no information for the reader — the call has been
 * delivered through the structured channel — so they go. What must NOT go is the
 * prose that follows the block.
 *
 * The first version cut at the block's START and dropped the remainder, on the
 * argument that the captured shape has no reliable end (`<ask_user_question>`
 * closed by `</tool_call>`). Review measured what that costs: a reply of
 *
 *     <ask_user_question>…</tool_call>\n结尾：以上是选项。
 *
 * lost 「结尾：以上是选项。」 — the model's own closing sentence, silently. Not
 * deleting the reader's content is the stronger rule here, so once gate 1
 * (a proven closer) holds, the END is known and only the span goes.
 */
function stripBareBlock(text: string, gate: RecoveryGate): string {
  const start = findBareBlockStart(text, gate)
  if (start === -1) return text
  const end = bareBlockEnd(text, start, gate)
  // No provable end: fall back to the old rule rather than guess a boundary and
  // splice unrelated prose into the answer.
  return end === -1 ? text.slice(0, start) : text.slice(0, start) + text.slice(end)
}

/**
 * Where the bare block starting at `start` ends (exclusive), or `-1`.
 *
 * A closer is accepted under the block's own name or any protocol wrapper name,
 * because real responses alternate the two — `<ask_user_question>` closed by
 * `</tool_call>` is the CAPTURED shape, not an anomaly.
 */
function bareBlockEnd(text: string, start: number, gate: RecoveryGate): number {
  const spans = ignoredSpans(text)
  const opener = findBareOpener(text.slice(start), ignoredSpans(text.slice(start)))
  if (opener === undefined) return -1
  const from = start + opener.end
  const names = [opener.name, 'tool_call', 'tool_calls', 'tool-call', 'tool-calls', 'toolcalls', 'invoke']
  let best = -1
  for (const name of names) {
    const close = findBareClose(text, spans, name, from)
    if (close === undefined) continue
    // `MarkupTag.end` is the index OF the `>`, so the cursor past the tag is +1.
    const after = close.end + 1
    if (best === -1 || after < best) best = after
  }
  return best
}

/**
 * Where the first bare CANDIDATE tag sits in `text`, or `-1`.
 *
 * Used only to decide how much to HOLD while a bare block may still be
 * arriving. Narrow on purpose: a candidate is a name this request put on offer
 * (declared tool, accepted parameter) or protocol vocabulary — the same three
 * sources {@link isBareCandidate} consults. A response that never names one
 * hands `-1` and is emitted immediately, so ordinary prose is not delayed.
 */
function firstBareCandidateAt(text: string, gate: RecoveryGate): number {
  const spans = ignoredSpans(text)
  const cursor = { at: 0 }
  let index = 0
  while (index < text.length) {
    const skipped = skipIgnored(spans, index, cursor)
    if (skipped !== index) { index = skipped; continue }
    if (text.charAt(index) === '<') {
      const tag = scanBareTag(text, index)
      if (tag !== undefined && !tag.closing && isBareCandidate(tag.name, gate)) return index
    }
    index += 1
  }
  return -1
}

/**
 * Where a BARE protocol block starts in `text`, or `-1`.
 *
 * Only protocol vocabulary opens a bare block — that is what keeps the call
 * path and the hold path in agreement about what they are looking at. A tool
 * name in angle brackets is deliberately NOT a start: `<bash>ls</bash>` is a
 * sentence, and holding it would starve the rest of the response for a block
 * that will never parse.
 */
function findBareBlockStart(text: string, gate: RecoveryGate): number {
  // Two conditions, both required, and their ORDER is what makes this safe:
  //   1. the response carries protocol vocabulary SOMEWHERE — that is the whole
  //      discriminator against `<bash>ls -la</bash>` in a sentence;
  //   2. the block starts at the first bare CANDIDATE tag, which for the
  //      captured shape is the tool-named wrapper `<ask_user_question>` — the
  //      protocol word (`arg_key`) appears INSIDE it, never before.
  if (!hasBareProtocolWord(text)) return -1
  const spans = ignoredSpans(text)
  const cursor = { at: 0 }
  let index = 0
  while (index < text.length) {
    const skipped = skipIgnored(spans, index, cursor)
    if (skipped !== index) { index = skipped; continue }
    if (text.charAt(index) === '<') {
      const tag = scanBareTag(text, index)
      if (tag !== undefined && !tag.closing && isBareCandidate(tag.name, gate)) return index
    }
    index += 1
  }
  return -1
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
  const seen: Withheld = {}
  let remaining = text

  // One response can carry several blocks, and all of them are recovered.
  while (remaining !== '') {
    const found = findFirstOpener(remaining, ignoredSpans(remaining))
    if (found === undefined || found.close === undefined) break
    calls.push(...parseBlock(remaining.slice(found.open.start, found.close.end + 1), gate, seen).calls)
    remaining = remaining.slice(found.close.end + 1)
  }

  // ISSUE #298: a block written with no marker at all. Gated on the request
  // opting in AND on the protocol's own vocabulary appearing here — a sentence
  // that merely mentions a tool name never reaches the parser.
  if (gate.bareMarkup === true && hasBareProtocolWord(text)) {
    const call = parseBareBlock(text, gate)
    if (call !== undefined) calls.push(call)
  }

  if (seen.reason !== undefined) gate.onWithheld?.(seen.reason)

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
 * Drop stray marker-bearing tags from otherwise-ordinary prose, and say so.
 *
 * This is the OTHER half of "the user must never see protocol debris": a block
 * is handled by {@link parseBlock} (recovered, withheld, or shown verbatim by
 * gate 4), but lone tags outside every block — `</｜DSML｜｜ calls>` closing a
 * wrapper whose opener belonged to a withheld call, `<｜DSML｜ validate>` —
 * arrive as plain text and used to be forwarded raw. They are markup, not the
 * answer: {@link stripMarkup} already knows exactly which bytes those are
 * (marker-bearing tags only, quoted ones inside fences and code spans kept),
 * so this runs it and records the removal. The record makes it reportable —
 * silence about removing content is the failure mode this whole module exists
 * to avoid.
 *
 * Gate 4's "show it verbatim" applies to BLOCKS (which may be content); a lone
 * marker tag has no content of its own to lose, only the name it wears.
 */
function stripStray(text: string, seen: Partial<Withheld>): string {
  const cleaned = stripMarkup(text)
  if (cleaned !== text) seen.reason ??= 'stray-markup'
  return cleaned
}

/**
 * Drop lone marker CLOSERS from a response that never opened a block
 * (issue #207).
 *
 * THE DEFECT. `stripStray` runs only behind {@link DsmlStreamBuffer.debris()},
 * and that flag means "this response WITHHELD a block". A response that never
 * opened one therefore never reached the sweep, so the shape below — captured
 * in the wild, and quoted verbatim in the issue — went out as prose:
 *
 * ```text
 * </｜DSML｜ parameter>
 * </｜DSML｜ invoke>
 * </｜DSML｜ calls>
 * ```
 *
 * The inconsistency was inside the module: {@link hasProse} already classified
 * those bytes as NON-prose (it goes through `stripMarkup`), so the classifier
 * said "residue" and the writer printed it.
 *
 * WHY PRESENCE, NOT DEPTH PAIRING. The first two attempts at this (both
 * recorded in the issue) counted depth by tag name, and both deleted the
 * CLOSER OF A BLOCK THAT WAS ONLY BEING SHOWN: a gate-4-refused block's opener
 * can be a forged name (`<｜DSML｜ validate>`), which by name never matches its
 * own `</｜DSML｜ calls>` closer, so the depth hit zero early. A presence flag
 * cannot make that mistake: if ANY marked opener appeared in the response, not
 * one lone closer is touched, and the whole gate-4 verbatim guarantee is kept.
 *
 * THE RESULT IS STRICTER THAN BEFORE, not looser. The old rule was "once a
 * block was withheld, delete every stray tag afterwards"; this one is "delete
 * nothing if any opener was ever seen". In the overlap — withheld block, then
 * lone tags — the old code deleted and this one does not.
 *
 * Fences and code spans are still skipped (through `stripMarkup`), because a
 * user asking what this markup means is quoting it on purpose.
 */
function stripLoneClosers(text: string, seen: Partial<Withheld>, openerSeen: boolean): string {
  if (openerSeen) return text
  const cleaned = stripMarkup(text)
  if (cleaned !== text) seen.reason ??= 'stray-markup'
  return cleaned
}

/**
 * Does `text` contain any MARKED OPENING tag, whatever it is called?
 *
 * The question behind issue #207's presence flag. Keyed on the marker rather
 * than on {@link BLOCK_TAGS}, because the shape that motivated it —
 * `<｜DSML｜ validate>` — wears an invented name and is not a block opener, yet
 * it opens a construct whose closer must survive.
 *
 * Scans outside fenced/inline-code spans, so a user quoting the markup inside a
 * code block does not set the flag (and therefore does not disable the cleaning
 * of real debris elsewhere in the same response).
 */
function hasMarkedOpener(text: string): boolean {
  const spans = ignoredSpans(text)
  const cursor = { at: 0 }
  let index = 0
  while (index < text.length) {
    const skipped = skipIgnored(spans, index, cursor)
    if (skipped !== index) {
      index = skipped
      continue
    }
    if (text.charAt(index) === '<') {
      const tag = scanTag(text, index)
      if (tag !== undefined && tag.marked && !tag.closing) return true
    }
    index += 1
  }
  return false
}

/**
 * Drop a marker-bearing tag fragment that the stream held and can never finish.
 *
 * {@link holdFrom} keeps back a tail that could still become a block opener, so
 * at end of stream that held tail is by construction an unterminated `<…`. Two
 * outcomes, and the difference is the marker:
 *
 *   - it carries the marker (`<｜DSM`, `</｜DSML｜ invo`): the marker is what
 *     makes it protocol debris rather than prose. Its close is never coming, so
 *     forwarding it hands the user half a tag — the `</｜DSML｜ invo` that
 *     trailed a killed stream. It goes, and says so.
 *   - it does not (`<`, `</`, `<tool`): a bare `<` is doubt, not evidence, and
 *     is kept. A person may have meant the character, and half a word is a
 *     worse lie than a stray bracket.
 *
 * Only the LAST `<` is examined. Everything before it was already cleared by
 * `holdFrom`, and an earlier `<` inside ordinary prose must not be dragged out
 * along with the fragment that happens to follow it.
 */
function dropUnfinishedMarkerTail(text: string, seen: Partial<Withheld>): string {
  const lastLt = text.lastIndexOf('<')
  if (lastLt === -1) return text
  if (!isLateMarkerFragment(text.slice(lastLt))) return text
  seen.reason ??= 'stray-markup'
  return text.slice(0, lastLt)
}

/**
 * Is this unterminated tag fragment a marker-bearing one?
 *
 * Deliberately narrow, for the same reason {@link looksLikeTagStart} is: it must
 * still be open (`>` never arrived, which is what "held at end of stream" means)
 * and, once the `<` and an optional `/` are stripped, the rest must BE a partial
 * marker or be a complete marker followed by a partial name. `<tool` fails the
 * second test and survives; so does `<`, which is not evidence of anything.
 */
function isLateMarkerFragment(tail: string): boolean {
  if (!tail.startsWith('<')) return false
  if (tail.includes('>')) return false

  let body = tail.slice(1)
  if (body.startsWith('/')) body = body.slice(1)
  if (body === '') return false

  // `<｜`, `<｜DSM`, `<|DSML|` — the marker itself is still arriving.
  if (isPartialMarker(body)) return true

  // `<｜DSML｜ invo` — the marker is complete, the name after it is not.
  const prefixLength = prefixLengthAt(body, 0)
  if (prefixLength === 0) return false
  return /^[A-Za-z_-]*$/.test(body.slice(prefixLength).trim())
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
function holdFrom(text: string, spans: readonly IgnoredSpan[], gate?: RecoveryGate): number {
  let hold = text.length

  const lastLt = text.lastIndexOf('<')
  if (lastLt !== -1 && looksLikeTagStart(text.slice(lastLt))) hold = Math.min(hold, lastLt)
  // ISSUE #298, the byte-by-byte case. A bare wrapper (`<ask_user_question>`)
  // arrives before the `arg_key` that proves it was protocol, so the marked
  // rule above cannot see it. Holding an UNTERMINATED `<` whose partial name
  // is a prefix of a candidate keeps the block recoverable when the rest
  // arrives, and costs nothing for prose: `a < b` and `<50%` both fail the
  // prefix test, and a COMPLETE `<bash>` tag is a finished tag, not a fragment
  // — it is emitted immediately, which is what keeps `You can write
  // <bash>ls -la</bash>` intact.
  if (gate?.bareMarkup === true && lastLt !== -1) {
    const tail = text.slice(lastLt)
    if (!tail.includes('>') && couldStartBareCandidate(tail, gate)) hold = Math.min(hold, lastLt)
  }

  for (const span of spans) {
    if (span.open) hold = Math.min(hold, span.start)
  }

  return hold
}

/**
 * Could this unterminated `<…` fragment still become a bare candidate tag?
 *
 * Requires the `<` to be followed immediately by a name character (the bare
 * rule — no whitespace), and the partial name to be a prefix of, or extend, a
 * name this request put on offer. `<ask` and `<ask_user_question` hold;
 * `< b` and `<50` do not.
 */
function couldStartBareCandidate(tail: string, gate: RecoveryGate): boolean {
  if (!tail.startsWith('<')) return false
  let body = tail.slice(1)
  if (body === '') return true
  if (body.startsWith('/')) return false
  if (!/[\p{L}_]/u.test(body.charAt(0))) return false
  const match = /^[\p{L}\p{N}_-]*/u.exec(body)
  const partial = (match?.[0] ?? '').toLowerCase()
  if (partial === '') return true
  const candidates = [...PROTOCOL_VOCABULARY, ...gate.declaredNames]
  for (const accepted of gate.acceptedParameters?.values() ?? []) candidates.push(...accepted)
  return candidates.some(candidate => {
    const name = candidate.toLowerCase()
    return name.startsWith(partial) || partial.startsWith(name)
  })
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
  // A COMPLETE marker means this fragment is protocol markup, whatever name is
  // still arriving, so the whole tag must be judged at once: holding it is the
  // difference between "one debris tag" and "half a tag printed, then the other
  // half a moment later" — the split-tag leak this rule exists to close.
  if (prefixLength > 0) return true
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
  /** The first withholding reason observed in this stream, reported once. */
  private withHeld: Partial<Withheld> = {}
  /**
   * Set once anything has been withheld from this response.
   *
   * It gates the debris sweep, and that is the whole point: gate 4 promises a
   * REFUSED block is shown verbatim, so marker text must survive the stream
   * untouched in every response that withheld nothing. Only after a block has
   * been removed can the tags left around it be known to belong to markup the
   * reader is no longer seeing — the wrapper's own `calls` closer, the opener
   * the withheld call never got. Before that, a marker tag in the text may be
   * the answer itself.
   */
  private withheldOnce = false
  /** Whether the one notice allowed per response has gone out. See `takeWithheld`. */
  private noticeSent = false
  /**
   * Whether this response has produced any MARKED opening tag, at any point
   * (issue #207).
   *
   * Deliberately NOT the same flag as {@link withheldOnce}. `withheldOnce` means
   * "a block was removed", and the debris sweep used it as a PROXY for "this
   * response's marker text is protocol debris rather than the answer". The two
   * are not the same question, and a response that leaked lone closers without
   * ever withholding a block was the case that fell between them:
   * `hasProse()` already counted those closers as non-prose (it runs
   * `stripMarkup`), while the output path forwarded them — the classifier said
   * "residue" and the writer said "text".
   *
   * Deliberately ANY marked opener rather than a {@link BLOCK_TAGS} one: the
   * captured shape `<｜DSML｜ validate>` wears an invented name, so it is not a
   * block opener and would not set a block-only flag — yet it is precisely the
   * tag whose closer a name-based sweep would mutilate. "The model started
   * writing protocol markup" is the question, and that is answered by the
   * MARKER, not by the name.
   *
   * Tracked across chunks because a chunk boundary is not a response boundary.
   */
  private openerSeen = false

  constructor(gate: RecoveryGate) {
    this.gate = gate
  }

  /**
   * Stop recovering calls, but keep cleaning the text (issue #207).
   *
   * Called when the upstream has already produced a STRUCTURED call. The reason
   * to stand down is sound — recovering markup into a second call channel after
   * the client already got a real one hands it two answers to the same question
   * — but the shim used to implement it by bypassing this buffer entirely, so
   * "no more calls" silently became "no more cleaning either" and every marker
   * after the native call went out as prose.
   *
   * Scrub mode keeps the text half: blocks are still located and removed, but
   * {@link parseBlock} is never consulted, so no call can be produced. Removal
   * is reported as debris rather than tallied as a withheld invocation — see
   * {@link scrubPending}.
   */
  standDown(): void {
    this.nativeCalls = true
  }

  private nativeCalls = false

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
      return { text, prose: hasProse(text), withheld: false }
    }

    // Any MARKED opening tag counts, not only a block opener: the captured
    // `<｜DSML｜ validate>` wears an invented name, is therefore not a block
    // opener, and is still exactly the tag whose closer a sweep would mutilate.
    this.openerSeen ||= hasMarkedOpener(this.pending)

    for (;;) {
      const found = findFirstOpener(this.pending, ignoredSpans(this.pending))
      if (found === undefined) break
      // Recorded BEFORE any parse, so it covers refused and recovered blocks
      // alike: this is "the response spoke the protocol", not "a block was
      // removed".
      this.openerSeen = true
      // Scrub mode (issue #207) never examines a block. The block and its
      // surrounding whitespace go, but no call is produced and the removal is
      // NOT reported as a withheld invocation — reporting one would set
      // `residueSeen`, and the shim's "the turn was markup only" retry would
      // then re-run a call the upstream already answered.
      if (this.nativeCalls) {
        const head = stripMarkup(this.pending.slice(0, found.open.start)).trimEnd()
        if (head !== '') parts.push(head)
        this.pending = this.pending.slice(found.close === undefined ? found.open.start : found.close.end + 1)
        if (found.close === undefined) return finish(parts, calls, this.takeWithheld())
        continue
      }

      const head = this.stripDebris(this.pending.slice(0, found.open.start))
      if (head !== '') parts.push(head)

      // Gate 1: the close has not arrived, so nothing may be committed. The
      // whole block is held — emitting it now would make it unparseable when
      // the rest finally arrives.
      if (found.close === undefined) {
        this.pending = this.pending.slice(found.open.start)
        return finish(parts, calls, this.takeWithheld())
      }

      const body = this.pending.slice(found.open.start, found.close.end + 1)
      const parsed = parseBlock(body, this.gate, this.withHeld)
      if (parsed.calls.length > 0) calls.push(...parsed.calls)
      // Gate 4: refused, so the block is shown exactly as it arrived — EXCEPT
      // the name-less invocation, which is a defect rather than content. That
      // one is withheld and reported instead. A block whose name is present but
      // refused (undeclared tool, pinned tool_choice, missing required
      // parameter) is still shown verbatim, exactly as gate 4 says.
      //
      // The decision is parseBlock's to make, not re-derived here: it is the
      // only place that knows WHICH invocation inside the block was refused.
      //
      // Withholding needs somewhere to REPORT to, and parseBlock already folded
      // that in: with no listener the removal would be silent, and a silently
      // deleted answer is worse than the markup it replaced. There the block
      // keeps its gate-4 fate and the reader at least sees what the model wrote.
      else if (!parsed.withheld) parts.push(body)

      this.pending = this.pending.slice(found.close.end + 1)
    }

    // ISSUE #298: a block written with no marker. Only when the request opted
    // in AND the protocol's own vocabulary is present — a sentence about a tool
    // never gets here. The block is held to the end of the pending text and
    // resolved at flush: an unmarked block has no depth-paired closer we can
    // trust (the captured shape closes `<ask_user_question>` with
    // `</tool_call>`), so committing any part of it early would print its own
    // bytes back to the user.
    if (this.gate.bareMarkup === true && !this.nativeCalls) {
      const start = findBareBlockStart(this.pending, this.gate)
      if (start !== -1) {
        this.bareSeen = true
        const head = this.stripDebris(this.pending.slice(0, start))
        if (head !== '') parts.push(head)
        this.pending = this.pending.slice(start)
        return finish(parts, calls, this.takeWithheld())
      }
      // NOT YET DECIDABLE: hold ONLY once the protocol's own vocabulary is
      // present. Holding on a candidate NAME alone (a declared tool or
      // parameter in angle brackets) swallowed ordinary sentences —
      // `You can write <bash>ls -la</bash> to list files.` came back as
      // `You can write ` — which is the exact defect this feature exists to
      // avoid, in mirror image.
      //
      // A bare-wrapped block is therefore allowed to be emitted while it is
      // still only a wrapper: nothing yet says it is protocol rather than a
      // sentence. What must NOT be lost is the block itself once the protocol
      // word appears, so the outstanding wrapper is re-found from the head of
      // the pending text (the tail hold below never commits an unterminated
      // `<`). See `holdFrom`'s bare branch.
      if (hasBareProtocolWord(this.pending)) {
        const holdAt = firstBareCandidateAt(this.pending, this.gate)
        if (holdAt !== -1) {
          const head = this.stripDebris(this.pending.slice(0, holdAt))
          if (head !== '') parts.push(head)
          this.pending = this.pending.slice(holdAt)
          this.bareSeen = true
          return finish(parts, calls, this.takeWithheld())
        }
      }
    }

    // Nothing committable left: emit everything except a tail that could still
    // turn into a tag, or that sits inside an unclosed code span.
    const hold = holdFrom(this.pending, ignoredSpans(this.pending), this.gate)
    if (hold > 0) {
      const tail = this.stripDebris(this.pending.slice(0, hold))
      if (tail !== '') parts.push(tail)
    }
    this.pending = this.pending.slice(hold)

    return finish(parts, calls, this.takeWithheld())
  }

  /**
   * Whether a bare (unmarked) protocol block was held in this response.
   *
   * Separate from {@link openerSeen} because that flag is about MARKED tags and
   * gates the debris sweep; this one is only about the #298 shape.
   */
  private bareSeen = false

  /** End of stream: hand back everything still held — minus the debris. */
  flush(): BufferOutcome {
    let text = this.pending
    this.pending = ''

    // ISSUE #298: a bare block that was held at `add` is resolved HERE, where
    // the whole thing finally exists. Two outcomes, both fail-closed:
    //   - it parses under gates 2/4 → the call is produced and its bytes are
    //     swallowed, so the user never reads the protocol;
    //   - it does not → the bytes are shown verbatim, because gate 4's promise
    //     covers unmarked blocks too: markup the reader can see is better than
    //     an answer silently deleted.
    const bareCalls: RecoveredToolCall[] = []
    if (this.bareSeen && this.gate.bareMarkup === true && !this.nativeCalls) {
      const call = parseBareBlock(text, this.gate)
      if (call !== undefined) {
        // Only the PROSE before the block survives; the block itself goes.
        const start = findBareBlockStart(text, this.gate)
        text = start === -1 ? text : stripBareBlock(text, this.gate)
        bareCalls.push(call)
      }
    }

    // Gate 2, last chance: a block whose close never arrived is still a block
    // attempt, and when its opener is the unnamed invocation it is the same
    // defect as the complete one. Everything from that opener to the end of
    // the stream is block content (the hold starts at the opener), so the
    // whole of it goes and is reported, exactly like the complete case.
    if (isUnnamedInvoke(text) && this.gate.onWithheld !== undefined) {
      this.withHeld.reason ??= 'unnamed-invoke'
      text = ''
    }

    // The tail that `holdFrom` kept back can never become a tag now. Once this
    // response has spoken the protocol at all, an unterminated marker fragment
    // in that tail is the same debris — the `</｜DSML｜ invo` that trailed a
    // killed stream. A response that never opened a block keeps its tail: there
    // a fragment like `<｜DSM` is a block that simply ran out of bytes, and gate
    // 4 says it is shown rather than swallowed.
    //
    // `this.debris()` rather than `openerSeen` alone: a response that withheld
    // nothing still sweeps once lone CLOSERS have been recognised as debris
    // (issue #207, {@link stripLoneClosers}), which is a separate fact.
    if (this.openerSeen || this.debris()) {
      text = dropUnfinishedMarkerTail(text, this.nativeCalls ? {} : this.withHeld)
      text = this.nativeCalls ? stripMarkup(text) : stripLoneClosers(text, this.withHeld, this.openerSeen)
    }

    const state = this.takeWithheld()
    const outcome: BufferOutcome = { text, prose: hasProse(text), withheld: state.withheld }
    if (state.withheldReason !== undefined) outcome.withheldReason = state.withheldReason
    if (bareCalls.length > 0) outcome.calls = bareCalls
    return outcome
  }

  /**
   * Apply the debris sweep, but only where it is provably debris.
   *
   * Three states, in order:
   *
   *   - SCRUB MODE (issue #207): nothing is being recovered, so every
   *     marker-bearing tag is debris by definition.
   *   - A block was withheld: the text left around removed blocks is residue by
   *     construction, so the full sweep applies.
   *   - Nothing was withheld AND no opener ever appeared: only lone CLOSERS are
   *     unambiguously debris — this is the case the issue reports, where the
   *     old proxy (`debris()`) could never be true and the bytes went out raw.
   *
   * A response that never withheld anything but DID open a block keeps its text
   * untouched: gate 4 promises the refused block is shown verbatim, and its
   * forged-name opener is exactly the shape a name-based sweep would mutilate.
   */
  private stripDebris(text: string): string {
    if (this.nativeCalls) return stripMarkup(text)
    if (this.debris()) return stripStray(text, this.withHeld)
    return stripLoneClosers(text, this.withHeld, this.openerSeen)
  }

  /** Has anything been withheld from this response, yet or already? */
  private debris(): boolean {
    return this.withheldOnce || this.withHeld.reason !== undefined
  }

  /**
   * Hand the accumulated reason to exactly one outcome.
   *
   * Exactly one, because the notice it drives is emitted once per response. A
   * reason reported on two outcomes would print the same sentence twice.
   */
  private takeWithheld(): { withheld: boolean; withheldReason?: 'unnamed-invoke' | 'stray-markup' } {
    const reason = this.withHeld.reason
    if (reason === undefined) return { withheld: false }
    this.withHeld = {}
    this.withheldOnce = true
    // One NOTICE per response, however many blocks were withheld: the user
    // needs to know the turn was interfered with, and a sentence per block is
    // the noise that makes them stop reading them. Later outcomes still report
    // `withheld` — the fact is per-outcome, the sentence is not.
    if (this.noticeSent) return { withheld: true }
    this.noticeSent = true
    this.gate.onWithheld?.(reason)
    return { withheld: true, withheldReason: reason }
  }
}

/**
 * Is this block an invocation the model wrote without naming a tool?
 *
 * Deliberately narrow: no attribute at all on the opener. `<invoke name="">`
 * is a REFUSED call with a name the gates can judge, and gate 4 shows it.
 */
function isUnnamedInvoke(body: string): boolean {
  const open = scanTag(body, 0)
  return open !== undefined && !open.closing && open.name === 'invoke' && open.attributes.trim() === ''
}

/** Assemble one `add()` outcome without ever emitting a `calls: undefined` key. */
function finish(
  parts: readonly string[],
  calls: readonly RecoveredToolCall[],
  state: { withheld: boolean; withheldReason?: 'unnamed-invoke' | 'stray-markup' },
): BufferOutcome {
  const text = parts.join('')
  const outcome: BufferOutcome = { text, prose: hasProse(text), withheld: state.withheld }
  if (state.withheldReason !== undefined) outcome.withheldReason = state.withheldReason
  if (calls.length > 0) outcome.calls = [...calls]
  return outcome
}
