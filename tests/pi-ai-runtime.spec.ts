/**
 * `piAiRuntimeInfo()` consistency.
 *
 * The whole #24/#25/#26 fix hinges on one question — which pi-ai copy does
 * THIS plugin resolve — and the answer must be self-consistent: the reported
 * generation has to follow the version of the manifest owning the reported
 * path, the path has to be the one Node actually resolves, and a market-style
 * install (no local pi-ai at all) must report host-provided WITHOUT crashing
 * the standalone CLI — which is why the detection deliberately never imports
 * pi-ai. These tests do NOT pin a version number: this checkout resolves
 * 0.85.1 today, but the peer range admits anything below 0.88, and the point
 * of the gate is to FOLLOW the resolution, not to freeze it.
 */

import { describe, expect, it } from 'vitest'
import { piAiRuntimeFor, piAiRuntimeInfo } from '../src/pi-ai-runtime.ts'

describe('piAiRuntimeFor (the branch that only runs on other machines)', () => {
  it('reports host-provided and defaults to the modern gate when nothing resolves', () => {
    // A market install probed outside the host: no local pi-ai at all. Inside
    // DSH the host supplies it, and hosts that normalize (0.2.0+) ship 0.87.1
    // — so the pass-through branch is the correct default, and it is also
    // harmless on older hosts, whose native 0.85 shape is an identity under
    // either branch.
    const info = piAiRuntimeFor(undefined)
    expect(info.generation).toBe('modern')
    expect(info.resolvedLocally).toBe(false)
    expect(info.version).toBeUndefined()
    expect(info.resolvedFrom).toBeUndefined()
  })

  it('decides the generation from the manifest beside the resolved entry', () => {
    const modern = piAiRuntimeFor('/nonexistent/pi-ai/dist/index.js')
    // No readable manifest there: conservatively legacy, and resolvedLocally
    // still true so doctor can show the path it tried.
    expect(modern.resolvedLocally).toBe(true)
    expect(modern.generation).toBe('legacy')
    expect(modern.version).toBeUndefined()
    expect(modern.resolvedFrom).toBe('/nonexistent/pi-ai/dist/index.js')
  })
})

describe('piAiRuntimeInfo', () => {
  it('reports the generation the resolved manifest version belongs to', () => {
    const info = piAiRuntimeInfo()
    // Within the peer range (>=0.85.0 <0.88.0) the split is exactly 0.87+.
    if (info.resolvedLocally && info.version !== undefined) {
      const minor = Number(/^0\.(\d+)\./u.exec(info.version)?.[1])
      expect(info.generation).toBe(minor >= 87 ? 'modern' : 'legacy')
    }
  })

  it('reports the file Node resolves for the bare specifier', () => {
    const info = piAiRuntimeInfo()
    expect(info.resolvedLocally).toBe(true)
    expect(info.resolvedFrom).toContain('pi-ai')
    expect(info.resolvedFrom).toMatch(/\.js$/u)
  })

  it('reads the version from the manifest owning the resolved file', () => {
    const info = piAiRuntimeInfo()
    if (!info.resolvedLocally) return
    // Within the peer range every release spells its version 0.<minor>.<patch>;
    // anything else means the wrong manifest was read (for instance a
    // virtual-store parent's package.json).
    expect(info.version).toMatch(/^0\.(8[5-7])\.\d+/u)
  })

  it('is stable across calls (resolved once, then cached)', () => {
    expect(piAiRuntimeInfo()).toBe(piAiRuntimeInfo())
  })
})
