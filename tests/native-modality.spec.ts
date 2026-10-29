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

  it('treats both regional routers as routers, not models', () => {
    // One concept, two ids: CN publishes `auto`, the international gateway
    // publishes `default-model`. Both are named "Auto", both carry
    // `isDefault: true`, and both are the ONLY entry in their roster that
    // declares no `credits` — measured 2026-10-22: CN 19 of 20 priced, global
    // 27 of 28. A row the plugin cannot price is a row whose cost it cannot
    // state, so neither is offered.
    expect(nativeModalityOf('auto')).toBe('router')
    expect(nativeModalityOf('default-model')).toBe('router')
    // The other international aliases are NOT routers: they declare real
    // prices and are the rows a user actually picks.
    for (const id of ['fast-model', 'balanced-model', 'primary-model', 'deep-model']) {
      expect(nativeModalityOf(id), id).not.toBe('router')
    }
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
    // A snapshot, not a live read: 15 ids. Growing it must be a deliberate act
    // with a stated source, so this asserts the size rather than letting ids
    // drift in — an id added here silently pre-checks an image box on every
    // refresh and lets a model the docs call text-only receive images.
    //
    // The count moved 13 → 15 with the two upstream-described ids pinned by the
    // next test. Keep this number and `docs/DESIGN.md` 「核验表」 in step: the
    // design doc is this table's provenance record, and a size here without a
    // row there is exactly the drift this assertion exists to catch.
    expect(Object.keys(NATIVE_MODALITY_BY_MODEL_ID)).toHaveLength(15)
    for (const [id, kind] of Object.entries(NATIVE_MODALITY_BY_MODEL_ID)) {
      expect(kind === 'text' || kind === 'multimodal', id).toBe(true)
    }
  })

  it('records the two upstream-described ids without opening a third evidence class', () => {
    // Two evidence classes live in one record, and the newer one is WEAKER:
    // vendor documentation for the original 13, the upstream catalog's own
    // description for these two. Pinning WHICH two stops a future addition from
    // quietly joining the weaker class by imitation — the catalog calls 15/16
    // CN models image-capable, so "the catalog said so" is not a licence.
    for (const id of ['space-bunny', 'minimax-m3.1-flash']) {
      expect(NATIVE_MODALITY_BY_MODEL_ID[id], id).toBe('multimodal')
      expect(imageDefaultFor({ id, supportsImages: true }), id).toBe(true)
    }
    // …and they must not drag their families along, exactly like every other
    // entry (the table matches on the exact id).
    expect(nativeModalityOf('minimax-m3.1')).toBe('unknown')
    expect(nativeModalityOf('space-bunny-2')).toBe('unknown')
  })
})
