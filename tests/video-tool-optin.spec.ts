/**
 * The video tool is the SECOND capability in this plugin where the MODEL decides
 * to spend credits — an async task that costs WorkBuddy credits and runs tens of
 * seconds to minutes, with no per-call approval seam in the host. Like the image
 * tool, it is opt-IN, and off means the tool is NOT REGISTERED — not "registered
 * but refusing". These cases pin that contract.
 */
import { describe, expect, it } from 'vitest'
import { videoToolRegionOf, regionStateOf } from '../src/index.ts'
import {
  nextRegionPreferredVideoModels,
  nextRegionVideoToolEnabled,
  regionPreferredVideoModelsOf,
  regionVideoToolEnabledOf,
} from '../src/status-paths.ts'

describe('regionVideoToolEnabledOf', () => {
  it('is per-region, so the CN opt-in does not leak into the global tab', () => {
    const value = { regions: { cn: { videoToolEnabled: true } } }
    expect(regionVideoToolEnabledOf(value, 'cn')).toBe(true)
    expect(regionVideoToolEnabledOf(value, 'global')).toBe(false)
  })
})

describe('nextRegionVideoToolEnabled', () => {
  it('changes only that one flag of that one slot', () => {
    const value = { regions: { cn: { enabled: true, enabledModelIds: ['hy3'] }, global: { enabled: false } } }
    const next = nextRegionVideoToolEnabled(value, 'cn', true) as any
    expect(next.cn.videoToolEnabled).toBe(true)
    expect(next.cn.enabled).toBe(true)
    expect(next.cn.enabledModelIds).toEqual(['hy3'])
    expect(next.global.enabled).toBe(false)
  })

  it('round-trips through the reader', () => {
    const on = nextRegionVideoToolEnabled({ regions: { cn: {} } }, 'cn', true)
    expect(regionVideoToolEnabledOf({ regions: on }, 'cn')).toBe(true)
    const off = nextRegionVideoToolEnabled({ regions: on }, 'cn', false)
    expect(regionVideoToolEnabledOf({ regions: off }, 'cn')).toBe(false)
  })
})

describe('the config default is OFF', () => {
  it('treats an empty config as not opted in', () => {
    // The upgrade path matters: nobody's existing profile says videoToolEnabled,
    // so every existing user must land on OFF.
    expect(regionStateOf({}, 'cn').videoToolEnabled).toBeUndefined()
    expect(regionVideoToolEnabledOf({}, 'cn')).toBe(false)
  })

  it('does not interpret the provider switch as the opt-in', () => {
    expect(regionStateOf({ regions: { cn: { enabled: true } } }, 'cn').videoToolEnabled).toBeUndefined()
    expect(regionVideoToolEnabledOf({ regions: { cn: { enabled: true } } }, 'cn')).toBe(false)
  })
})

describe('videoToolRegionOf', () => {
  it('answers none when neither region was opted in', () => {
    expect(videoToolRegionOf({})).toBeUndefined()
    expect(videoToolRegionOf({ regions: { cn: { enabled: true }, global: { enabled: true } } })).toBeUndefined()
    expect(videoToolRegionOf({ regions: { cn: { videoToolEnabled: false }, global: { videoToolEnabled: false } } })).toBeUndefined()
  })

  it('ignores an opt-in on a disabled provider', () => {
    expect(videoToolRegionOf({ regions: { cn: { enabled: false, videoToolEnabled: true } } })).toBeUndefined()
  })

  it('picks the international region when only it was opted in', () => {
    expect(videoToolRegionOf({ regions: { global: { videoToolEnabled: true } } })).toBe('global')
    expect(videoToolRegionOf({ regions: { cn: { videoToolEnabled: false }, global: { videoToolEnabled: true } } })).toBe('global')
  })

  it('prefers the CN region when both were opted in', () => {
    // CN-first is the only backward-compatible order: before this change the
    // tool could ONLY ever use the CN gateway, so an upgrade must not silently
    // move an existing CN user's spending to the other gateway.
    expect(videoToolRegionOf({ regions: { cn: { videoToolEnabled: true }, global: { videoToolEnabled: true } } })).toBe('cn')
  })
})

describe('the card shows the video opt-in on BOTH tabs', () => {
  it('renders the checkbox in the preference block, for whichever tab is open', async () => {
    // Same as the image tool: it writes the flag of whichever tab is open, so a
    // Host reporting no pool state still renders it.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/client/WorkBuddyCard.tsx', import.meta.url), 'utf8')
    expect(source).toContain('toggleVideoTool(activeRegion')
    expect(source).toContain('videoToolOn(activeRegion)')
    // Its own class: not the shared .dsm-workbuddy-pref-check (contract the
    // credit-switch suite selects on), and not the image tool's class either.
    expect(source).toContain('dsm-workbuddy-video-tool-check')
    expect(source).not.toContain("videoToolPreference = activeRegion === 'cn'")
  })

  it('offers a per-mode model picker once the video tool is on', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/client/WorkBuddyCard.tsx', import.meta.url), 'utf8')
    // The picker is a property of the switch: it is gated on the tool being
    // authorized for the open tab, and on the roster having been read.
    expect(source).toContain('activeRegionOn && videoToolOn(activeRegion)')
    expect(source).toContain("'text-to-video', 'image-to-video'")
    // The pin round-trips through the same landed-checked write path as the
    // switches, not through a bare scope.set.
    expect(source).toContain('writeRegionPreferredVideoModels(')
    expect(source).toContain('nextRegionPreferredVideoModels(')
  })
})

describe('regionPreferredVideoModelsOf', () => {
  it('reads an empty record for every shape that carries no pin', () => {
    expect(regionPreferredVideoModelsOf({}, 'cn')).toEqual({})
    expect(regionPreferredVideoModelsOf({ regions: {} }, 'cn')).toEqual({})
    expect(regionPreferredVideoModelsOf({ regions: { cn: {} } }, 'cn')).toEqual({})
    // A malformed value is an absent pin, not a crash: the tool's fallback is
    // the only thing waiting on this read.
    expect(regionPreferredVideoModelsOf({ regions: { cn: { preferredVideoModels: 'x' } } }, 'cn')).toEqual({})
    expect(regionPreferredVideoModelsOf({ regions: { cn: { preferredVideoModels: null } } }, 'cn')).toEqual({})
  })

  it('keeps only non-empty string ids', () => {
    const value = {
      regions: {
        cn: {
          preferredVideoModels: {
            'text-to-video': 'minimax-video-h3',
            'image-to-video': '',
            bogus: 7,
          },
        },
      },
    }
    expect(regionPreferredVideoModelsOf(value, 'cn')).toEqual({ 'text-to-video': 'minimax-video-h3' })
  })

  it('is per region, so a CN pin never answers for the global tab', () => {
    const value = { regions: { cn: { preferredVideoModels: { 'text-to-video': 'minimax-video-h3' } } } }
    expect(regionPreferredVideoModelsOf(value, 'cn')).toEqual({ 'text-to-video': 'minimax-video-h3' })
    expect(regionPreferredVideoModelsOf(value, 'global')).toEqual({})
  })
})

describe('nextRegionPreferredVideoModels', () => {
  it('pins one tag without disturbing the other or the rest of the slot', () => {
    const value = {
      regions: {
        cn: { enabled: true, preferredVideoModels: { 'image-to-video': 'kling-video-v3' } },
        global: { enabled: false },
      },
    }
    const next = nextRegionPreferredVideoModels(value, 'cn', 'text-to-video', 'minimax-video-h3') as any
    expect(next.cn.preferredVideoModels).toEqual({
      'text-to-video': 'minimax-video-h3',
      'image-to-video': 'kling-video-v3',
    })
    expect(next.cn.enabled).toBe(true)
    expect(next.global.enabled).toBe(false)
  })

  it('clears by DELETING the key, so absence means "nothing pinned" again', () => {
    // An empty string would be a value the tool has to keep special-casing; the
    // absence is what the fallback already understands.
    const value = {
      regions: {
        cn: { preferredVideoModels: { 'text-to-video': 'minimax-video-h3', 'image-to-video': 'kling-video-v3' } },
      },
    }
    const cleared = nextRegionPreferredVideoModels(value, 'cn', 'text-to-video', undefined) as any
    expect(cleared.cn.preferredVideoModels).toEqual({ 'image-to-video': 'kling-video-v3' })
    expect('text-to-video' in cleared.cn.preferredVideoModels).toBe(false)

    const clearedByEmpty = nextRegionPreferredVideoModels(value, 'cn', 'text-to-video', '') as any
    expect(clearedByEmpty.cn.preferredVideoModels).toEqual({ 'image-to-video': 'kling-video-v3' })
  })

  it('round-trips through the reader', () => {
    const on = nextRegionPreferredVideoModels({ regions: { cn: {} } }, 'cn', 'text-to-video', 'minimax-video-h3')
    expect(regionPreferredVideoModelsOf({ regions: on }, 'cn')).toEqual({ 'text-to-video': 'minimax-video-h3' })
    const off = nextRegionPreferredVideoModels({ regions: on }, 'cn', 'text-to-video', undefined)
    expect(regionPreferredVideoModelsOf({ regions: off }, 'cn')).toEqual({})
  })
})
