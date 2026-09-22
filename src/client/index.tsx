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

/**
 * The browser-side plugin context this entry needs.
 *
 * `ClientContext` used to be re-exported by `@deepseek-ai/dsh-client-runtime/client`;
 * that package stopped at 0.1.1-rc.2 and is neither published nor bundled on the
 * 0.1.5 line, so it cannot serve as a type source spanning both host lines.
 * The `slots` / `locale` / `settingsScope` seats the card actually touches are
 * declared by the client subpath modules imported above, so naming the three
 * explicitly keeps this entry compilable on either line. Cordis' `Context`
 * already carries the `effect` fiber API.
 */
export type WorkBuddyClientContext = Context & {
  slots: Context['slots']
  locale: Context['locale']
  settingsScope: Context['settingsScope']
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WorkBuddy plugin card copy. */
    'settings.workbuddy': WorkBuddySettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-connect-workbuddy-client'
/** Client services required by the Plugin configuration contribution. */
export const inject = ['slots', 'locale', 'settingsScope']

/** Register card copy and the WorkBuddy card under Plugin configuration. */
export function apply(ctx: WorkBuddyClientContext): void {
  try {
    const namespace = 'settings.workbuddy'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-connect-workbuddy: settings copy')
    const t = ctx.locale.bind(namespace) as WorkBuddyCardInjected['t']

    const servedNamespaces = (ctx as any).configForms?.describe?.()?.getSnapshot?.()?.view?.namespaces ?? []
    const servedNs = servedNamespaces.find((entry: any) => entry.ns === 'workbuddy' || /workbuddy/i.test(entry.ns))
    const settingsScope = (ctx as any).configForms?.get?.(servedNs ? servedNs.ns : 'dsh-connect-workbuddy')
      ?? ctx.settingsScope?.bind({ namespace: 'workbuddy' }) as NonNullable<WorkBuddyCardInjected['settingsScope']>

    const registerCard = (slotName: any, key: string) => {
      ctx.slots.inject(slotName as any, () => (ctx.slots as any).register({
        name: slotName,
        key,
        priority: 30,
        inject: (): WorkBuddyCardInjected => ({ t, settingsScope }),
      }, (p: any) => p && p.view === 'page' ? WorkBuddyCard(p) : (WorkBuddyCard as any)(p)))
    }

    registerCard('plugins.row.config', 'dsh-connect-workbuddy#dsh-connect-workbuddy')
    registerCard('settings.plugin.item', 'workbuddy')
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-connect-workbuddy] client card failed to load (host provider unaffected):', error)
  }
}
