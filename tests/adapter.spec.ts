import { describe, expect, it } from 'vitest'
import { workBuddyModelInput, workBuddyThinkingLevelMap } from '../src/adapter.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

function model(reasoning?: WorkBuddyModelInfo['reasoning'], multimodal?: boolean): WorkBuddyModelInfo {
  return {
    id: 'test',
    name: 'Test',
    contextWindow: 200_000,
    maxTokens: 32_000,
    ...multimodal === undefined ? {} : { multimodal },
    ...reasoning === undefined ? {} : { reasoning },
  }
}

describe('workBuddyModelInput', () => {
  it('offers images only for models the user opted into image input', () => {
    expect(workBuddyModelInput(model(undefined, true))).toEqual(['text', 'image'])
    expect(workBuddyModelInput(model(undefined, false))).toEqual(['text'])
    expect(workBuddyModelInput(model())).toEqual(['text'])
  })
})

describe('workBuddyThinkingLevelMap', () => {
  it('maps only upstream-advertised levels to identical wire values', () => {
    expect(workBuddyThinkingLevelMap(model({
      supportedEfforts: ['low', 'high', 'xhigh'],
      defaultEffort: 'high',
      canDisableThinking: true,
    }))).toEqual({
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: 'xhigh',
      max: null,
    })
  })

  it('does not expose off when WorkBuddy says thinking cannot be disabled', () => {
    expect(workBuddyThinkingLevelMap(model({
      supportedEfforts: ['high'],
      canDisableThinking: false,
    }))).toMatchObject({ off: null, high: 'high' })
  })

  it('does not report reasoning without supported effort levels', () => {
    expect(workBuddyThinkingLevelMap(model())).toBeUndefined()
    expect(workBuddyThinkingLevelMap(model({ canDisableThinking: true }))).toBeUndefined()
  })

  it('drops unknown upstream effort spellings', () => {
    expect(workBuddyThinkingLevelMap(model({ supportedEfforts: ['unknown'] }))).toBeUndefined()
  })
})
