import { describe, expect, it } from 'vitest'
import {
  imageDefaultFor,
  NATIVE_MODALITY_BY_MODEL_ID,
  nativeModalityOf,
} from '../src/native-modality.ts'

/**
 * Model-native multimodality, which is NOT the platform's `supportsImages`
 * flag. On live data that flag is true for 15/16 CN and 23/23 international
 * models — including models the vendor documents as text-only — so it cannot
 * answer "can this model read an image". These tests lock the vendor-verified
 * table in as the only source of that answer, and lock "unknown" to a
 * deliberate no-guess rather than a silent inheritance.
 */
describe('nativeModalityOf', () => {
  it('reports the vendored text-only classifications', () => {
    for (const id of ['glm-5.3', 'glm-5.2', 'hy3', 'hy4-preview', 'deepseek-v4-pro']) {
      expect(nativeModalityOf(id), id).toBe('text')
    }
  })

  it('reports the vendored native-multimodal classifications', () => {
    for (const id of ['glm-5.3-flash', 'glm-5v-turbo', 'kimi-k2.6', 'minimax-m3']) {
      expect(nativeModalityOf(id), id).toBe('multimodal')
    }
  })

  it('treats the auto entry as a router, not a model', () => {
    expect(nativeModalityOf('auto')).toBe('router')
  })

  it('leaves an unlisted model unknown instead of guessing', () => {
    // 'auto' is handled above; these are real-roster ids with no vendor source.
    for (const id of ['hy3-x', 'hy4-preview-f', 'kimi-k2.8-preview', 'gpt-5.6-sol', 'gemini-3.5-flash', 'grok-4.7']) {
      expect(nativeModalityOf(id), id).toBe('unknown')
    }
  })

  it('matches on the EXACT id, never a family prefix', () => {
    // The crux of the table: `glm-5.3` is text while `glm-5.3-flash` is
    // multimodal, so a prefix rule would get one of the two wrong. Likewise
    // `hy3` (text) must not drag `hy3-x` (unverified) with it.
    expect(nativeModalityOf('glm-5.3')).toBe('text')
    expect(nativeModalityOf('glm-5.3-flash')).toBe('multimodal')
    expect(nativeModalityOf('hy3')).toBe('text')
    expect(nativeModalityOf('hy3-x')).toBe('unknown')
    // Anything built by appending must not inherit either.
    expect(nativeModalityOf('glm-5.3-anything')).toBe('unknown')
    expect(nativeModalityOf('hy3-suffix')).toBe('unknown')
  })
})

describe('imageDefaultFor', () => {
  it('pre-checks only a vendor-documented multimodal model', () => {
    expect(imageDefaultFor({ id: 'glm-5.3-flash', supportsImages: true })).toBe(true)
    expect(imageDefaultFor({ id: 'minimax-m3', supportsImages: true })).toBe(true)
  })

  it('leaves a documented text-only model unchecked even though the platform says yes', () => {
    // The defect this table exists to prevent: both WorkBuddy gateways report
    // `supportsImages: true` for these, and pre-checking them sends images to
    // models that cannot read them.
    for (const id of ['glm-5.3', 'glm-5.2', 'hy3', 'hy4-preview', 'deepseek-v4-pro']) {
      expect(imageDefaultFor({ id, supportsImages: true }), id).toBe(false)
    }
  })

  it('leaves an unverified model unchecked rather than trusting the platform flag', () => {
    // 17 of the 23 international models have no vendor source, and the platform
    // flag is true for all of them. "Do not guess" is the whole point.
    expect(imageDefaultFor({ id: 'gpt-5.6-sol', supportsImages: true })).toBe(false)
    expect(imageDefaultFor({ id: 'kimi-k2.8-preview', supportsImages: true })).toBe(false)
    expect(imageDefaultFor({ id: 'auto', supportsImages: true })).toBe(false)
    expect(imageDefaultFor({ id: 'brand-new-model', supportsImages: true })).toBe(false)
  })

  it('honours an explicit platform "no" even for a documented multimodal id', () => {
    // Belt and braces: if the platform ever contradicts the docs with an
    // explicit false, do not pre-check — the request would fail upstream.
    expect(imageDefaultFor({ id: 'minimax-m3', supportsImages: false })).toBe(false)
  })

  it('treats a missing platform flag as no obstacle to a documented model', () => {
    // The table is the authority; the platform flag only gets to veto.
    expect(imageDefaultFor({ id: 'kimi-k2.6' })).toBe(true)
  })
})

describe('NATIVE_MODALITY_BY_MODEL_ID', () => {
  it('vendors exactly the reviewed snapshot, with no partial or empty entries', () => {
    // A snapshot, not a live read: 13 ids reviewed 2026-09-25 in the sibling
    // workbuddy-manager project. Growing it must be a deliberate act with a
    // vendor source, so this asserts the size rather than letting ids drift in.
    expect(Object.keys(NATIVE_MODALITY_BY_MODEL_ID)).toHaveLength(13)
    for (const [id, kind] of Object.entries(NATIVE_MODALITY_BY_MODEL_ID)) {
      expect(kind === 'text' || kind === 'multimodal', id).toBe(true)
    }
  })
})
