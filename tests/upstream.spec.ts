import { describe, expect, it } from 'vitest'
import {
  classifyUpstreamError,
  parseCreditMultiplier,
  parseReasoning,
  parseUpstreamModel,
  prepareChatBody,
  regionOf,
} from '../src/upstream.ts'

describe('prepareChatBody', () => {
  it('forces streaming and flattens object tool_choice', () => {
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'glm-5.3',
      stream: false,
      tool_choice: { type: 'function', function: { name: 'read' } },
    }))) as Record<string, unknown>
    expect(prepared['stream']).toBe(true)
    expect(prepared['tool_choice']).toBe('read')
  })

  it('drops tools when tool_choice is none', () => {
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      tool_choice: 'none',
      tools: [{ type: 'function', function: { name: 'read' } }],
    }))) as Record<string, unknown>
    expect(prepared['tool_choice']).toBeUndefined()
    expect(prepared['tools']).toBeUndefined()
  })

  it('passes non-JSON bodies through untouched', () => {
    expect(prepareChatBody('not json')).toBe('not json')
  })
})

describe('classifyUpstreamError', () => {
  it('maps credit exhaustion from Chinese markers', () => {
    expect(classifyUpstreamError(400, '积分不足')).toBe('hard_credit')
  })

  it('maps dead sessions ahead of generic client errors', () => {
    expect(classifyUpstreamError(400, 'Offline user session not found')).toBe('session_dead')
  })

  it('maps rate limits and server faults', () => {
    expect(classifyUpstreamError(429, '')).toBe('soft_rate')
    expect(classifyUpstreamError(503, '')).toBe('server')
    expect(classifyUpstreamError(404, '')).toBe('not_found')
  })
})

describe('regionOf', () => {
  it('routes workbuddy.ai to global and everything else to cn', () => {
    expect(regionOf('www.workbuddy.ai')).toBe('global')
    expect(regionOf('app.workbuddy.ai')).toBe('global')
    expect(regionOf('www.codebuddy.cn')).toBe('cn')
    expect(regionOf('')).toBe('cn')
  })
})

describe('parseCreditMultiplier', () => {
  it('parses the observed upstream spellings', () => {
    expect(parseCreditMultiplier('x0.79 credits')).toBe(0.79)
    expect(parseCreditMultiplier('x0.05')).toBe(0.05)
    expect(parseCreditMultiplier('x0.00 credits')).toBe(0)
  })

  it('returns undefined rather than guessing', () => {
    expect(parseCreditMultiplier(undefined)).toBeUndefined()
    expect(parseCreditMultiplier('free')).toBeUndefined()
    expect(parseCreditMultiplier(0.5)).toBeUndefined()
  })
})

describe('parseReasoning', () => {
  it('keeps declared effort levels', () => {
    expect(parseReasoning({ supportedEfforts: ['low', 'high', 'xhigh'], defaultEffort: 'high' })).toEqual({
      supportedEfforts: ['low', 'high', 'xhigh'],
      defaultEffort: 'high',
    })
  })

  it('drops an empty reasoning object instead of reporting a capability', () => {
    expect(parseReasoning({})).toBeUndefined()
    expect(parseReasoning({ unsupported: 1 })).toBeUndefined()
  })
})

describe('parseUpstreamModel', () => {
  it('carries the fields the plugin card displays', () => {
    const model = parseUpstreamModel({
      id: 'glm-5.3',
      name: 'GLM-5.3',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 48_000,
      credits: 'x0.79',
      supportsImages: true,
      reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high' },
      descriptionZh: '能力均衡',
    })
    expect(model).toMatchObject({
      id: 'glm-5.3',
      contextWindow: 1_000_000,
      maxTokens: 48_000,
      creditMultiplier: 0.79,
      multimodal: true,
      descriptionZh: '能力均衡',
    })
    expect(model?.reasoning?.supportedEfforts).toEqual(['low', 'high'])
  })

  it('rejects disabled models and models without token limits', () => {
    expect(parseUpstreamModel({ id: 'a', disabled: true, maxInputTokens: 1, maxOutputTokens: 1 })).toBeUndefined()
    expect(parseUpstreamModel({ id: 'b', maxInputTokens: 0, maxOutputTokens: 1 })).toBeUndefined()
    expect(parseUpstreamModel({ id: '', maxInputTokens: 1, maxOutputTokens: 1 })).toBeUndefined()
  })
})
