// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { updateStickyTabs } from '../src/client/series-layout.ts'

describe('sticky save bar boundary', () => {
  it('accounts for the negative bottom offset used to cover page padding', () => {
    const page = document.createElement('div')
    const bar = document.createElement('div')
    bar.className = 'dsm-workbuddy-pool-save-bar'
    bar.style.bottom = '-48px'
    page.append(bar)
    document.body.append(page)
    vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({ bottom: 600, top: 0 } as DOMRect)
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue({ bottom: 648 } as DOMRect)
    vi.spyOn(bar, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    try {
      updateStickyTabs(page)
      expect(bar.dataset.saveStuck).toBe('true')
      vi.mocked(bar.getBoundingClientRect).mockReturnValue({ bottom: 500 } as DOMRect)
      updateStickyTabs(page)
      expect(bar.dataset.saveStuck).toBe('false')
    } finally {
      page.remove()
      vi.restoreAllMocks()
    }
  })
})
