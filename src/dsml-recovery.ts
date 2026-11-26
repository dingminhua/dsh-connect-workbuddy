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
 * The same defect without the marker
 * ============================================================================
 *
 * A later capture dropped the marker entirely:
 *
 * ```text
 * <ask_user_question>
 * <questions</arg_key><arg_value>[{"header":"…"}]</arg_value></tool_call>
 * ```
 *
 * Every rule above is written in terms of the marker, so none of them saw this
 * as markup at all: it went to the user as the answer, unread. The gates were
 * not the problem — the vocabulary was. {@link RecoveryGate.bareMarkup} adds
 * the missing half: a tag whose NAME is protocol vocabulary, or a tool this
 * request declared, is markup even unmarked. Nothing else changes: the same
 * four gates run, on the same terms, and a shape that fails them still goes
 * back to the user verbatim.
 *
 * The opt-in is deliberate. A bare `<div>` in somebody's prose is not a call,
 * and a module that started deleting HTML on sight would be a worse defect than
 * the leak it fixes.
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
 *
 * `tool_call` (SINGULAR) is here because a bare one is how the model opens a
 * block when it forgets the protocol entirely — see
 * {@link BARE_BLOCK_TAGS}. It is the same word as the wrapper, written in the
 * other number, which is exactly why it reads as an opener rather than as a
 * parameter tag.
 */
const BLOCK_TAGS: readonly string[] = ['tool_calls', 'invoke', 'tool_call']

/**
 * Names that mean protocol markup even with NO marker in front of them.
 *
 * THE DEFECT THIS CLOSES. Everything in this module used to require the
 * `｜DSML｜` marker before it would treat a tag as markup, on the reasoning that
 * the marker is the model's own confession. A captured response shows what
 * happens when the model writes the protocol WITHOUT it:
 *
 * ```text
 * <ask_user_question>
 * <questions</arg_key><arg_value>[{"header":"…"}]</arg_value></tool_call>
 * ```
 *
 * Not one byte carries a marker, so `scanTag` classified every tag as ordinary
 * prose, `stripMarkup` deleted nothing, and the whole thing was forwarded to
 * the user as the answer — the block was never even a candidate for recovery.
 * The shape is also not one this module parses (`<questions` truncated, the
 * `arg_key`/`arg_value` pair, a SINGULAR `tool_call` closer), so recognising it
 * would not have been enough on its own; see {@link parseBareWrapper}.
 *
 * WHY A LIST AND NOT "ANY NAME". A bare `<div>` or `<b>` is somebody's HTML,
 * and treating it as markup would delete the text after it. Membership here is
 * the evidence that replaces the missing marker, and it is deliberately made of
 * names that are not plausible in prose: `arg_key`/`arg_value` are the
 * protocol's own vocabulary, and `tool_call`/`tool_calls` are the wrapper. The
 * schema-derived names (`questions`, `question`) are added to the EFFECTIVE
 * list per request by {@link bareNamesFor}, because those are ordinary English
 * words that only the request's own tool declarations can make meaningful.
 */
const BARE_PROTOCOL_TAG_NAMES: readonly string[] = [
  'tool_calls',
  'tool_call',
  'invoke',
  'parameter',
  'arg_key',
  'arg_value',
]

/**
 * The bare-name set for one request: the protocol's own vocabulary plus every
 * tool this request DECLARES.
 *
 * Why declared tool names are included. A bare wrapper is written as the tool's
 * own name — `<ask_user_question>` — and that name is the only thing that says
 * which tool was meant. Excluding it would mean the wrapper never becomes a
 * block, so nothing is ever parsed and gate 2 never even gets to run; the
 * answer would be the markup, which is the defect.
 *
 * This does NOT weaken gate 2, which is checked in {@link parseBareWrapper}:
 * membership here only decides that the bytes are MARKUP rather than prose. An
 * undeclared name is not in the set, is therefore prose, and is forwarded
 * verbatim by gate 4 — the same fate it has always had.
 *
 * PARAMETER NAMES ARE DELIBERATELY NOT HERE. They are ordinary English words
 * (`command`, `questions`, `path`): promoting them to the GLOBAL bare set made
 * `Set <command> now and later.` lose its `<command>`, and made the streaming
 * buffer hold prose like `<question …` to end of stream waiting for a closer
 * that was only ever a sentence. A parameter key is only meaningful INSIDE a
 * block this module has already opened; there it is checked against the
 * request's schema by {@link parseArgPairs}, {@link parseParameters} and
 * {@link parseTruncatedKey} — none of which need the name in this set.
 */
function bareNamesFor(gate: RecoveryGate): ReadonlySet<string> {
  if (gate.bareNames !== undefined) return gate.bareNames
  const names = new Set<string>(BARE_PROTOCOL_TAG_NAMES)
  for (const tool of gate.declaredNames) names.add(tool.toLowerCase())
  return names
}

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
const KEYWORD_TAGS: readonly string[] = [
  'tool_calls',
  'tool-calls',
  'toolcalls',
  'tool_call',
  'invoke',
  'parameter',
  'calls',
  'tool',
]

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
  ['tool_call', 'tool_call'],
  ['invoke', 'invoke'],
  ['parameter', 'parameter'],
  ['arg_key', 'arg_key'],
  ['arg_value', 'arg_value'],
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
  /**
   * True when the tag is markup only because its name is in the bare set —
   * no marker, but {@link RecoveryGate.bareMarkup} made the name decisive.
   *
   * Kept separate from {@link marked} rather than folded into it: every
   * existing rule is about the MARKER (a marker fragment at end of stream, a
   * marked opener arming the closer sweep), and a bare name is a weaker
   * signal that must not silently acquire those powers.
   */
  bare: boolean
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
   * Called once per withheld block, when the stream declined to recover AND
   * declined to show what it found.
   *
   * A hook rather than a second return channel because the reason belongs to
   * the response, not the buffer: one notice per turn, whatever the number of
   * blocks. The plugin never throws through this — a diagnostic must not fail
   * a chat request.
   */
  onWithheld?: (reason: 'unnamed-invoke' | 'stray-markup') => void
  /**
   * Opt in to recognising markup that carries NO `｜DSML｜` marker at all.
   *
   * Off by default, and that default is the old behaviour byte for byte: a bare
   * `<div>` in a user's own words is not protocol, and a module that started
   * deleting HTML on sight would be a worse bug than the leak it fixes.
   *
   * WHAT IT DOES. A tag whose name is in {@link bareNamesFor} is classified as
   * markup even unmarked — so {@link stripMarkup} and the stream buffer see it,
   * and the wrapper shape below becomes recoverable:
   *
   * ```text
   * <ask_user_question>
   * <questions</arg_key><arg_value>[{"header":"…"}]</arg_value></tool_call>
   * ```
   *
   * WHAT IT DOES NOT DO. Every gate still runs, unchanged. A bare block is
   * parsed by {@link parseBareWrapper}, which refuses unless the WRAPPER names a
   * declared tool, the close matches, and the required parameters are all
   * present. Nothing is inferred from a bare block: the model wrote the tool
   * name in the clear, so there is no name to guess.
   *
   * The narrowing that makes this safe to turn on: only names in
   * {@link BARE_PROTOCOL_TAG_NAMES} plus the request's own parameter names are
   * eligible, and those are consulted only INSIDE a block this module opened.
   */
  bareMarkup?: boolean
  /**
   * The bare-name set to use, overriding the one {@link bareNamesFor} derives.
   *
   * Only needed by callers that know their own protocol vocabulary; the derived
   * set is right for every request shaped like a chat-completions body.
   */
  bareNames?: ReadonlySet<string>
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
 *
 * `bare` is the ONE piece of request-scoped state this scanner takes. Without
 * it a bare tag is scanned (so `findTag` can walk past it) but classified as
 * prose, which is what every rule downstream reads.
 */
function scanTag(text: string, index: number, bareNames?: ReadonlySet<string>): MarkupTag | undefined {
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

  // `<` must be immediately followed by the name for a bare tag to count: the
  // whitespace skip above exists for the MARKED shape (`<｜DSML｜ invoke>`),
  // and accepting it bare would read prose like `a < b and tool_call` as a tag.
  // A closer is protocol markup when it names something the protocol OWNS —
  // the wrapper vocabulary plus the bare table. It does not need to be a name
  // this request declared: `</tool_call>` closes `<ask_user_question>`, and a
  // closer that is not recognised leaves its block unpaired, which is exactly
  // the failure this change fixes.
  const bare = !read.marked
    && bareNames !== undefined
    && (bareNames.has(read.name) || CLOSER_NAMES.has(read.name))
    && position === index + (closing ? 2 : 1)

  const canonical = CANONICAL_TAG_NAMES.get(read.name)
  const name = canonical !== undefined && (!(MARKER_ONLY_TAG_NAMES.has(read.name) && !read.marked) || bare)
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
        bare,
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
        bare,
        attributes: text.slice(attributesStart, cursor).trim(),
      }
    }
    cursor += 1
  }
  return undefined
}

/**
 * Names that count as protocol markup even when bare, whichever side they are
 * on.
 *
 * The bare table covers the vocabulary that opens a block; these are the
 * closers a block may wear instead of its own name. The captured leak opens
 * `<ask_user_question>` and closes `</tool_call>`.
 */
const CLOSER_NAMES: ReadonlySet<string> = new Set([
  'tool_call',
  'tool_calls',
  'tool-calls',
  'toolcalls',
  'calls',
  'invoke',
  'parameter',
  'arg_value',
])

/** The next markup tag outside every ignored span, at or after `from`. */
function findTag(
  text: string,
  spans: readonly IgnoredSpan[],
  from: number,
  bareNames?: ReadonlySet<string>,
): MarkupTag | undefined {
  const cursor = { at: 0 }
  let index = Math.max(from, 0)
  while (index < text.length) {
    const skipped = skipIgnored(spans, index, cursor)
    if (skipped !== index) {
      index = skipped
      continue
    }
    if (text.charAt(index) === '<') {
      const tag = scanTag(text, index, bareNames)
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
function findMatchingClose(
  text: string,
  spans: readonly IgnoredSpan[],
  open: MarkupTag,
  bareNames?: ReadonlySet<string>,
): MarkupTag | undefined {
  let depth = 1
  let index = open.end + 1
  while (index < text.length) {
    const tag = findTag(text, spans, index, bareNames)
    // A bare closer of a DIFFERENT name does not count towards this block's
    // depth. The captured wrapper closes with `</tool_call>` while it opened
    // with `<ask_user_question>`; pairing is done by the caller (see
    // {@link parseBareWrapper}), not by name here.
    //
    // ONLY a closer that can end a block is considered. `</arg_key>` is a
    // closer too, and counting it here made it end the wrapper: the block
    // stopped at the first key, `parseBareWrapper` then read `</arg_key>` as
    // the block's closer, refused the name, and the call was lost. Keys are
    // arguments, not elements — see {@link TAGLESS_KEY_NAMES}.
    if (tag === undefined) return undefined
    const sameName = tag.name === open.name
    if (sameName || (open.bare && tag.bare && tag.closing && BLOCK_CLOSER_NAMES.has(tag.name))) {
      if (tag.closing) {
        depth -= 1
        if (depth === 0) return tag
      } else if (!tag.selfClosing && !TAGLESS_KEY_NAMES.has(tag.name)) {
        // `<questions` is a KEY whose `>` never arrived, not a nested element:
        // its closer is the `</arg_key>` of the shape {@link parseTruncatedKey}
        // reads. It is therefore excluded from the opener test above rather
        // than from the depth count here — a key that DID open properly
        // (`<arg_key>…</arg_key>`) is a complete element and must balance.
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
function findFirstOpener(
  text: string,
  spans: readonly IgnoredSpan[],
  bareNames?: ReadonlySet<string>,
  pending = false,
): { open: MarkupTag; close?: MarkupTag } | undefined {
  let index = 0
  while (index < text.length) {
    const tag = findTag(text, spans, index, bareNames)
    if (tag === undefined) return undefined
    if (!tag.closing && BLOCK_TAGS.includes(tag.name)) {
      const close = findMatchingClose(text, spans, tag, bareNames)
      return close === undefined ? { open: tag } : { open: tag, close }
    }
    // A BARE wrapper whose name is a declared tool: the shape the model writes
    // when it forgets the protocol entirely (`<ask_user_question>` around
    // `<questions>`, closed by `</tool_call>`). The bare set already contains
    // exactly the declared tool names, so membership IS gate 2's first half;
    // {@link parseBareWrapper} re-checks it against `declaredNames` directly.
    if (!tag.closing && tag.bare && !BARE_PROTOCOL_TAG_NAMES.includes(tag.name) && !KEYWORD_TAGS.includes(tag.name)) {
      const close = findMatchingClose(text, spans, tag, bareNames)
      // A bare wrapper with no close is reported as an unclosed block only when
      // the caller is the STREAMING buffer, which must hold from the opener so
      // the rest of the block can still arrive. Parsing already-complete text
      // has nothing to commit and must NOT treat it as a block: an unpaired
      // `<div>` in prose would otherwise swallow everything after it.
      if (close === undefined) {
        if (!pending) {
          index = tag.end + 1
          continue
        }
        return { open: tag }
      }
      return { open: tag, close }
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
 * A third shape exists in the bare vocabulary and is handled by
 * {@link parseArgPairs}, not here: `<arg_key>k</arg_key><arg_value>v</arg_value>`
 * is one parameter split over two tags, so it cannot be read by a loop that
 * treats each tag as self-contained.
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
function parseParameters(body: string, bareNames?: ReadonlySet<string>): Record<string, ParameterValue> {
  const parameters: Record<string, ParameterValue> = {}
  const spans = ignoredSpans(body)
  let index = 0

  while (index < body.length) {
    const tag = findTag(body, spans, index, bareNames)
    if (tag === undefined) break
    if (tag.closing || tag.selfClosing) {
      index = tag.end + 1
      continue
    }

    const close = findMatchingClose(body, spans, tag, bareNames)
    if (close === undefined) {
      index = tag.end + 1
      continue
    }

    // An argument pair is one parameter, not two: its tags are syntax, and
    // {@link parseArgPairs} is what turns them into a name and a value. Read
    // here they would land in the call as `arg_key` / `arg_value` parameters.
    if (ARGUMENT_TAG_NAMES.has(tag.name)) {
      index = close.end + 1
      continue
    }

    const value = body.slice(tag.end + 1, close.start).trim()
    const attributes = parseAttributes(tag.attributes)
    const explicitName = tag.name === 'parameter' ? attributes['name'] : undefined
    const name = explicitName ?? tag.name

    if (name !== undefined && name !== '' && (explicitName !== undefined || parameters[name] === undefined)) {
      parameters[name] = value.startsWith('<![CDATA[') && value.endsWith(']]>')
        ? value.slice(9, -3)
        : nestedOrText(value, bareNames)
    }

    index = close.end + 1
  }

  return parameters
}

/**
 * Read the `<arg_key>`/`<arg_value>` pairs of a bare block.
 *
 * THE SHAPE. `arg_key` names the parameter and the `arg_value` that follows it
 * is its value, so the pair is one parameter and neither tag is one on its own.
 * This is the vocabulary of the captured leak:
 *
 * ```text
 * <ask_user_question>
 * <questions</arg_key><arg_value>[{"header":"…"}]</arg_value></tool_call>
 * ```
 *
 * A key with no value after it is dropped rather than read as an empty string:
 * an empty parameter is indistinguishable from a missing one once it is JSON,
 * and inventing `""` for a truncated block is the kind of guess gate 4 exists
 * to refuse.
 *
 * Off unless `bareNames` is supplied — a marked block never uses this
 * vocabulary, and reading `<arg_key>` out of one would invent parameters the
 * model did not write.
 */
function parseArgPairs(body: string, bareNames: ReadonlySet<string>): Record<string, ParameterValue> {
  const parameters: Record<string, ParameterValue> = {}
  const spans = ignoredSpans(body)
  let pendingKey: string | undefined
  let index = 0

  while (index < body.length) {
    const tag = findTag(body, spans, index, bareNames)
    if (tag === undefined) break
    if (tag.closing || tag.selfClosing || !tag.bare) {
      index = tag.end + 1
      continue
    }
    const close = findMatchingClose(body, spans, tag, bareNames)
    if (close === undefined) break
    const value = body.slice(tag.end + 1, close.start).trim()

    if (tag.name === 'arg_key') {
      // A key is a NAME, not markup: entity-decode it and nothing else, or a
      // key that happens to contain `<` would be read as a nested object.
      pendingKey = decodeEntities(value)
    } else if (tag.name === 'arg_value' && pendingKey !== undefined) {
      parameters[pendingKey] = value.startsWith('<![CDATA[') && value.endsWith(']]>')
        ? value.slice(9, -3)
        : nestedOrText(value, bareNames)
      pendingKey = undefined
    }

    index = close.end + 1
  }

  return parameters
}

/** A value that itself contains a complete tag pair is a nested object. */
function nestedOrText(value: string, bareNames?: ReadonlySet<string>): ParameterValue {
  if (!value.includes('<') || !value.includes('>')) return decodeEntities(value)
  const nested = parseParameters(value, bareNames)
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
  const bareNames = gate.bareMarkup === true ? bareNamesFor(gate) : undefined
  const spans = ignoredSpans(block)
  let index = 0

  // The block's own wrapper is not a child of itself. A bare wrapper block
  // starts with the tag that names the tool (`<ask_user_question>`), and the
  // child scan below only looks for `invoke` and for OTHER bare wrappers — so
  // without this the wrapper is read as an unknown tag, the scan advances past
  // it, and the block's contents are never seen at all.
  const outer = findTag(block, spans, 0, bareNames)
  if (outer !== undefined && outer.start === 0 && !outer.closing && bareNames !== undefined && outer.bare && gate.declaredNames.has(outer.name)) {
    const close = findMatchingClose(block, spans, outer, bareNames)
    if (close === undefined) return { calls, withheld }
    const call = parseBareWrapper(outer, close, block, gate, bareNames)
    if (call !== undefined) calls.push(call)
    return { calls, withheld }
  }

  while (index < block.length) {
    const tag = findTag(block, spans, index, bareNames)
    if (tag === undefined) break
    if (!tag.closing && tag.name === 'invoke') {
      const close = findMatchingClose(block, spans, tag, bareNames)
      if (close === undefined) break
      const call = parseInvoke(tag, close, block, gate, bareNames)
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

/**
 * Does a paired bare wrapper carry the protocol's OWN shape?
 *
 * A bare block is the model's markup only when the bytes prove it: either the
 * closer wears one of the protocol's wrapper names (`</tool_call>` where the
 * opener was `<ask_user_question>`), or the body uses the protocol's own
 * vocabulary (`arg_key`, `arg_value`, `parameter`). A closer that merely
 * REPEATS the opener (`<bash>ls -la</bash>`) with plain prose inside is the
 * user's own text, not a call — recovering it would execute a tool the model
 * never invoked, and stripping it would delete the answer.
 *
 * `body` is passed in by the caller so both the parser and any other consumer
 * judge the exact same slice; `open`/`close` carry the pairing evidence.
 */
function hasBareProtocolShape(open: MarkupTag, close: MarkupTag, body: string): boolean {
  if (open.name !== close.name && PROTOCOL_CLOSER_NAMES.has(close.name)) return true
  return /\b(arg_key|arg_value|parameter)\b/i.test(body)
}

/**
 * One bare wrapper element → a call, or nothing when a gate refuses it.
 *
 * The shape, captured from a real response and quoted in the module header:
 *
 * ```text
 * <ask_user_question>
 * <questions</arg_key><arg_value>[{"header":"…"}]</arg_value></tool_call>
 * ```
 *
 * WHAT THIS DOES NOT DO, and why it is not "guessing". Gate 2 is satisfied by
 * the model's own words: the wrapper tag IS the tool name, written in the
 * clear, so there is no name to infer — only one to CHECK against the request's
 * declarations, exactly as `name="…"` is checked. A wrapper naming anything
 * undeclared returns nothing and the block keeps its gate-4 fate.
 *
 * The close is accepted when it names the same tool OR when it is one of the
 * protocol's own closers (`tool_call`, `tool_calls`, `invoke`, `parameter`),
 * because the captured block opens with `<ask_user_question>` and closes with
 * `</tool_call>` — the model is not tracking names. A close naming a DIFFERENT
 * tool is refused: that is a different call's closer, and pairing across it
 * would silently attach one call's arguments to another's name.
 */
function parseBareWrapper(
  open: MarkupTag,
  close: MarkupTag,
  block: string,
  gate: RecoveryGate,
  bareNames: ReadonlySet<string>,
): RecoveredToolCall | undefined {
  const name = open.name
  // Gate 2. `findFirstOpener` only offers declared wrappers, but this is the
  // gate, so it is stated here too rather than trusted from a caller.
  if (!gate.declaredNames.has(name)) return undefined

  if (close.name !== name && !PROTOCOL_CLOSER_NAMES.has(close.name)) return undefined

  // PROTOCOL SHAPE EVIDENCE. A bare wrapper is only the model's markup when the
  // bytes carry the protocol's OWN vocabulary — an `arg_key`/`arg_value` pair
  // or a `parameter` tag inside the block, or a closer wearing one of the
  // protocol's wrapper names (`</tool_call>` etc. rather than `</bash>`).
  // `<bash>ls -la</bash>` in a sentence explaining a command has NONE of that:
  // its closer merely repeats its own name. Without this check a declared tool
  // with no required argument would be recovered as an empty call and its text
  // deleted — a rare visible leak traded for a silent tool execution.
  const body = block.slice(open.end + 1, close.start)
  if (!hasBareProtocolShape(open, close, body)) return undefined
  // Argument pairs FIRST: `parseParameters` would otherwise read the pair's own
  // tags as parameters (`arg_key: "questions"`, `arg_value: "…"`), and those
  // must never reach a call.
  const parameters = { ...parseArgPairs(body, bareNames), ...parseParameters(body, bareNames) }
  const truncated = parseTruncatedKey(body, bareNames)
  if (truncated !== undefined) {
    // The captured leak writes `<questions` with no `>`, so no tag scanner can
    // see it. A KEY is the one place where that is recoverable without guessing:
    // the value that follows is still explicit, and it is accepted only when
    // the schema says this tool has exactly that one parameter still missing.
    //
    // A tool with no declared required list cannot say, and then the value is
    // NOT taken: "no schema" is not permission.
    const required = gate.requiredParameters?.get(name)
    if (required === undefined) {
      // No declared required list: the only thing that can be checked is that
      // the key is one this tool actually accepts, and that no value was
      // already given for it.
      const accepted = gate.acceptedParameters?.get(name)
      if (accepted === undefined || !accepted.has(truncated.key)) return undefined
      if (parameters[truncated.key] !== undefined) return undefined
    } else {
      const missing = required.filter(parameter => parameters[parameter] === undefined)
      if (missing.length !== 1 || missing[0] !== truncated.key) return undefined
    }
    parameters[truncated.key] = truncated.value
  }

  // Gate 2, pinned form: the caller asked for one tool by name.
  const pinned = gate.pinnedToolName
  if (pinned !== undefined && pinned !== 'auto' && pinned !== 'required' && pinned !== 'none' && pinned !== name) {
    return undefined
  }

  // Gate 4: a declared tool missing a required parameter is a truncated call.
  const required = gate.requiredParameters?.get(name)
  if (required !== undefined && required.some(parameter => parameters[parameter] === undefined)) {
    return undefined
  }

  return {
    id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    name,
    arguments: JSON.stringify(parameters),
  }
}

/**
 * Closers a bare wrapper may wear without naming its tool.
 *
 * `</tool_call>` is what the captured block used; the others are the same
 * vocabulary one nesting level up, and a model that stopped tracking names
 * does not distinguish between them.
 */
const PROTOCOL_CLOSER_NAMES: ReadonlySet<string> = new Set(['tool_call', 'tool_calls', 'invoke', 'parameter'])

/**
 * Names that are KEYS in the argument-pair shape, so a TRUNCATED occurrence of
 * one (`<questions` with no `>`) is not a nested element.
 *
 * `<arg_key>` is the protocol's own spelling; a truncated key is closed by the
 * `</arg_key>` that {@link parseTruncatedKey} reads. A key that opens properly
 * is a normal balanced element and is unaffected. Neither name can be a
 * wrapper: {@link findFirstOpener} only offers protocol vocabulary and declared
 * tool names, and this set is neither.
 */
const TAGLESS_KEY_NAMES: ReadonlySet<string> = new Set(['arg_key'])

/**
 * Tags that carry an argument PAIR rather than a parameter of their own.
 *
 * `parseParameters` skips them; {@link parseArgPairs} is what reads them. Both
 * spellings of the key are here because the model uses them interchangeably.
 */
const ARGUMENT_TAG_NAMES: ReadonlySet<string> = new Set(['arg_key', 'arg_value'])

/**
 * Closers that may end a block.
 *
 * A block is a WRAPPER: `tool_calls`, or a bare tool name. Its closer is either
 * that same name or one of the protocol's wrapper-level names below. Argument
 * tags (`arg_key`, `arg_value`, `parameter`) are NOT here — they close an
 * argument, and treating them as block closers truncates the block at its first
 * parameter.
 */
const BLOCK_CLOSER_NAMES: ReadonlySet<string> = new Set([
  'tool_call',
  'tool_calls',
  'tool-calls',
  'toolcalls',
  'calls',
  'invoke',
])

/**
 * The `<key` / `<arg_value>value</arg_value>` pair, when the key's `>` never
 * arrived.
 *
 * THE SHAPE, from the captured response:
 *
 * ```text
 * <ask_user_question>
 * <questions</arg_key><arg_value>[{"header":"…"}]</arg_value></tool_call>
 * ```
 *
 * `<questions` has no `>`, so `scanTag` finds no tag there at all — the
 * `</arg_key>` that follows closes a key the model never opened properly. No
 * scanner in this module can see the key, and inventing one would be exactly
 * the guess gate 4 forbids. What IS explicit is the value: the tag after the
 * broken key is an `arg_value`, and its own pair is complete.
 *
 * So this returns a CANDIDATE and nothing more. The caller accepts it only when
 * the request's schema says this tool has exactly one required parameter still
 * missing and the broken key spells it — i.e. the model's own bytes and the
 * request's own declaration agree, with nothing inferred in between.
 *
 * Bounded on purpose: only the FIRST broken key is read, and only when an
 * `arg_value` follows it immediately. A block with two truncated keys is not
 * evidence of anything and is refused.
 */
function parseTruncatedKey(
  body: string,
  bareNames: ReadonlySet<string>,
): { key: string; value: string } | undefined {
  const pattern = /<([a-z_][a-z0-9_-]*)(?![^<>]*>)(?=[^<>]*<\/arg_key>)/i
  const match = pattern.exec(body)
  if (match === null) return undefined
  const key = match[1]?.toLowerCase()
  // The key is a PARAMETER name, and parameter names are deliberately not in
  // `bareNames` (see bareNamesFor). Its legitimacy is decided by the caller,
  // against the request's own schema — not by global tag membership.
  if (key === undefined) return undefined

  const rest = body.slice(match.index + match[0].length)
  const spans = ignoredSpans(rest)
  let index = 0
  let sawKeyCloser = false
  while (index < rest.length) {
    const tag = findTag(rest, spans, index, bareNames)
    if (tag === undefined) return undefined
    if (tag.closing && tag.name === 'arg_key' && !sawKeyCloser) {
      sawKeyCloser = true
      index = tag.end + 1
      continue
    }
    if (!sawKeyCloser) return undefined
    if (tag.closing || tag.selfClosing || tag.name !== 'arg_value') return undefined
    const close = findMatchingClose(rest, spans, tag, bareNames)
    if (close === undefined) return undefined
    const value = rest.slice(tag.end + 1, close.start).trim()
    return { key, value: nestedOrText(value, bareNames) as string }
  }
  return undefined
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
  bareNames?: ReadonlySet<string>,
): RecoveredToolCall | undefined {
  const attributes = parseAttributes(open.attributes)
  const declared = attributes['name']
  const parameters = parseParameters(block.slice(open.end + 1, close.start), bareNames)

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
  const bareNames = gate.bareMarkup === true ? bareNamesFor(gate) : undefined
  let remaining = text

  // One response can carry several blocks, and all of them are recovered.
  while (remaining !== '') {
    const found = findFirstOpener(remaining, ignoredSpans(remaining), bareNames)
    if (found === undefined || found.close === undefined) break
    calls.push(...parseBlock(remaining.slice(found.open.start, found.close.end + 1), gate, seen).calls)
    remaining = remaining.slice(found.close.end + 1)
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
export function stripMarkup(text: string, gate?: RecoveryGate): string {
  const bareNames = gate?.bareMarkup === true ? bareNamesFor(gate) : undefined
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
    const tag = text.charAt(index) === '<' ? scanTag(text, index, bareNames) : undefined
    // A BARE CLOSER is debris even when its opener was never recognised as
    // markup. The captured leak closes with `</tool_call>` after a `<questions`
    // that could not be paired; leaving the closer behind prints protocol
    // punctuation in the answer, which is the defect itself.
    if (tag === undefined || (!tag.marked && !tag.bare && !(tag.closing && bareNames?.has(tag.name)))) {
      result += text.charAt(index)
      index += 1
      continue
    }
    const bracketed = !tag.closing && !tag.selfClosing && KEYWORD_TAGS.includes(tag.name)
    const close = bracketed ? findMatchingClose(text, spans, tag, bareNames) : undefined
    // A declared TOOL name used as a same-name wrapper with no protocol
    // vocabulary inside is the user QUOTING that tool (`You can write
    // <bash>ls -la</bash>`), not a call. The parser refuses it by the same
    // shape evidence (see hasBareProtocolShape); if the stripper still deleted
    // its tags it would rewrite the answer when nothing was recovered. Keep it
    // byte-for-byte. Protocol vocabulary is exempt: the captured leak opens
    // with a tool name and closes with `</tool_call>`, which IS shaped.
    if (tag.bare && !tag.marked && !tag.closing
      && bareNames !== undefined && bareNames.has(tag.name)
      && !BARE_PROTOCOL_TAG_NAMES.includes(tag.name)) {
      const paired = close ?? findMatchingClose(text, spans, tag, bareNames)
      if (paired === undefined || !hasBareProtocolShape(tag, paired, text.slice(tag.end + 1, paired.start))) {
        result += text.slice(index, (paired ?? tag).end + 1)
        index = (paired ?? tag).end + 1
        continue
      }
    }
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
function stripStray(text: string, seen: Partial<Withheld>, gate?: RecoveryGate): string {
  const cleaned = stripMarkup(text, gate)
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
function stripLoneClosers(
  text: string,
  seen: Partial<Withheld>,
  openerSeen: boolean,
  gate?: RecoveryGate,
): string {
  if (openerSeen) return text
  const cleaned = stripMarkup(text, gate)
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
function hasMarkedOpener(text: string, bareNames?: ReadonlySet<string>): boolean {
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
      const tag = scanTag(text, index, bareNames)
      // A BARE opener arms the sweep too. It is the same fact — "the model
      // started writing protocol markup" — and the captured bare block needs
      // it: its `</tool_call>` closer sits outside the block the sweep removes,
      // and without this flag it survives as a lone closer in the answer.
      if (tag !== undefined && (tag.marked || tag.bare) && !tag.closing) return true
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
export function hasProse(text: string, gate?: RecoveryGate): boolean {
  return stripMarkup(text, gate).trim() !== ''
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
function holdFrom(
  text: string,
  spans: readonly IgnoredSpan[],
  bareNames?: ReadonlySet<string>,
): number {
  let hold = text.length

  const lastLt = text.lastIndexOf('<')
  const tail = lastLt === -1 ? '' : text.slice(lastLt)
  if (lastLt !== -1 && looksLikeTagStart(tail, bareNames)) hold = Math.min(hold, lastLt)

  // A bare OPENING tag of a declared tool that is still waiting for its close.
  // The check above only ever sees the LAST `<`, so once `<ask_user_question>`
  // is complete the hold drops to zero and the tag is emitted as text — the
  // block can then never be assembled, which is exactly what a chunked feed of
  // the captured leak does. Hold from that opener until its close arrives;
  // `flush()` releases it if the stream ends first (gate 1 + gate 4).
  if (bareNames !== undefined && lastLt !== -1) {
    const opened = findFirstOpener(text, spans, bareNames, true)
    if (opened !== undefined && opened.close === undefined) hold = Math.min(hold, opened.open.start)
  }

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
function looksLikeTagStart(tail: string, bareNames?: ReadonlySet<string>): boolean {
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
  if (openers.some(opener => opener.startsWith(body) || body.startsWith(opener))) return true

  // Bare markup: `<ask_user_qu` is the front half of a declared tool's opening
  // tag. Without this case that half is emitted as text the moment it arrives
  // and the block can never be assembled — the same split-tag leak as the
  // still-arriving marker above, one layer further out. Only names this request
  // actually declared can hold, so ordinary prose keeps flowing: a sentence
  // that begins `<the` matches no declared name and fails here.
  if (bareNames === undefined) return false
  for (const name of bareNames) {
    if (name.startsWith(body)) return true
  }
  return false
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

  /**
   * The bare-name set for this request, or undefined when
   * {@link RecoveryGate.bareMarkup} is off.
   *
   * Resolved once in the constructor: {@link bareNamesFor} walks every
   * accepted-parameter set, and `add()` runs per chunk.
   */
  private readonly bareNames: ReadonlySet<string> | undefined

  constructor(gate: RecoveryGate) {
    this.gate = gate
    this.bareNames = gate.bareMarkup === true ? bareNamesFor(gate) : undefined
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
      return { text, prose: hasProse(text, this.gate), withheld: false }
    }

    // Any MARKED opening tag counts, not only a block opener: the captured
    // `<｜DSML｜ validate>` wears an invented name, is therefore not a block
    // opener, and is still exactly the tag whose closer a sweep would mutilate.
    this.openerSeen ||= hasMarkedOpener(this.pending, this.bareNames)

    for (;;) {
      const found = findFirstOpener(this.pending, ignoredSpans(this.pending), this.bareNames, true)
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
        const head = stripMarkup(this.pending.slice(0, found.open.start), this.gate).trimEnd()
        if (head !== '') parts.push(head)
        this.pending = this.pending.slice(found.close === undefined ? found.open.start : found.close.end + 1)
        if (found.close === undefined) return finish(parts, calls, this.takeWithheld(), this.gate)
        continue
      }

      const head = this.stripDebris(this.pending.slice(0, found.open.start))
      if (head !== '') parts.push(head)

      // Gate 1: the close has not arrived, so nothing may be committed. The
      // whole block is held — emitting it now would make it unparseable when
      // the rest finally arrives.
      if (found.close === undefined) {
        this.pending = this.pending.slice(found.open.start)
        return finish(parts, calls, this.takeWithheld(), this.gate)
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

    // Nothing committable left: emit everything except a tail that could still
    // turn into a tag, or that sits inside an unclosed code span.
    const hold = holdFrom(this.pending, ignoredSpans(this.pending), this.bareNames)
    if (hold > 0) {
      const tail = this.stripDebris(this.pending.slice(0, hold))
      if (tail !== '') parts.push(tail)
    }
    this.pending = this.pending.slice(hold)

    return finish(parts, calls, this.takeWithheld(), this.gate)
  }

  /** End of stream: hand back everything still held — minus the debris. */
  flush(): BufferOutcome {
    let text = this.pending
    this.pending = ''

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
      text = this.nativeCalls
        ? stripMarkup(text, this.gate)
        : stripLoneClosers(text, this.withHeld, this.openerSeen, this.gate)
    }

    const state = this.takeWithheld()
    const outcome: BufferOutcome = { text, prose: hasProse(text, this.gate), withheld: state.withheld }
    if (state.withheldReason !== undefined) outcome.withheldReason = state.withheldReason
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
    if (this.nativeCalls) return stripMarkup(text, this.gate)
    if (this.debris()) return stripStray(text, this.withHeld, this.gate)
    return stripLoneClosers(text, this.withHeld, this.openerSeen, this.gate)
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
  gate?: RecoveryGate,
): BufferOutcome {
  const text = parts.join('')
  const outcome: BufferOutcome = { text, prose: hasProse(text, gate), withheld: state.withheld }
  if (state.withheldReason !== undefined) outcome.withheldReason = state.withheldReason
  if (calls.length > 0) outcome.calls = [...calls]
  return outcome
}
