/**
 * The two shell behaviours the composer credit panel needs: hanging the panel
 * off its trigger, and dismissing it on an outside press.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 该项目的 `client/popover.ts`，逐条沿用其判断：同样的上下放置、同样的
 *     视口收边、同样的 scroll(capture)/resize/自身尺寸变化重测、同样的
 *     「pointerdown 落在触发器与面板之外即关闭」。这些不是随手写的——那边
 *     2.12.0/2.13.0 的客户端加载失败与面板位置错乱都留下了记录，这里直接
 *     采用其最终结论。
 *
 * Implemented locally rather than imported from
 * `@deepseek-ai/dsh-client-ui-primitives`. The shell DOES register that package
 * for plugin bundles, so importing it is legal — this is a deliberate choice,
 * not a workaround: the two behaviours are ~40 lines of DOM geometry, and owning
 * them keeps this component renderable in the Node test suite without mocking a
 * package that itself reaches `*.module.css` and further DSH dependencies.
 *
 * NOTE ON A MISDIAGNOSIS, kept because it is the kind of thing that gets
 * re-litigated: the client load failure on the referring project was first
 * attributed to importing the primitives package. It was not that. The real
 * cause was `import { createPortal } from 'react-dom'` being BUNDLED rather than
 * externalized — the inlined development build opens with
 * `process.env.NODE_ENV` and threw `ReferenceError: process is not defined` in
 * the browser, at module-evaluation time, so the ENTIRE client half failed to
 * import. See `tsdown.config.ts` (`CLIENT_EXTERNALS`) for the fix and
 * `tests/client-runtime-imports.spec.ts` for the rule that now pins it.
 */
import { useEffect, useLayoutEffect, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'

/** Inputs for {@link useAnchoredPosition}. */
export interface AnchoredPositionOptions {
  /** Whether the floating element is mounted and should track its anchor. */
  open: boolean
  /** The element the panel is placed from. */
  anchorRef: RefObject<HTMLElement | null>
  /** The floating element, measured so the clamp uses real dimensions. */
  panelRef: RefObject<HTMLElement | null>
  /** Which anchor edge the panel hangs from: above (`top`) or below (`bottom`). */
  side?: 'top' | 'bottom'
  /** Which anchor edge the panel lines up with: left (`start`) or right (`end`). */
  align?: 'start' | 'end'
  /** Distance kept between the anchor edge named by `side` and the panel. */
  gap: number
  /** Distance kept between the panel and each viewport edge. */
  margin: number
}

/**
 * Clearance to keep from the top of the viewport.
 *
 * The shell reserves a strip at the top of the frame
 * (`--dsh-frame-top-clearance`) for the window chrome, so a panel clamped to
 * `margin` alone can still land under it. Absent variable or no `data-fullscreen`
 * distinction is handled the same way the shell does: fall back to `min`.
 */
export function overlayTopMargin(min: number): number {
  if (typeof document === 'undefined') return min
  const root = document.documentElement
  const clearance = Number.parseFloat(getComputedStyle(root).getPropertyValue('--dsh-frame-top-clearance'))
  if (Number.isNaN(clearance)) return min
  return Math.max(min, (root.hasAttribute('data-fullscreen') ? 0 : clearance) + 20)
}

/** Keep a `position: fixed` floating element anchored to a trigger. */
export function useAnchoredPosition(options: AnchoredPositionOptions): CSSProperties | null {
  const { open, anchorRef, panelRef, side = 'bottom', align = 'start', gap, margin } = options
  const [position, setPosition] = useState<CSSProperties | null>(null)

  // Layout effect: the first measurement happens in the commit that opens the
  // panel, so the clamp uses real dimensions before anything paints and the
  // panel never flashes at the wrong spot.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return undefined
    }
    const place = (): void => {
      const rect = anchorRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const panel = panelRef.current
      const width = panel?.offsetWidth ?? 0
      const height = panel?.offsetHeight ?? 0
      let left = align === 'end' ? rect.right - width : rect.left
      let top = side === 'top' ? rect.top - gap - height : rect.bottom + gap
      // Clamp only along an axis whose size is known: a zero measurement would
      // otherwise pin the panel to the margin.
      if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin)
      if (height > 0) top = Math.min(Math.max(top, overlayTopMargin(margin)), window.innerHeight - height - margin)
      setPosition({ left, top })
    }
    place()
    // Capture phase: an ancestor scroller moves the anchor too, and a
    // bubble-phase listener on window never sees it.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    // The panel's own height changes without either event (a status line
    // appearing), and a stale clamp would let it cross the margin it must
    // respect. Guarded because `ResizeObserver` is absent under jsdom.
    const panel = panelRef.current
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && panel !== null) {
      observer = new ResizeObserver(place)
      observer.observe(panel)
    }
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, anchorRef, panelRef, side, align, gap, margin])

  return position
}

/**
 * Close an open popover when a pointerdown lands outside it.
 *
 * `portal` counts as inside: the panel is portaled to `document.body`, so it is
 * not a descendant of `root` and a click on the panel itself would otherwise
 * read as "outside" and dismiss the popover the user is trying to use.
 */
export function useDismissOnOutsidePointer(
  root: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
  portal?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return undefined
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node
        && root.current?.contains(event.target) !== true
        && portal?.current?.contains(event.target) !== true) {
        setOpen(false)
      }
    }
    // `pointerdown` rather than `click`: dismissing on press-down is what makes
    // the popover feel like the shell's own, and it fires before a click on
    // something underneath could be acted on.
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [root, open, setOpen, portal])
}
