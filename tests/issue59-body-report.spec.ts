import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendBodyReport,
  bodyReportDirectory,
  countChars,
  describeBody,
  recordBodyReport,
  usageOfChunk,
  WORKBUDDY_BODY_REPORT_ENV,
} from '../src/body-report.ts'

/**
 * Issue #59: the same conversation was charged ~708K tokens by the CN gateway
 * and ~1.374M by the international one, so switching regions turned into an
 * instant `code 11115 prompt is too long`.
 *
 * Two measurements narrowed it to a single question, and the report answered
 * it. The reporter ran this project's content-class probe in BOTH regions and
 * got identical tokens-per-1000-chars on byte-identical prose, code and JSON
 * (0.98–1.06), so identical bytes bill identically. A code trace was read as
 * showing that historical `reasoning` never reaches the wire — that reading was
 * wrong. `bodyBytes` then came back at 0.9995 while `promptTokens` came back at
 * 0.696, which is only possible if the same bytes are counted into different
 * buckets: CN text 741,687 vs GL 184,821, CN reasoning 72,270 vs GL 627,994,
 * complementary residual 0.3%. The buckets follow pi-ai's replay: a thinking
 * block survives as thinking only when its own `provider`/`api`/`model` all
 * match the request in flight (`transform-messages.js`, `isSameModel`); every
 * other one is downgraded to text — downgraded, not dropped. Two provider ids for
 * one model is therefore why a transcript built on one side is billed as text on
 * the other. This report is what lets a reporter see that split
 * on their own machine, WITHOUT either region needing credit, because the body
 * is assembled locally before `14018 Credits exhausted` can be returned.
 *
 * Two properties are guarded here and neither is cosmetic:
 *   1. the shape is faithful — the buckets a long session is made of (tool
 *      results, tool-call arguments, CJK vs ASCII, and reasoning) must be
 *      distinguishable, or the diff answers nothing;
 *   2. it carries COUNTS ONLY — a report that leaked message text would be
 *      unusable as a diagnostic a user can safely paste into an issue.
 */

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workbuddy-body-report-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** A body shaped like the ones pi-ai actually sends to the shim. */
function bodyOf(messages: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 8192,
    ...extra,
  })
}

describe('counting characters the way the two gateways bill them', () => {
  it('separates CJK from ASCII, because the measured spread is 3×', () => {
    // 0.669 vs 0.224 tokens per character, measured on both regions — the whole
    // reason a single total character count cannot answer the question.
    const { chars, cjkChars } = countChars('abc敏捷的棕色狐狸')
    expect(chars).toBe(10)
    expect(cjkChars).toBe(7)
  })

  it('counts a code point outside the BMP once, not as two surrogates', () => {
    // Otherwise every emoji and rare Han character would inflate the ASCII
    // bucket by one, and the CJK/non-CJK split is the whole point.
    const { chars, cjkChars } = countChars('a😀')
    expect(chars).toBe(2)
    expect(cjkChars).toBe(0)
    expect(countChars('𠀋').cjkChars).toBe(1)
  })

  it('treats fullwidth forms and CJK punctuation as CJK', () => {
    expect(countChars('，。！１').cjkChars).toBe(4)
  })
})

describe('describing what a request body is made of', () => {
  it('types each block by the ROLE carrying it', () => {
    const report = describeBody(bodyOf([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
      { role: 'tool', content: 'file contents here' },
      { role: 'assistant', content: 'answer' },
    ]), 'cn', Date.UTC(2026, 9, 14))
    expect(report?.messages.map(message => message.blocks.map(entry => entry.type)))
      .toEqual([['system'], ['text'], ['tool-result'], ['text']])
    expect(report?.messageCount).toBe(4)
    // A tool result folded into `text` would hide the bucket a long agentic
    // session is mostly made of — the failure mode this assertion exists for.
    expect(report?.messages[2]?.chars).toBe('file contents here'.length)
  })

  it('counts tool-call arguments, which are sent and therefore billed', () => {
    const report = describeBody(bodyOf([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/upstream.ts"}' } }],
      },
    ]), 'cn', 0)
    const call = report?.messages[0]?.blocks.find(entry => entry.type === 'tool-call')
    expect(call?.chars).toBe('read_file{"path":"src/upstream.ts"}'.length)
  })

  it('records a reasoning field when one appears — the empirical check on the code trace', () => {
    // pi-ai replays a thinking block under whichever field name its upstream
    // stream used, so this bucket is expected to be non-empty in real captures
    // and its SIZE is the interesting number. The report counts it rather than
    // assuming, which is what lets a reporter confirm the split on their own
    // machine.
    const report = describeBody(bodyOf([
      { role: 'assistant', content: '', reasoning_content: '思考内容' },
      { role: 'assistant', content: '', reasoning: '' },
    ]), 'cn', 0)
    expect(report?.messages[0]?.blocks).toEqual([{ type: 'reasoning', chars: 4, cjkChars: 4 }])
    // An EMPTY field is not a block: it carries no characters to bill.
    expect(report?.messages[1]?.blocks).toEqual([])
  })

  it('counts the tools array, which is re-sent on every request', () => {
    const report = describeBody(bodyOf([{ role: 'user', content: 'hi' }], {
      tools: [{ type: 'function', function: { name: 'grep', description: '搜索', parameters: { type: 'object' } } }],
    }), 'cn', 0)
    expect(report?.tools.type).toBe('tools')
    expect(report?.tools.chars).toBeGreaterThan(0)
    expect(report?.tools.cjkChars).toBe(2)
    // The total includes tools, so a two-body diff cannot be off by the schemas.
    expect(report?.chars).toBe((report?.messages[0]?.chars ?? 0) + (report?.tools.chars ?? 0))
  })

  it('records an image part by presence, since it has no prose to count', () => {
    const report = describeBody(bodyOf([
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ]), 'cn', 0)
    expect(report?.messages[0]?.blocks.map(entry => entry.type)).toEqual(['text', 'image'])
  })

  it('reports the model id, byte size and timestamp that make two captures comparable', () => {
    const report = describeBody(bodyOf([{ role: 'user', content: 'hi' }]), 'global', Date.UTC(2026, 9, 14, 6, 53, 7))
    expect(report?.model).toBe('deepseek-v4.1-flash')
    expect(report?.region).toBe('global')
    expect(report?.at).toBe('2026-10-14T06:53:07.000Z')
    expect(report?.bodyBytes).toBeGreaterThan(0)
  })

  it('never carries message text, tool arguments or the model prompt', () => {
    // The hard rule. A diagnostic a user pastes into a public issue must not be
    // able to leak a source file, a prompt or a snippet of their conversation.
    const secret = 'SECRET-PAYLOAD-DO-NOT-LEAK-敏捷'
    const report = describeBody(bodyOf([
      { role: 'system', content: secret },
      { role: 'tool', content: secret },
      { role: 'assistant', content: secret, reasoning_content: secret },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: secret, type: 'function', function: { name: secret, arguments: JSON.stringify({ secret }) } }],
      },
    ], { tools: [{ type: 'function', function: { name: secret, description: secret } }] }), 'cn', 0)
    expect(report).toBeDefined()
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('SECRET')
    expect(serialized).not.toContain('敏捷')
    // The keys are the vocabulary of the report; the values are numbers and the
    // region/model/role names, which the caller already knows.
    expect(serialized).toContain('tool-result')
    expect(serialized).toContain('tool-call')
  })

  it('returns undefined instead of throwing on a body it cannot read', () => {
    expect(describeBody('not json', 'cn', 0)).toBeUndefined()
    expect(describeBody('[]', 'cn', 0)).toBeUndefined()
    // A body with no messages array is still describable — the caller only ever
    // loses detail, never the request.
    expect(describeBody('{}', 'cn', 0)?.messageCount).toBe(0)
  })
})

describe('where the report goes, and when it does not', () => {
  it('is OFF unless the environment asks for it', () => {
    expect(bodyReportDirectory({})).toBeUndefined()
    expect(bodyReportDirectory({ [WORKBUDDY_BODY_REPORT_ENV]: '   ' })).toBeUndefined()
  })

  it('reads 1/true as the harness-home default and anything else as a path', () => {
    const home = bodyReportDirectory({ [WORKBUDDY_BODY_REPORT_ENV]: '1' })
    expect(home?.endsWith(join('body-reports'))).toBe(true)
    expect(bodyReportDirectory({ [WORKBUDDY_BODY_REPORT_ENV]: 'true' })).toBe(home)
    // A path is taken verbatim — including one with spaces, which is why the
    // value is trimmed but never split.
    expect(bodyReportDirectory({ [WORKBUDDY_BODY_REPORT_ENV]: ` ${directory} ` })).toBe(directory)
  })

  it('writes one JSON Line per request, one file per region', async () => {
    const env = { [WORKBUDDY_BODY_REPORT_ENV]: directory }
    await recordBodyReport('cn', bodyOf([{ role: 'user', content: '敏捷' }]), { env, nowMs: 1000 })
    await recordBodyReport('global', bodyOf([{ role: 'user', content: 'hi' }]), { env, nowMs: 2000 })
    await recordBodyReport('cn', bodyOf([{ role: 'user', content: '敏捷敏捷' }]), { env, nowMs: 3000 })

    expect((await readdir(directory)).sort()).toEqual(['cn.jsonl', 'global.jsonl'])
    const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    // JSON Lines (not one file per request) because one turn makes many upstream
    // calls — one per tool step — and the LAST one is the interesting one.
    expect(JSON.parse(lines[1] as string).chars).toBeGreaterThan(JSON.parse(lines[0] as string).chars)
  })

  it('is silent when disabled: no directory is created at all', async () => {
    await recordBodyReport('cn', bodyOf([{ role: 'user', content: 'hi' }]), { env: {} })
    expect(await readdir(directory)).toEqual([])
  })

  it('never throws out of the request path, whatever the target looks like', async () => {
    // The configured directory sits UNDER a regular file, so `mkdir` must fail.
    // That failure has to reach the caller's logger instead of a chat request.
    const blocker = join(directory, 'not-a-directory')
    await writeFile(blocker, 'x')

    const errors: unknown[] = []
    // Still resolves — to a no-op handle, so the caller can invoke it
    // unconditionally when the upstream's usage arrives later.
    const attach = await recordBodyReport('cn', bodyOf([{ role: 'user', content: 'x' }]), {
      env: { [WORKBUDDY_BODY_REPORT_ENV]: join(blocker, 'nested') },
      onError: error => errors.push(error),
    })
    expect(typeof attach).toBe('function')
    expect(() => attach({ promptTokens: 1 })).not.toThrow()
    expect(errors).toHaveLength(1)
  })
})

/**
 * The charged side of the comparison (issue #59).
 *
 * The report had only the SENT side (`bodyBytes`, `chars`), which left every
 * capture ambiguous: "the gateway counted the same bytes differently" and "the
 * two bodies were not the same" are indistinguishable from the sent side alone.
 * These cases pin the second half — reading it out of the stream and putting it
 * on the line of the request it belongs to.
 */
describe('what the upstream counted, read from the stream', () => {
  it('takes prompt, completion and cache-hit counts from an OpenAI-shaped usage block', () => {
    expect(usageOfChunk({ usage: { prompt_tokens: 708000, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 5000 } } }))
      .toEqual({ promptTokens: 708000, completionTokens: 12, cachedTokens: 5000 })
  })

  it('accepts the DOMESTIC gateway\'s other spelling of the cache-hit count', () => {
    // The two gateways were measured to report the hit count under different
    // names; reading only one would show 0 on the other side and make the number
    // the comparison turns on look like a difference in caching rather than in
    // naming.
    expect(usageOfChunk({ usage: { prompt_tokens: 900, prompt_cache_hit_tokens: 100 } }))
      .toEqual({ promptTokens: 900, cachedTokens: 100 })
  })

  it('returns undefined for a chunk with no usage at all', () => {
    // Every chunk but the last one. Crucially NOT `{}`: an absent measurement
    // must never be recorded as a measurement of zero.
    expect(usageOfChunk({ choices: [{ delta: { content: 'hi' } }] })).toBeUndefined()
    expect(usageOfChunk({ usage: {} })).toBeUndefined()
    expect(usageOfChunk({ usage: null })).toBeUndefined()
  })

  it('rejects values that are not usable token counts', () => {
    expect(usageOfChunk({ usage: { prompt_tokens: 'lots' } })).toBeUndefined()
    expect(usageOfChunk({ usage: { prompt_tokens: Number.NaN } })).toBeUndefined()
    expect(usageOfChunk({ usage: { prompt_tokens: -1 } })).toBeUndefined()
  })

  it('annotates the line of the request it belongs to, and adds no new line', async () => {
    const env = { [WORKBUDDY_BODY_REPORT_ENV]: directory }
    const first = await recordBodyReport('cn', bodyOf([{ role: 'user', content: 'one' }]), { env, nowMs: 1000 })
    const second = await recordBodyReport('cn', bodyOf([{ role: 'user', content: 'two' }]), { env, nowMs: 2000 })

    first({ promptTokens: 111, completionTokens: 7 })
    second({ promptTokens: 222 })
    await vi.waitFor(async () => {
      const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
      expect(JSON.parse(lines[1] as string).promptTokens).toBe(222)
    })

    const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
    // Two requests, two lines. A third "usage only" line would silently become
    // the line the reporter diffs against the other region.
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] as string).promptTokens).toBe(111)
    expect(JSON.parse(lines[1] as string).promptTokens).toBe(222)
    expect(JSON.parse(lines[1] as string).completionTokens).toBeUndefined()
  })

  it('leaves the line untouched (and adds nothing) when the upstream said nothing', async () => {
    const env = { [WORKBUDDY_BODY_REPORT_ENV]: directory }
    const attach = await recordBodyReport('cn', bodyOf([{ role: 'user', content: 'x' }]), { env, nowMs: 1000 })
    attach(undefined)
    await new Promise(resolve => setTimeout(resolve, 50))
    const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    // Absent, not zero.
    expect(JSON.parse(lines[0] as string).promptTokens).toBeUndefined()
  })

  it('applies only the first measurement, so a failover retry cannot overwrite the serve', async () => {
    const env = { [WORKBUDDY_BODY_REPORT_ENV]: directory }
    const attach = await recordBodyReport('cn', bodyOf([{ role: 'user', content: 'x' }]), { env, nowMs: 1000 })
    attach({ promptTokens: 111 })
    // Let the first write LAND before the second arrives, so this pins the
    // handle's own idempotence rather than racing two concurrent writes.
    await vi.waitFor(async () => {
      const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
      expect(JSON.parse(lines[0] as string).promptTokens).toBe(111)
    })
    attach({ promptTokens: 999 })
    await new Promise(resolve => setTimeout(resolve, 50))
    const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
    expect(JSON.parse(lines[0] as string).promptTokens).toBe(111)
  })

  it('does not let a second handle for the SAME body overwrite the first measurement', async () => {
    // A failover retry opens its own stream for the same prepared body, and
    // therefore gets its own handle. The on-disk "already annotated" check is
    // what stops that second measurement from replacing the first — the
    // in-handle flag cannot see a different handle.
    const env = { [WORKBUDDY_BODY_REPORT_ENV]: directory }
    const body = bodyOf([{ role: 'user', content: 'same body' }])
    const first = await recordBodyReport('cn', body, { env, nowMs: 1000 })
    const retry = await recordBodyReport('cn', body, { env, nowMs: 1001 })
    first({ promptTokens: 111 })
    await vi.waitFor(async () => {
      const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
      expect(JSON.parse(lines[0] as string).promptTokens).toBe(111)
    })
    // The retry's own line (the second one) gets its own measurement, and the
    // first line keeps the first one.
    retry({ promptTokens: 999 })
    await vi.waitFor(async () => {
      const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
      expect(JSON.parse(lines[1] as string).promptTokens).toBe(999)
    })
    const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
    expect(JSON.parse(lines[0] as string).promptTokens).toBe(111)
    expect(lines).toHaveLength(2)
  })

  it('does not annotate a DIFFERENT line that shares the timestamp, model and region', async () => {
    // The scan walks BACKWARD from the end, so to catch a missing identity check
    // the handle we call must belong to the EARLIER line while a LATER line is
    // indistinguishable except for its identity fields. Two requests timestamped
    // in the same millisecond is the real case: annotating by `at` alone would
    // put one request's measurement onto another request's line.
    const env = { [WORKBUDDY_BODY_REPORT_ENV]: directory }
    const earlier = await recordBodyReport('cn', bodyOf([{ role: 'user', content: 'a' }]), { env, nowMs: 1000 })
    await recordBodyReport('cn', bodyOf([{ role: 'user', content: 'a'.repeat(500) }]), { env, nowMs: 1000 })
    // Only the EARLIER (smaller) body is measured.
    earlier({ promptTokens: 222 })
    await vi.waitFor(async () => {
      const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
      expect(JSON.parse(lines[0] as string).promptTokens).toBe(222)
    })
    const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    // The later, larger body must stay unannotated despite the shared `at`.
    expect(JSON.parse(lines[1] as string).promptTokens).toBeUndefined()
  })

  it('does not annotate a line with the same byte size but a different message count', async () => {
    // `bodyBytes` alone is not an identity: an extra message costs a fixed 29
    // bytes, so a longer single message and three shorter ones can serialize to
    // exactly the same length while describing different prompts. With both
    // shipped for the same `at`, only `messageCount` tells them apart.
    const env = { [WORKBUDDY_BODY_REPORT_ENV]: directory }
    // Tuned so both bodies serialize to exactly 196 bytes against `bodyOf`.
    const oneLong = bodyOf([{ role: 'user', content: 'x'.repeat(51) }])
    const twoShort = bodyOf([
      { role: 'user', content: 'y'.repeat(11) },
      { role: 'user', content: 'y'.repeat(11) },
    ])
    const earlier = await recordBodyReport('cn', oneLong, { env, nowMs: 1000 })
    await recordBodyReport('cn', twoShort, { env, nowMs: 1000 })
    const before = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { bodyBytes: number, messageCount: number })
    // Precondition: the two lines are indistinguishable by size, and differ only
    // by message count. If this ever stops holding, the case below is vacuous.
    expect(before[0]!.bodyBytes).toBe(before[1]!.bodyBytes)
    expect(before[0]!.messageCount).not.toBe(before[1]!.messageCount)

    earlier({ promptTokens: 222 })
    await vi.waitFor(async () => {
      const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
      expect(JSON.parse(lines[0] as string).promptTokens).toBe(222)
    })
    const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
    expect(JSON.parse(lines[1] as string).promptTokens).toBeUndefined()
  })
})
