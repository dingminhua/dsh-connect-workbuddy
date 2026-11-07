import { createElement as h, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, JSX } from 'react'
import { WORKBUDDY_PLUGIN_ICON } from './icon.ts'

export type IconStyle = 'claude' | 'original'
const storageKey = 'dsh-connect-workbuddy.icon-style'
const changeEvent = storageKey + '.changed'

/**
 * OUR OWN ICON IS THE DEFAULT.
 *
 * The visitor who opens the card never asked for a different glyph: the LD mark is
 * what the sidebar, the page header and the panel drew before this preference
 * existed, and it is the shape this plugin is recognised by. An alternate skin is
 * a CHOICE, so it has to be chosen — shipping the alternate as the default would
 * repaint an identity the user never asked to change, which is the same mistake as
 * a plugin rewriting another plugin's label.
 *
 * `'original'` is therefore also the fallback for a browser that stores nothing
 * (`getItem` throws behind a blocked-storage policy) and the value the server
 * snapshot reports, so the first paint and the hydrated paint agree.
 */
export const DEFAULT_ICON_STYLE: IconStyle = 'original'

/** The other one, derived so the default is stated exactly ONCE. */
const ALTERNATE_ICON_STYLE: IconStyle = DEFAULT_ICON_STYLE === 'original' ? 'claude' : 'original'

/**
 * Appearance is local to this browser; account and provider settings are untouched.
 *
 * Everything is derived from {@link DEFAULT_ICON_STYLE} rather than repeating the
 * literal, and that is not tidiness: an earlier draft compared against the stored
 * 'claude' and returned 'claude' when storage was empty, so flipping the exported
 * default changed nothing at all — the constant looked like the decision while the
 * two literals beside it were. The test that pins the default could not catch it,
 * which is how the duplicate survived.
 */
export function iconStyleSnapshot(): IconStyle {
  try {
    return window.localStorage.getItem(storageKey) === ALTERNATE_ICON_STYLE
      ? ALTERNATE_ICON_STYLE
      : DEFAULT_ICON_STYLE
  } catch { return DEFAULT_ICON_STYLE }
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
  const saved = useSyncExternalStore(subscribe, iconStyleSnapshot, () => DEFAULT_ICON_STYLE)
  const variant = props.variant ?? saved
  const shared = { className: props.className, width: props.size ?? 16, height: props.size ?? 16, style: { ...props.style, flexShrink: 0 }, 'aria-hidden': true as const }
  if (variant === 'original') return h('img', { ...shared, src: WORKBUDDY_PLUGIN_ICON, alt: '' })
  // Preserve the original shared LD silhouette while inheriting the skin foreground.
  return h('svg', { ...shared, viewBox: '0 0 24 24', fill: 'currentColor', 'data-icon-style': 'claude', 'data-plugin-icon': 'workbuddy' },
    h('path', { d: 'M4.5 5.5h3v11h3l3-3v4l-2 2h-7z' }),
    h('path', { d: 'M10.5 5.5H15a7 7 0 0 1 0 14h-2v-3h2a4 4 0 0 0 0-8h-1.5v2l-3 3z' }))
}

type CopyKey = 'row.iconStyleLead' | 'row.iconStyleLabel' | 'row.iconStyleHint' | 'row.iconStyleClaude' | 'row.iconStyleOriginal' | 'row.iconStyleSaveFailed'

/** Each choice previews the real icon and immediately persists its selection. */
export function IconStylePreference({ t }: { t: (key: CopyKey) => string }): JSX.Element {
  const selected = useSyncExternalStore(subscribe, iconStyleSnapshot, () => DEFAULT_ICON_STYLE)
  const [error, setError] = useState(false)
  return h('div', { className: 'dsm-icon-preference' },
    h('div', { className: 'dsm-icon-preference-copy' },
      h('b', null, t('row.iconStyleLabel')),
      h('span', null, t('row.iconStyleHint'))),
    h('div', { className: 'dsm-icon-choices', role: 'radiogroup', 'aria-label': t('row.iconStyleLabel') },
      ...(['original', 'claude'] as const).map(variant => h('button', {
        key: variant, type: 'button', role: 'radio', 'aria-checked': selected === variant,
        tabIndex: selected === variant ? 0 : -1,
        onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 'original' : event.key === 'End' ? 'claude' : variant === 'original' ? 'claude' : 'original'
          try { setIconStyle(next); setError(false); (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=radio]')[next === 'original' ? 0 : 1])?.focus() } catch { setError(true) }
        },
        onClick: () => { try { setIconStyle(variant); setError(false) } catch { setError(true) } },
      }, h(PluginIcon, { variant, size: 20 }), t(variant === 'claude' ? 'row.iconStyleClaude' : 'row.iconStyleOriginal')))),
    error ? h('p', { role: 'alert', className: 'dsm-icon-save-error' }, t('row.iconStyleSaveFailed')) : null)
}
