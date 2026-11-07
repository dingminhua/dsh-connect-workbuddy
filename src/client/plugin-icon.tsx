import { createElement as h, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, JSX } from 'react'
import { WORKBUDDY_PLUGIN_ICON } from './icon.ts'

export type IconStyle = 'claude' | 'original'
const storageKey = 'dsh-connect-workbuddy.icon-style'
const changeEvent = storageKey + '.changed'

/** Appearance is local to this browser; account and provider settings are untouched. */
export function iconStyleSnapshot(): IconStyle {
  try { return window.localStorage.getItem(storageKey) === 'original' ? 'original' : 'claude' }
  catch { return 'claude' }
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === storageKey || event.key === null) listener()
  }
  window.addEventListener(changeEvent, listener)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(changeEvent, listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function setIconStyle(value: IconStyle): void {
  window.localStorage.setItem(storageKey, value)
  window.dispatchEvent(new Event(changeEvent))
}

export function PluginIcon(props: { className?: string; size?: number; style?: CSSProperties; variant?: IconStyle }): JSX.Element {
  const saved = useSyncExternalStore(subscribe, iconStyleSnapshot, () => 'claude' as const)
  const variant = props.variant ?? saved
  const shared = { className: props.className, width: props.size ?? 16, height: props.size ?? 16, style: { ...props.style, flexShrink: 0 }, 'aria-hidden': true as const }
  if (variant === 'original') return h('img', { ...shared, src: WORKBUDDY_PLUGIN_ICON, alt: '' })
  // Preserve the original shared LD silhouette while inheriting the skin foreground.
  return h('svg', { ...shared, viewBox: '0 0 24 24', fill: 'currentColor', 'data-icon-style': 'claude', 'data-plugin-icon': 'workbuddy' },
    h('path', { d: 'M4.5 5.5h3v11h3l3-3v4l-2 2h-7z' }),
    h('path', { d: 'M10.5 5.5H15a7 7 0 0 1 0 14h-2v-3h2a4 4 0 0 0 0-8h-1.5v2l-3 3z' }))
}

type CopyKey = 'row.iconStyleLabel' | 'row.iconStyleHint' | 'row.iconStyleClaude' | 'row.iconStyleOriginal' | 'row.iconStyleSaveFailed'

/** Each choice previews the real icon and immediately persists its selection. */
export function IconStylePreference({ t }: { t: (key: CopyKey) => string }): JSX.Element {
  const selected = useSyncExternalStore(subscribe, iconStyleSnapshot, () => 'claude' as const)
  const [error, setError] = useState(false)
  return h('div', { className: 'dsm-icon-preference' },
    h('div', { className: 'dsm-icon-preference-copy' },
      h('b', null, t('row.iconStyleLabel')),
      h('span', null, t('row.iconStyleHint'))),
    h('div', { className: 'dsm-icon-choices', role: 'radiogroup', 'aria-label': t('row.iconStyleLabel') },
      ...(['claude', 'original'] as const).map(variant => h('button', {
        key: variant, type: 'button', role: 'radio', 'aria-checked': selected === variant,
        tabIndex: selected === variant ? 0 : -1,
        onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 'claude' : event.key === 'End' ? 'original' : variant === 'claude' ? 'original' : 'claude'
          try { setIconStyle(next); setError(false); (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=radio]')[next === 'claude' ? 0 : 1])?.focus() } catch { setError(true) }
        },
        onClick: () => { try { setIconStyle(variant); setError(false) } catch { setError(true) } },
      }, h(PluginIcon, { variant, size: 20 }), t(variant === 'claude' ? 'row.iconStyleClaude' : 'row.iconStyleOriginal')))),
    error ? h('p', { role: 'alert', className: 'dsm-icon-save-error' }, t('row.iconStyleSaveFailed')) : null)
}
