/**
 * The inline reason rule: key content, not a JSON dump.
 *
 * Both tables used to append the recorded body verbatim, so a rate-limited row
 * printed its reset instant three times (label, body, and now the relative form)
 * followed by a `requestId` nobody reads. These pin what replaced it.
 *
 * @module dsh-connect-workbuddy/tests/probe-reason
 */
import { describe, expect, it } from 'vitest'
import { inlineProbeReason } from '../src/client/probe-reason.ts'

/** A real 429 body, verbatim from this machine's pool store. */
const RATE_LIMIT_BODY = '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-10-02 06:53:43 UTC+8 重置，'
  + '您也可以切换其他模型继续使用。","requestId":"c615a1bf-5823-4378-8fa2-bdc9d68de3a1"}'

describe('inlineProbeReason', () => {
  it('drops the body of a limit whose label already prints the reset time', () => {
    // The whole point: this body restates the instant shown beside it. Inlining
    // it buries the row's three useful facts under a duplicate of themselves.
    expect(inlineProbeReason('rate-limited', RATE_LIMIT_BODY)).toBeUndefined()
    expect(inlineProbeReason('out-of-credit', RATE_LIMIT_BODY)).toBeUndefined()
  })

  it('lifts the human sentence out of a JSON envelope', () => {
    // `code` and `requestId` are protocol, not prose. The reader gets `msg`.
    expect(inlineProbeReason('failed', RATE_LIMIT_BODY))
      .toBe('您的使用量已超出频率限制，将在 2026-10-02 06:53:43 UTC+8 重置，您也可以切换其他模型继续使用。')
  })

  it('strips the redundant transport prefix', () => {
    // It is an English diagnostic wrapper on a Chinese card; the error name is
    // the part that identifies the cause.
    expect(inlineProbeReason('unavailable', 'transport error: TimeoutError: The operation was aborted due to timeout'))
      .toBe('TimeoutError: The operation was aborted due to timeout')
    expect(inlineProbeReason('unavailable', 'transport error: AbortError')).toBe('AbortError')
  })

  it('truncates a pathological body instead of pushing the table off screen', () => {
    const huge = 'x'.repeat(500)
    const reason = inlineProbeReason('unavailable', huge)
    expect(reason).toHaveLength(72)
    expect(reason?.endsWith('…')).toBe(true)
  })

  it('leaves a short plain message alone', () => {
    expect(inlineProbeReason('not-found', 'model vanished')).toBe('model vanished')
  })

  it('has nothing to add when no message was recorded', () => {
    // Measurements written before the field existed are still valid records.
    expect(inlineProbeReason('unavailable', undefined)).toBeUndefined()
    expect(inlineProbeReason('unavailable', '')).toBeUndefined()
  })

  it('falls back to the raw text when a body only LOOKS like JSON', () => {
    // A truncated body must not cost the user the reason entirely: keeping the
    // braces is uglier than a parsed sentence, but far better than nothing.
    expect(inlineProbeReason('unavailable', '{"code":6004,"msg":"trunc')).toBe('{"code":6004,"msg":"trunc')
  })

  it('falls back to the raw text when JSON carries no msg', () => {
    expect(inlineProbeReason('failed', '{"code":500}')).toBe('{"code":500}')
  })
})
