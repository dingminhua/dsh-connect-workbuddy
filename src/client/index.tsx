/**
 * Browser half: WorkBuddy credits and model management inside Plugin
 * configuration.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 浏览器插件的注册形态（`slots` / `locale` / `settingsScope` 三项注入、
 *     `LocaleNamespaceMap` 的模块增强、`settings.plugin.item` 槽位与
 *     `key` / `priority` 的 rc.7 写法、以及整个 apply 体包 try/catch
 *     以便槽位 API 变更时降级为 console.error 而不触发
 *     "Failed to load plugins" 红色横幅）来自该项目，
 *     其亦注明沿用 corrinehu/dsh-workbuddy-connect 的同一模式。
 * 改动：无实质改动，仅改为本插件的命名空间与组件名。
 *
 * NOTE: the try/catch boundary of this function is mirrored (duplicated) in
 * `tests/client-fallback.spec.ts`, because the real client entry imports
 * browser-only DSH packages that cannot load in the Node test environment.
 * That test therefore does not import this function — it replicates its
 * shape. If you change the guarded body or the `console.error` message here,
 * update the mirrored `apply()` in that spec too, or the fallback test will
 * silently diverge from this real implementation.
 *
 * @module dsh-connect-workbuddy/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// The `slots` service declaration moved host lines: `dsh-client-runtime/client`
// owned it up to 0.1.1-rc.2, and `dsh-client-ui-renderer/client` owns it from
// the 0.1.5 line (that package stopped being published). Both are type-only
// side-effect imports; whichever the host ships supplies the augmentation.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { WorkBuddyCard } from './WorkBuddyCard.tsx'
import type { WorkBuddyCardInjected } from './WorkBuddyCard.tsx'
import { en, zh } from './locales.ts'
import type { WorkBuddySettingsKey } from './locales.ts'
import { WORKBUDDY_SETTINGS_ENTRY } from '../status-paths.ts'

/**
 * The browser-side plugin context this entry needs.
 *
 * `ClientContext` used to be re-exported by `@deepseek-ai/dsh-client-runtime/client`;
 * that package stopped at 0.1.1-rc.2 and is neither published nor bundled on the
 * 0.1.5 line, so it cannot serve as a type source spanning both host lines.
 * The card hard-depends only on `slots` and `locale`. Its settings surface is
 * discovered through `ctx.get()` because 0.1.5 and 0.1.7 provide different
 * services.
 */
export type WorkBuddyClientContext = Context & {
  slots: Context['slots']
  locale: Context['locale']
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WorkBuddy plugin card copy. */
    'settings.workbuddy': WorkBuddySettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-connect-workbuddy-client'
/**
 * Client services required by the Plugin configuration contribution.
 *
 * Deliberately only the two services that exist on BOTH host lines. The
 * settings surface differs by line — 0.1.5 provides `settingsScope`, 0.1.7
 * replaces it with `configForms` — and Cordis' dependency gate is hard: any
 * inject entry the running line does not provide keeps `apply` from ever
 * running. Probing both via `ctx.get()` (which returns undefined, never
 * throws, for an absent service) is what lets one build serve both lines.
 */
export const inject = ['slots', 'locale']

/** Register card copy and the WorkBuddy card under Plugin configuration. */
export function apply(ctx: WorkBuddyClientContext): void {
  try {
    const namespace = 'settings.workbuddy'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-connect-workbuddy: settings copy')
    const t = ctx.locale.bind(namespace) as WorkBuddyCardInjected['t']

    // Soft service probe. Property access on an undeclared service THROWS
    // ("cannot get property X without inject") — `?.` guards null/undefined,
    // not a throwing getter — while `ctx.get()` returns undefined for an
    // absent service. Never touch `ctx.configForms` / `ctx.settingsScope`
    // directly; go through `get`.
    const softGet = (name: string): unknown => (ctx as unknown as { get(name: string): unknown }).get(name)

    let settingsScope: WorkBuddyCardInjected['settingsScope'] | undefined
    const forms = softGet('configForms') as
      | {
          describe(): { getSnapshot(): { view?: { namespaces?: { ns: string }[] } } }
          get(ns: string): WorkBuddyCardInjected['settingsScope']
        }
      | undefined
    const legacy = softGet('settingsScope') as
      | { bind(options: { namespace: string }): WorkBuddyCardInjected['settingsScope'] }
      | undefined
    if (forms !== undefined) {
      // 0.1.7 line: pick the namespace the Host actually serves (the plugin
      // may be mounted under a different entry id), falling back to the
      // declared one when the mirror has not populated yet.
      let ns = WORKBUDDY_SETTINGS_ENTRY
      try {
        const namespaces = forms.describe().getSnapshot().view?.namespaces ?? []
        const served = namespaces.find(entry => entry.ns === WORKBUDDY_SETTINGS_ENTRY || entry.ns === 'workbuddy')
        if (served !== undefined) ns = served.ns
      } catch { /* mirror not ready: the declared id is still correct */ }
      settingsScope = forms.get(ns)
    } else if (legacy !== undefined) {
      settingsScope = legacy.bind({ namespace: 'workbuddy' })
    }

    const registerCard = (slotName: string, key: string): void => {
      try {
        ctx.slots.inject(slotName as never, () => (ctx.slots as unknown as {
          register(
            options: { name: string; key: string; priority: number; inject: () => WorkBuddyCardInjected },
            component: unknown,
          ): () => void
        }).register({
          name: slotName,
          key,
          priority: 30,
          inject: () => settingsScope === undefined
            ? { t }
            : { t, settingsScope },
        }, WorkBuddyCard))
      } catch (error: unknown) {
        // Isolated per slot on purpose: the two host lines declare disjoint
        // slot sets (0.1.5 only settings.plugin.item; 0.1.7 only the
        // plugins.* pair), so one line's registration must never take the
        // other slots down with it.
        console.error(`[dsh-connect-workbuddy] card slot "${slotName}" failed to register (host provider unaffected):`, error)
      }
    }

    registerCard('plugins.bundle.config', 'dsh-connect-workbuddy')
    registerCard('plugins.row.config', 'dsh-connect-workbuddy#dsh-connect-workbuddy')
    registerCard('settings.plugin.item', 'workbuddy')
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-connect-workbuddy] client card failed to load (host provider unaffected):', error)
  }
}
