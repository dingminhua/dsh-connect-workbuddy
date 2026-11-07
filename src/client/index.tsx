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

import { WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES, WORKBUDDY_SETTINGS_NS, WORKBUDDY_SETTINGS_SECTION_ID, WORKBUDDY_SETTINGS_SECTION_ORDER, WORKBUDDY_USAGE_PATH, withWorkBuddyRegion } from '../status-paths.ts'
import { createElement as h } from 'react'
import type { JSX } from 'react'
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
import { ComposerCreditsGate } from './ComposerCreditsGate.tsx'
import { MODEL_LABEL_PRIORITY, WorkBuddyModelLabel } from './WorkBuddyModelLabel.tsx'
import { CodebuddyLive } from './CodebuddyLive.tsx'
import { selectQuotaNoticeClaim, WorkBuddyQuotaNotice } from './WorkBuddyQuotaNotice.tsx'
import { en, zh } from './locales.ts'
import type { WorkBuddySettingsKey } from './locales.ts'
import { PluginIcon } from './plugin-icon.tsx'
import {
  setSidebarPanelWanted, sidebarPanelWanted, subscribeSidebarPanelWanted,
} from './panel-switch.ts'
import { openWorkBuddySettingsSection } from './settings-jump.ts'

/**
 * The browser-side plugin context this entry needs.
 *
 * `ClientContext` used to be re-exported by `@deepseek-ai/dsh-client-runtime/client`;
 * that package stopped at 0.1.1-rc.2 and is neither published nor bundled on
 * the 0.1.7 line, so it cannot serve as a type source. The `slots` / `locale`
 * seats the card actually touches are declared by the client subpath modules
 * imported above, so naming them explicitly keeps this entry compilable.
 * Cordis' `Context` already carries the `effect` fiber API. (The 0.1.5-only
 * `settingsScope` service was removed with that line in 2.1.0.)
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

    /**
     * The credits popover's header button: open 设置 → WorkBuddy.
     *
     * ALWAYS A FUNCTION, never `undefined`. It drives the shell's real chrome
     * (see `settings-jump.ts`) rather than asking a host service, so it has a
     * definite value from the moment `apply` runs. That matters because the
     * readout only renders the button when this is present, and the first
     * `registerAllSlots()` happens before most of `apply` has finished — a
     * route captured from `ctx.get('layout')` at that moment is `undefined` on
     * a host whose layout plugin applies later, and the renderer caches
     * `inject()` results by entry identity, so nothing would ever correct it.
     *
     * The `onGiveUp` fallback asks the plugin manager for this bundle's page,
     * so an unrecognisable shell still lands somewhere useful.
     */
    const openSettingsSection = (): boolean => openWorkBuddySettingsSection({
      label: () => t('nav.panel'),
      onGiveUp: () => {
        // Last resort: the plugin manager's bundle page, which at least names
        // the plugin and offers install/uninstall. Soft-probed, and its absence
        // is simply a no-op.
        const navigation = softGet('pluginNavigation') as { openBundle?: (name: string) => void } | undefined
        if (navigation !== undefined && typeof navigation.openBundle === 'function') {
          try { navigation.openBundle('dsh-connect-workbuddy') } catch { /* fallback failed: no-op */ }
        }
      },
    })

    let settingsScope: WorkBuddyCardInjected['settingsScope'] | undefined
    const forms = softGet('configForms') as
      | {
          describe(): { getSnapshot(): { view?: { namespaces?: { ns: string }[] } } }
          get(ns: string): WorkBuddyCardInjected['settingsScope']
          whileServed(
            namespaces: readonly string[],
            register: (served: ReadonlySet<string>) => () => void,
          ): () => void
        }
      | undefined
    // 0.1.7+ only: `configForms` is the client settings surface. The legacy
    // `settingsScope` service was removed with the 0.1.5 line (2.1.0), so
    // there is no fallback to bind.

    /**
     * Register this plugin's page — and its nav glyph — in the Settings panel.
     *
     * ## Why one callback rather than two
     *
     * `settings.section` drives the nav row; `settings.section.icon` is rendered
     * by the shell as `renderSlot('settings.section.icon', …, { only: row.id })`,
     * so the glyph's cell is only meaningful while the page's id exists.
     * Registering both from the same `inject` callback makes the pairing
     * structural: the page's declaration is what makes the glyph addressable at
     * all, and Cordis disposes both with this fiber.
     *
     * ## Why there is NO capability probe
     *
     * `ctx.slots.inject(name, …)` already IS the probe. It waits for the
     * declaration and runs its callback once the slot exists; on a host that
     * never declares `settings.section` it does nothing at all — no throw, no
     * queued-forever registration. A probe built on anything else (a version
     * string, an accessor the service may not expose) turns "not supported
     * here" into "never registers anywhere", which is how a page nobody can see
     * ships with no error at all. Let the host answer.
     *
     * `WorkBuddyCard` is registered with `surface: 'settings'`: the shell owns
     * the panel chrome (title, close), so the card drops its own collapse and
     * back affordances and keeps only its content.
     */
    const registerSettingsSection = (): (() => void) | undefined => {
      try {
        return ctx.slots.inject('settings.section' as never, () => {
          const disposers: Array<() => void> = []
          const injected = (): WorkBuddyCardInjected & { surface: 'settings' } =>
            settingsScope === undefined
              ? { t, surface: 'settings' as const }
              : { t, settingsScope, surface: 'settings' as const }

          disposers.push((ctx.slots as unknown as {
            register(
              options: {
                name: string
                id: string
                order: number
                label: () => string
                locale: string
                inject: () => WorkBuddyCardInjected & { surface: 'settings' }
              },
              component: unknown,
            ): () => void
          }).register({
            name: 'settings.section',
            id: WORKBUDDY_SETTINGS_SECTION_ID,
            order: WORKBUDDY_SETTINGS_SECTION_ORDER,
            label: () => t('nav.panel'),
            locale: namespace,
            inject: injected,
          }, WorkBuddyCard))

          // The glyph, addressed by the SAME id. A separate `inject` call is
          // correct here (its own slot, its own declaration); the pairing that
          // matters is the id, and it is the same constant in both.
          try {
            const iconInject = ctx.slots.inject('settings.section.icon' as never, () => {
              const iconDisposer = (ctx.slots as unknown as {
                register(options: { name: string; id: string; locale: string }, component: unknown): () => void
              }).register({
                name: 'settings.section.icon',
                id: WORKBUDDY_SETTINGS_SECTION_ID,
                locale: namespace,
              }, (iconProps: { size?: number; active?: boolean } | undefined) => {
                // The shell asks for a square edge and passes whether this row
                // is the selected one; honouring both keeps the glyph on the
                // same rhythm as the built-in rows' own icons.
                const edge = typeof iconProps?.size === 'number' ? iconProps.size : 16
                return h(PluginIcon, {
                  size: edge,
                  className: 'dsm-workbuddy-nav-icon',
                  style: { borderRadius: '4px', display: 'block', opacity: iconProps?.active === false ? 0.75 : 1 },
                })
              })
              disposers.push(iconDisposer)
              return iconDisposer
            })
            if (typeof iconInject === 'function') disposers.push(iconInject)
          } catch (error: unknown) {
            // The page is the feature; the glyph is decoration. A host that
            // declares the section but not its icon seat must still get a page.
            console.error('[dsh-connect-workbuddy] settings nav icon failed to register (page unaffected):', error)
          }

          return () => {
            for (const dispose of disposers) {
              try { dispose() } catch { /* already disposed by the slot service */ }
            }
          }
        })
      } catch (error: unknown) {
        console.error('[dsh-connect-workbuddy] settings section failed to register (host provider unaffected):', error)
        return undefined
      }
    }

    /**
     * Credit readout in the composer row (`conversation.input.right`, a
     * session-scope list slot rendered immediately before the model picker).
     *
     * `input.right` rather than `input.left` (ported from dsh-connect-trae's
     * issue #71): the host renders `input.right` inside `div.trailing`'s
     * `standardControls`, i.e. IMMEDIATELY BEFORE the model picker, while
     * `input.left` sits at the very end of `div.tools` — 8px from the
     * permission selector. Both are clickable, so reaching for "完全权限"
     * landed on the readout and opened the credit popover. A readout is not an
     * action; next to the model picker it stops competing with a control the
     * user is actually aiming at. The `composer` SETTING value keeps its
     * meaning ("the row that carries the model picker"), so saved profiles
     * need no migration.
     *
     * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
     *   — 该项目的 `registerComposerPoints`：无条件注册插槽、由 gate 读
     *     `modelSelection` 投影自行决定是否渲染。本项目原先放在侧边栏底部
     *     （`sidebar.footer.action`），那里是**单个 root 级共享行**，两个连接器
     *     插件各占一行会互相挤压；输入框这行是 per-session 且按 provider 归属，
     *     天然只有一个插件的积分相关。
     *
     * Provider-scoped on purpose: it renders only while the session's selected
     * model belongs to this plugin, which is what keeps two connector plugins
     * from competing for one shared row. Registration is unconditional; the
     * gate reads the Host's `modelSelection` projection and returns null for
     * every other provider, so nothing is drawn and no fetch loop starts while
     * another provider is selected.
     */
    const registerComposerCredits = (): (() => void) | undefined => {
      try {
        return ctx.slots.inject('conversation.input.right' as never, () => (ctx.slots as unknown as {
          register(
            options: { name: string; id: string; order: number; locale: string; inject: () => WorkBuddyCardInjected },
            component: unknown,
          ): () => void
        }).register({
          name: 'conversation.input.right',
          id: 'dsh-connect-workbuddy-composer-credits',
          order: 4,
          locale: namespace,
          // `settingsScope` rides along so the gate can honor the card's
          // per-region switch without a second writer. `onOpenSettings` is the
          // popover's header button: it opens the plugin's own `main` panel, so
          // the reader reaches the WIDE layout from wherever they are instead of
          // being sent to a second, differently-shaped copy in Settings.
          inject: () => ({
            t,
            position: 'composer' as const,
            ...settingsScope === undefined ? {} : { settingsScope },
            onOpenSettings: openSettingsSection,
          }),
        }, ComposerCreditsGate))
      } catch (error: unknown) {
        console.error('[dsh-connect-workbuddy] composer credits slot failed to register (host provider unaffected):', error)
        return undefined
      }
    }

    /**
     * The load badge in the HOST's model picker.
     *
     * The picker renders the model name as a plain string, so a provider can
     * only put a CHARACTER there — and a character's colour is the emoji font's
     * business, not ours. The host therefore offers exactly one seam for this:
     * the `conversation.input.model.label` slot, whose contract is "render
     * non-interactive inline content such as a coloured name or badge" while
     * the picker keeps owning clicks, focus and check marks. The shipped
     * example is the official DeepSeek "1017" release badge, which is the same
     * job — a coloured marker beside a model name.
     *
     * WHY A NEGATIVE PRIORITY (host 0.2.1-rc.2 and later). This is a `single`
     * slot: it holds ONE cell, and `SlotCore.register()` THROWS when a second
     * registration claims the same priority — "single slot … already has a
     * registration at priority 0 — register at a different priority to shadow
     * it (lowest renders)". The host itself now ships a contributor here
     * (`@deepseek-ai/dsh-client-ui-deepseek-model-label-1017`, in the web-app
     * bundle from rc.2 on) that registers at the default 0, so registering at
     * 0 makes the two race: whichever lands second throws. Measured on
     * 0.2.1-rc.3 that is US — the app's own crash log records, verbatim,
     * "single slot \"conversation.input.model.label\" already has a
     * registration at priority 0 (registered by Kb)" plus this entry's
     * catch-all line "model label slot failed to register" twice per page
     * load, which is the badge silently disappearing from the picker.
     *
     * See `MODEL_LABEL_PRIORITY` in `./WorkBuddyModelLabel.tsx` for the full
     * ordering, the measured evidence, and the deliberate absence of any
     * inter-plugin coordination (project invariant, `docs/DESIGN.md` §零).
     *
     * THE COST IS PAID ON ANOTHER PLUGIN'S ROWS, and it is worth stating where
     * the registration happens: holding this cell means the host's own
     * `dsh-client-ui-deepseek-model-label-1017` badge is NOT rendered on the
     * DeepSeek rows it was written for. That is not a defect and not something
     * to fix by inspecting the slot ledger — it is the price of §零, recorded in
     * `docs/DESIGN.md` and argued in the 5.8.2 CHANGELOG. Issue #138 is a user
     * meeting that price for the first time; the disposition is to state it
     * plainly rather than to coordinate at runtime.
     */
    const registerModelLabel = (): (() => void) | undefined => {
      try {
        return ctx.slots.inject('conversation.input.model.label' as never, () => (ctx.slots as unknown as {
          register(options: { name: string, priority: number }, component: unknown): () => void
        }).register(
          { name: 'conversation.input.model.label', priority: MODEL_LABEL_PRIORITY },
          WorkBuddyModelLabel,
        ))
      } catch (error: unknown) {
        console.error('[dsh-connect-workbuddy] model label slot failed to register (host provider unaffected):', error)
        return undefined
      }
    }

    /**
     * The sidebar glyph for the WorkBuddy panel row.
     *
     * The sidebar renders `sidebar.panellist` registrants with `{ size, active }`
     * inside a `currentColor`-themed glyph cell, so the brand mark is drawn as a
     * small `<img>` — the PNG's own colours read as the plugin's identity, and
     * the row's selection state is the host's to paint around it.
     */
    function WorkBuddyPanelIcon(props: { size?: number }): JSX.Element {
      const edge = typeof props.size === 'number' && props.size > 0 ? props.size : 16
      return h(PluginIcon, { className: 'dsm-workbuddy-panel-icon', size: edge })
    }

    /**
     * The WorkBuddy panel in the sidebar (`sidebar.panellist` row + `main` keyed
     * page), mirroring how the host's own Plugins row and dsh-skill-mcp-panel
     * put a full page in the centre column.
     *
     * OPT-IN (`Config.sidebarPanel`, default false). Registering it is NOT the
     * same as showing it: `ui-sidebar` builds the nav row from the slot's ENTRY
     * METADATA (`usePanels` → `PanelRow` with `options.label` and
     * `renderSlot(...)` as the glyph), so a component returning `null` leaves a
     * blank but still-clickable button rather than no button. The row therefore
     * has to be registered only while the switch is on, which is what
     * {@link syncPanelRegistration} owns. See `panel-switch.ts` for the store
     * that decision rides on.
     *
     * Back navigation reuses the host's layout service: `selectPanel(null)`
     * hands the main area back to the conversation. It is soft-probed, so a
     * host that never declares `layout` simply renders the page without the back
     * affordance instead of blocking the whole plugin (the same degradation the
     * card already promises for a missing settings form).
     */
    /**
     * The `main` key this plugin's full page is registered under.
     *
     * Also the id the composer readout asks `layout.selectPanel` for, so the two
     * cannot drift: a rename here that missed `openFullPage` below would leave a
     * button that throws "main panel is not registered".
     */
    const PANEL_ID = 'dsh-connect-workbuddy'

    /** Hand the centre column back to the conversation. */
    const backToConversation = (): void => {
      const layout = softGet('layout') as { selectPanel?: (id: string | null) => void } | undefined
      if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(null)
    }

    /**
     * Open the FULL page from anywhere in the plugin (the composer readout's
     * button, and anything else that wants to send the reader there).
     *
     * The page is a `main` panel, so `layout.selectPanel` is the supported route
     * and needs no private key of another bundle — unlike the old
     * `openBundle('/plugins/…')` approach, which asked the Plugins page to
     * select a bundle and only worked while that page's own service existed.
     *
     * IT THROWS WHEN THE KEY IS UNREGISTERED, by the host's own rule
     * (`layout.selectPanel: main panel "…" is not registered`). That is why the
     * `main` registration below is UNCONDITIONAL while the sidebar ROW is
     * optional: the row claims a global nav seat and is off by default, but the
     * page behind it has to exist for this function to be callable at all. The
     * catch is here rather than in the caller so a stripped profile degrades to
     * "the button does nothing" instead of an error inside a click handler.
     *
     * @returns whether the page was opened.
     */
    const openFullPage = (): boolean => {
      const layout = softGet('layout') as { selectPanel?: (id: string | null) => void } | undefined
      if (layout === undefined || typeof layout.selectPanel !== 'function') return false
      try {
        layout.selectPanel(PANEL_ID)
        return true
      } catch {
        return false
      }
    }

    /**
     * The full page: a `main` panel keyed by {@link PANEL_ID}.
     *
     * Registered ALWAYS, independently of the sidebar row. They used to share one
     * lifetime, which made the page reachable only while the optional nav row was
     * switched on — and the nav row is a global seat, off by default, that most
     * users never turn on. The page is what the composer readout's button opens,
     * so tying the two together meant that button could not exist.
     */
    const registerMainPage = (): (() => void) | undefined => {
      try {
        return ctx.slots.inject('main' as never, () => (ctx.slots as unknown as {
          register(options: { name: string; key: string; locale: string; inject: () => WorkBuddyCardInjected & { surface: 'page'; backToConversation: () => void } }, component: unknown): () => void
        }).register({
          name: 'main',
          key: PANEL_ID,
          locale: namespace,
          inject: () => settingsScope === undefined
            ? { t, surface: 'page' as const, backToConversation }
            : { t, settingsScope, surface: 'page' as const, backToConversation },
        }, WorkBuddyCard))
      } catch (error: unknown) {
        console.error('[dsh-connect-workbuddy] full page failed to register (host provider unaffected):', error)
        return undefined
      }
    }

    /**
     * The OPTIONAL sidebar nav row that points at {@link registerMainPage}'s page.
     *
     * Separate from the page for the reason above: `sidebar.panellist` builds its
     * rows from ENTRY METADATA (`usePanels`), so this is the only half that has to
     * come and go with the switch. Registering the row is what makes the page
     * reachable from the sidebar; the page itself exists either way.
     */
    const registerPanelRow = (): Array<() => void> => {
      const disposers: Array<() => void> = []
      try {
        disposers.push(ctx.slots.inject('sidebar.panellist' as never, () => (ctx.slots as unknown as {
          register(options: { name: string; id: string; order: number; label: () => string; locale: string }, component: unknown): () => void
        }).register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 2,
          label: () => t('nav.panel'),
          locale: namespace,
        }, WorkBuddyPanelIcon)))
      } catch (error: unknown) {
        console.error('[dsh-connect-workbuddy] sidebar panel row failed to register (host provider unaffected):', error)
      }
      return disposers
    }

    /**
     * The live panel registrations, kept SEPARATE from {@link liveDisposers}.
     *
     * They are the only slots in this plugin that come and go while the page is
     * open (the opt-in switch), so owning them apart from the rest means
     * flipping the switch does not dispose and re-create the card, the composer
     * readout and the five other seats — which would be a visible flicker on the
     * Plugins page for a change that has nothing to do with it.
     */
    let panelDisposers: Array<() => void> = []

    /**
     * Bring the panel registrations in line with the opt-in switch.
     *
     * Dispose FIRST, then register, for the reason spelled out on
     * {@link rebindSlots}: a live `key` / `id` cannot be registered twice, and
     * the throw would be swallowed into "no entry at all".
     *
     * Re-registering (rather than only unregistering) is what keeps the entry
     * fresh after a settings-scope rebind: the renderer caches each entry's
     * `inject` result by object identity, so an entry created before the scope
     * landed would keep serving props without it forever.
     */
    const syncPanelRegistration = (): void => {
      for (const dispose of panelDisposers) {
        try { dispose() } catch { /* already disposed by the slot service */ }
      }
      panelDisposers = []
      if (!sidebarPanelWanted()) return
      panelDisposers = registerPanelRow()
    }

    /**
     * The SAME readout in the ambient dock below the composer card (issue #62).
     *
     * Registered unconditionally, like the composer seat, because the CHOICE
     * between the two seats lives in the gate: it renders in the seat the
     * setting names and returns null in the other. Registering only the chosen
     * seat would mean re-registering on every settings change, and the seat is
     * exactly the kind of thing a user flips once while looking at the result.
     *
     * WHY THIS SEAT EXISTS: the composer tool row is a list seat shared with any
     * other plugin that registers there, and issue #62 is one report of the
     * readout disappearing when another plugin was installed. This row is where
     * the shell renders its own round/step/token pills, so it is a place a user
     * already reads session numbers from.
     *
     * `order` places it after the shell's own pills (`stats` registers at 0), so
     * the shipped statistics stay leftmost and the readout reads as an addition
     * rather than a replacement.
     */
    const registerStatsCredits = (): (() => void) | undefined => {
      try {
        return ctx.slots.inject('conversation.composer.dock' as never, () => (ctx.slots as unknown as {
          register(
            options: { name: string; id: string; order: number; locale: string; inject: () => WorkBuddyCardInjected },
            component: unknown,
          ): () => void
        }).register({
          name: 'conversation.composer.dock',
          id: 'dsh-connect-workbuddy-stats-credits',
          order: 10,
          locale: namespace,
          // The SAME injection as the composer seat, minus the position: both
          // seats render the same component, so a prop wired into one and not
          // the other makes a control appear or vanish depending on a setting
          // that has nothing to do with it.
          inject: () => ({
            t,
            position: 'stats' as const,
            ...settingsScope === undefined ? {} : { settingsScope },
            onOpenSettings: openSettingsSection,
          }),
        }, ComposerCreditsGate))
      } catch (error: unknown) {
        console.error('[dsh-connect-workbuddy] stats credits slot failed to register (host provider unaffected):', error)
        return undefined
      }
    }

    /**
     * The live CodeBuddy turn pill, in the same ambient dock as the readout.
     *
     * `order` 11 puts it immediately after the credit readout (10) and still
     * right of the shell's own pills (0): the two numbers a user glances at while
     * a turn runs sit together. The component renders `null` whenever no turn is
     * live, which is the normal case — the bridge is off by default — so an
     * unused seat costs one poll interval and nothing on screen.
     *
     * THE SESSION ID IS THE PILL'S DISPLAY CONDITION. `conversation.composer.dock`
     * is declared `scope: 'session'`, so the registration's `inject` receives the
     * session id and the pill can keep only the rows that session started. The
     * board itself is host-wide (one route for every session in the process), so
     * without this the pill would describe whatever turn is newest anywhere —
     * including one from another tab, about a directory the reader is not in.
     * Unlike the credit readout there is deliberately no provider gate: the CLI
     * route is model-independent, and a turn started from a DeepSeek session is
     * exactly a case the readout has to cover.
     */
    const registerCliLive = (): (() => void) | undefined => {
      try {
        return ctx.slots.inject('conversation.composer.dock' as never, () => (ctx.slots as unknown as {
          register(
            options: { name: string; id: string; order: number; locale: string; inject: (sessionId: string) => { t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string; sessionId: string } },
            component: unknown,
          ): () => void
        }).register({
          name: 'conversation.composer.dock',
          id: 'dsh-connect-workbuddy-cli-live',
          order: 11,
          locale: namespace,
          inject: (sessionId: string) => ({ t, sessionId }),
        }, CodebuddyLive))
      } catch (error: unknown) {
        console.error('[dsh-connect-workbuddy] cli live slot failed to register (host provider unaffected):', error)
        return undefined
      }
    }

    /**
     * The frame-wide quota notice, DECLINED so the host keeps its own Toast
     * (issue #63 follow-up, the maintainer's call on a screenshot).
     *
     * WHAT WAS WRONG. The previous build claimed `QUOTA` and rendered the
     * supplement as an inline `<span>` in this seat. The chain's own contract
     * says a claiming entry "takes over the surface" — so claiming REPLACED the
     * host's generic warning Toast, and the replacement was not a Toast: an
     * inline span has no `position: fixed`, no centring, no background and no
     * fade, so it parked at the TOP-LEFT of `shell.overlay` (an `inset: 0`
     * layer) and stayed there until the next notice. The maintainer read it, on
     * screen, as a box that had not been there before — and it had not.
     *
     * WHY DECLINING IS THE FIX, not a worse one. The host's own sentence is
     * already correct and already appears in the turn's failure row inside the
     * conversation (`message.failure.quota`, via `failureMessage` in
     * `ui-chat`'s MessageItem) — the place the user is actually reading when a
     * turn fails. Taking over the frame-wide surface bought this plugin nothing
     * except a second, uglier copy of a sentence the host already draws where it
     * matters. Declining the claim returns the seat to the host: the Toast is
     * the host's own design, and this plugin stops imposing a look on a surface
     * it does not own.
     *
     * The supplement itself is NOT lost — it rides in the conversation, which is
     * the only surface that is actually in the user's eyeline (see
     * `registerStatsCredits` and the failure row). The `select` below is
     * therefore an explicit, documented DECLINE of every code rather than a
     * deletion of the registration: the seat stays claimed in one place with its
     * rationale attached, so a future reader does not re-add the takeover
     * without re-reading why it was removed.
     */
    const registerQuotaNotice = (): (() => void) | undefined => {
      try {
        return ctx.slots.inject('shell.quota-notice' as never, () => (ctx.slots as unknown as {
          register(
            options: {
              name: string
              locale: string
              select: (owner: unknown) => unknown
              inject: () => { t: WorkBuddyCardInjected['t'] }
            },
            component: unknown,
          ): () => void
        }).register({
          name: 'shell.quota-notice',
          locale: namespace,
          // Declining every owner leaves the chain's all-decline case in charge,
          // which is the host's own generic warning Toast. The rule lives in
          // `selectQuotaNoticeClaim` so it has exactly one home and its own test;
          // `claimsQuotaNotice` still exports the retired claim set as history.
          select: selectQuotaNoticeClaim,
          inject: () => ({ t }),
        }, WorkBuddyQuotaNotice))
      } catch (error: unknown) {
        console.error('[dsh-connect-workbuddy] quota notice slot failed to register (host provider unaffected):', error)
        return undefined
      }
    }

    /**
     * Every slot this plugin contributes, and how to (re)create them.
     *
     * Kept as one list because the binding of `settingsScope` and the slot
     * registrations must move TOGETHER: see {@link bindSettingsScope} for why a
     * late-arriving namespace has to produce fresh registrations rather than a
     * mutated closure.
     *
     * The configuration page is `settings.section` — ONE registration under an
     * id this plugin owns, so there is no inventory name to match and no
     * spelling to get wrong (see {@link WORKBUDDY_SETTINGS_SECTION_ID}). The
     * former `plugins.bundle.config` / `plugins.row.config` pair is GONE with
     * 5.19.0: the same configuration must not have two editing entries.
     */
    const registerAllSlots = (): Array<() => void> => [
      registerSettingsSection(),
      registerComposerCredits(),
      registerStatsCredits(),
      registerCliLive(),
      registerQuotaNotice(),
      registerModelLabel(),
      // The full PAGE is always-on: the composer readout's button opens it, and a
      // `main` panel has to exist for `layout.selectPanel` to accept the key.
      registerMainPage(),
      // The sidebar NAV ROW alone is conditional, so it is owned by
      // {@link syncPanelRegistration} rather than this list. It registers the row
      // that points at the page above; the page does not depend on it.
    ].filter((disposer): disposer is () => void => disposer !== undefined)

    /**
     * Disposers of the slots registered for the CURRENT binding.
     *
     * Declared before {@link bindSettingsScope} because that function closes
     * over it and reassigns it; the binding is only armed at the end of `apply`,
     * so this is initialised by then either way — hoisting it keeps that
     * ordering a non-requirement rather than a trap.
     */
    let liveDisposers: Array<() => void> = []

    /**
     * Replace the live registrations with a fresh set.
     *
     * ORDER MATTERS: dispose FIRST, then register.
     *
     * The ledger is a KEYED slot with one entry per `key` per priority, so
     * registering a key that is still live THROWS (`already has an entry for
     * key …`). Every registration in this entry is isolated by its own
     * try/catch, so the failure is not visible — the throw is logged and the
     * key is simply left with NO entry, because the old one was just disposed
     * by the `previous` loop. Registering before disposing therefore produces
     * an EMPTY ledger, which is a worse version of the very defect this
     * function exists to prevent.
     */
    const rebindSlots = (): void => {
      for (const dispose of liveDisposers) {
        try { dispose() } catch { /* already disposed by the slot service */ }
      }
      liveDisposers = []
      liveDisposers = registerAllSlots()
      // Say what actually landed, once per rebind.
      //
      // The issue #55 reporter's own point: the whole `apply` body is wrapped in
      // a try/catch that only logs, so "no card" and "worked fine" look
      // IDENTICAL on the page — locating that took them far longer than the fix
      // did. A single line naming the count and where the settings form came
      // from turns the next occurrence into a one-look diagnosis:
      //
      //   [dsh-connect-workbuddy] registered 6 slots (settings form: bound, sidebar panel: off)
      //   [dsh-connect-workbuddy] registered 6 slots (settings form: none — page is read-only, ...)
      //
      // Deliberately `console.info`, not `warn`/`error`: this is the healthy
      // path, and a warning-per-page-load would train users to ignore the one
      // channel that matters when something really is wrong.
      try {
        console.info(
          `[dsh-connect-workbuddy] registered ${String(liveDisposers.length)} slots `
          + `(settings form: ${settingsScope === undefined ? 'none — page is read-only' : 'bound'}, `
          + `sidebar panel: ${sidebarPanelWanted() ? 'on' : 'off'})`,
        )
      } catch { /* a host without console must still get its slots */ }
      // The panel rides its OWN switch, so it is reconciled rather than listed:
      // an already-on panel is torn down and re-registered here so its `inject`
      // closure sees the scope that was just bound.
      syncPanelRegistration()
    }

    /**
     * Bind `settingsScope` to whichever namespace the Host really serves, and
     * RE-REGISTER every slot when that answer changes.
     *
     * Why this is not a one-shot read at startup — the shipped 4.3.0 defect
     * (issue #46): the mirror is filled by an async `remote.settings.describe()`,
     * so at `apply` time `view` is usually still absent. The old code read that
     * absence as "the declared name must be right", bound
     * `forms.get('workbuddy')`, and never looked again. `ConfigFormController.
     * derive()` matches the namespace EXACTLY, so the guessed form stayed
     * `unavailable` forever; the composer gate — reading only that scope —
     * judged the opt-out switch `undefined !== false` and kept rendering the
     * readout. Unticking the box wrote `false` correctly and changed nothing on
     * screen.
     *
     * `whileServed` is the Host's own idiom for this (`mirror.subscribe` plus an
     * immediate sync). It is strictly better than re-reading the snapshot by
     * hand because it ALSO withdraws the binding if the Host stops serving our
     * namespace, and it hands `register` the set of namespaces actually served
     * — so the choice is made from live data instead of a captured guess.
     *
     * `register` runs on the unserved→served EDGE, not on every mirror update
     * (see the service's `sync`), so the disposal below is not a churn loop: it
     * clears whatever a previous edge left registered. That replacement is NOT
     * optional, because the renderer caches each entry's inject result by object
     * identity (`rootInjectCache` / `cachedRootInject` in
     * `dsh-client-ui-renderer`: `if (!props) { props = runInject(...) }`), so an
     * entry registered before the mirror landed is never re-evaluated. Late
     * binding can therefore only work if the OLD registrations are disposed and
     * NEW ones created — which is what this callback does.
     */
    const bindSettingsScope = (): void => {
      if (forms === undefined || typeof forms.whileServed !== 'function') {
        // No settings surface on this host (or a pre-`whileServed` line): fall
        // back to binding the declared name once and registering once. The card
        // then renders read-only, which is the documented degradation.
        settingsScope = forms?.get(WORKBUDDY_SETTINGS_NS)
        liveDisposers = registerAllSlots()
        syncPanelRegistration()
        return
      }
      // Wrapped in `ctx.effect` so the watch is torn down with the plugin fiber,
      // per the service's contract (`whileServed` registers nothing on our
      // context by itself).
      ctx.effect(() => forms.whileServed(
        WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES,
        (served) => {
          // The mirror has spoken. The candidate list is ORDERED, so the first
          // spelling the Host actually serves wins; the `/workbuddy/i` sweep is
          // a last resort for an entry id naming this plugin in a way the
          // candidate list does not anticipate (a wrapper prefix, a suffix).
          const ns = WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES.find(candidate => served.has(candidate))
            ?? [...served].find(entry => /workbuddy/i.test(entry))
          settingsScope = ns === undefined ? undefined : forms.get(ns)
          // Replace, never append: the renderer's inject cache is keyed by entry
          // identity, so a stale registration would keep serving stale props.
          rebindSlots()
          return () => {
            for (const dispose of liveDisposers) {
              try { dispose() } catch { /* already disposed by the slot service */ }
            }
            liveDisposers = []
            for (const dispose of panelDisposers) {
              try { dispose() } catch { /* already disposed by the slot service */ }
            }
            panelDisposers = []
          }
        },
      ), 'dsh-connect-workbuddy: settings namespace binding')
      // AND REGISTER ANYWAY, without waiting for the edge.
      //
      // `whileServed` fires `register` only on the unserved→served EDGE. When
      // the mirror's FIRST answer already contains our namespace, the service's
      // `sync()` runs inside `whileServed` itself and the edge fires there — so
      // this call is the same path, and the disposers it creates are the ones
      // the watch later replaces. But when the FIRST answer does NOT contain it
      // (a name the candidate list does not anticipate, a settings surface that
      // answers late or fails, a deployment that mounts the plugin without a
      // configurable entry at all), no edge ever fires and the card would never
      // be registered — issue #55: an empty Plugins page with no error, because
      // the whole `apply` body is wrapped in a try/catch that only logs.
      //
      // The card is useful WITHOUT the form: it reads its state from the Host's
      // own status route and renders read-only, exactly as the `forms ===
      // undefined` branch above already does. So registration must not be
      // conditional on the settings namespace, and a later edge — if one ever
      // comes — replaces these registrations with bound ones.
      //
      // `liveDisposers` is REPLACED, not appended to: when the edge fired
      // synchronously inside `whileServed`, this would otherwise dispose nothing
      // and register a second copy of every key at the same priority, which the
      // slot service refuses outright ("already has an entry for key …"). Every
      // previous registration is torn down first, so exactly one set is live.
      rebindSlots()
    }

    bindSettingsScope()

    /**
     * Follow the opt-in switch, and SEED it from the Host.
     *
     * The seed is a status read rather than the settings scope on purpose. This
     * namespace's browser mirror is documented as stale on the affected 0.1.7
     * deployments, and here a stale `false` would mean the row never appears —
     * with no later event to correct it, because `whileServed` only fires on a
     * namespace edge, not on a value change. The Host's own answer is the
     * authority (`sidebarPanelEnabled` on the usage document), exactly as it is
     * for the other Host-carried switches.
     *
     * A failed read is NOT an error to show: OFF is a legitimate and, in fact,
     * the default answer, so a plugin whose status route is unreachable simply
     * gets no row. There is nothing the user could do about it from here.
     *
     * The SUBSCRIPTION is what makes the switch live: the card calls
     * `setSidebarPanelWanted` after a verified write, so the row appears and
     * disappears without a reload. `ui-layout` drops an `activePanelId` whose
     * `main` key has gone, so switching off while the page is open returns the
     * centre column to the conversation on its own.
     */
    ctx.effect(
      () => subscribeSidebarPanelWanted(syncPanelRegistration),
      'dsh-connect-workbuddy: sidebar panel opt-in',
    )
    void (async () => {
      try {
        const response = await fetch(withWorkBuddyRegion(WORKBUDDY_USAGE_PATH, 'cn'), {
          headers: { accept: 'application/json' },
        })
        if (!response.ok) return
        const document = await response.json() as { sidebarPanelEnabled?: unknown }
        if (document.sidebarPanelEnabled === true) setSidebarPanelWanted(true)
      } catch { /* no answer means no row; the switch stays off */ }
    })()
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-connect-workbuddy] client card failed to load (host provider unaffected):', error)
  }
}
