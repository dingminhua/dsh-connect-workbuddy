/**
 * The prompt-cache audit's DECISIONS, not its formatting.
 *
 * Every number this script prints is quoted as "the cost of a cache-miss turn",
 * so the two things that decide a row — what counts as a re-bill, and which
 * cause it is attributed to — have to be testable without a real DSH home.
 * The decoding test exists because getting it wrong is SILENT: node's
 * `zstdDecompressSync` returns only the first frame of a multi-frame log and
 * raises nothing, so a broken decoder looks exactly like "a session with one
 * event" — an audit that reports nothing and never complains.
 */
import { describe, expect, it } from 'vitest'
import zlib from 'node:zlib'
import { creditsOf, decodeLog, readEvents, stamp, summarizeSession } from '../scripts/audit-prompt-cache.mjs'

/** One assistant request at `seq`, with an explicit surface and cache read. */
function request(seq: number, { surface, cached, turn = 1, time = 0 }: { surface: number, cached: number, turn?: number, time?: number }) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { turn, usage: { totalTokens: surface, cacheReadTokens: cached, inputTokens: surface - cached } },
  }
}

/** A system prompt version, as the host logs it when the assembled text changes. */
const prompt = (seq: number, time = 0) => ({ type: 'system/message', seq, time, data: { message: { role: 'system' } } });

describe('summarizeSession', () => {
  it('reports a whole-context request as prompt-changed when a prompt version precedes it', () => {
    const events = [
      request(10, { surface: 500_000, cached: 495_000 }),
      prompt(20),
      request(21, { surface: 690_601, cached: 0 }),
    ]
    const rows = summarizeSession(events, { minSurface: 100_000 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ seq: 21, uncached: 690_601, cause: 'prompt-changed' })
  })

  it('calls it cache-expired when nothing in the log changed before it', () => {
    const events = [
      request(10, { surface: 500_000, cached: 495_000 }),
      prompt(5),
      request(21, { surface: 456_151, cached: 0 }),
    ]
    const rows = summarizeSession(events, { minSurface: 100_000 })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.cause).toBe('cache-expired')
  })

  it('ignores a prompt version too far back to explain the request', () => {
    const events = [
      request(10, { surface: 500_000, cached: 495_000 }),
      prompt(20),
      ...Array.from({ length: 30 }, (_, index) => ({ type: 'tool/result', seq: 21 + index })),
      request(60, { surface: 300_000, cached: 0 }),
    ]
    expect(summarizeSession(events, { minSurface: 100_000 })[0]?.cause).toBe('cache-expired')
  })

  it('leaves ordinary warm turns and small surfaces alone', () => {
    const events = [
      request(10, { surface: 500_000, cached: 495_000 }),
      request(11, { surface: 500_500, cached: 498_000 }),
      request(12, { surface: 40_000, cached: 0 }),
    ]
    expect(summarizeSession(events, { minSurface: 100_000 })).toEqual([])
  })

  it('does not call a session\'s very first request a re-bill', () => {
    // Starting a session has no prefix to reuse; counting it would attribute
    // the cost of existence to the bug.
    const events = [request(10, { surface: 690_601, cached: 0 })]
    expect(summarizeSession(events, { minSurface: 100_000 })).toEqual([])
  })
})

describe('decodeLog', () => {
  it('decodes EVERY zstd frame, not just the first', () => {
    const frames = ['{"type":"session"}\n', '{"type":"turn/start"}\n', '{"type":"assistant/message"}\n']
      .map(text => zlib.zstdCompressSync(Buffer.from(text, 'utf8')))
    const text = decodeLog(Buffer.concat(frames))
    expect(text.split('\n').filter((line: string) => line !== '')).toEqual([
      '{"type":"session"}',
      '{"type":"turn/start"}',
      '{"type":"assistant/message"}',
    ])
    // The mutant this pins: node's own decoder returns only the first frame,
    // with no error, which would make the whole audit see one event per log.
    expect(zlib.zstdDecompressSync(Buffer.concat(frames)).toString('utf8')).toBe('{"type":"session"}\n')
  })

  it('reads the events of a decoded log and skips a torn tail line', () => {
    const raw = Buffer.concat([
      zlib.zstdCompressSync(Buffer.from('{"type":"session","seq":1}\n', 'utf8')),
      zlib.zstdCompressSync(Buffer.from('{"type":"turn/start","seq":2}\n{"type":"tru', 'utf8')),
    ])
    expect(readEvents(raw).map(event => event.seq)).toEqual([1, 2])
  })
})

describe('creditsOf', () => {
  it('prices nothing until a rate is supplied', () => {
    // A wrong constant would silently become "the" cost of the bug, so the
    // script refuses to invent one.
    expect(creditsOf(690_601, true, 0, 0.5)).toBe(0)
  })

  it('applies the off-peak factor only outside a peak window', () => {
    expect(creditsOf(1_000_000, true, 0.06, 0.5)).toBeCloseTo(60, 6)
    expect(creditsOf(1_000_000, false, 0.06, 0.5)).toBeCloseTo(30, 6)
  })
})

describe('stamp', () => {
  it('marks weekday working hours as peak and the night as off-peak', () => {
    const peak = stamp(new Date(2026, 10, 12, 10, 0).getTime())
    expect(peak).toMatchObject({ text: '11-12 10:00', peak: true })
    const night = stamp(new Date(2026, 10, 12, 23, 30).getTime())
    expect(night.peak).toBe(false)
    const weekend = stamp(new Date(2026, 10, 14, 10, 0).getTime())
    expect(weekend.peak).toBe(false)
  })
})
