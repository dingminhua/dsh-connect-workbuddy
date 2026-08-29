/**
 * WorkBuddy models for DeepSeek Harness, reusing the WorkBuddy desktop
 * app's sign-in. Registers the `workbuddy` provider; streaming, tool calls,
 * compaction, and permissions stay Harness-owned.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）
 *   — 宿主的装配顺序（先起 shim，拿到端口后才构造 provider，
 *     再注册 adapter 与可配置 provider，最后异步刷新目录）由其设计并验证；
 *     `installSettingsSection` 的用法、webServer 为可选服务（无头 profile
 *     下宿主仍工作）的处理，亦沿用其做法。
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 配置 schema 的字段划分（lastCatalog 目录 + enabledModelIds 勾选分离）、
 *     `displayModels` 与 `configuredModels` 的区分、
 *     `registerModelDiscovery` 与 `discoverModels` 返回草稿目录的做法、
 *     以及「优先选择有可用积分的账号」的启动探测，均来自该项目。
 * 改动：账号优选改为按 WorkBuddy 的积分接口判断（trae 用其用量接口），
 *   并移除与本项目上游无关的 1M 变体逻辑。
 *
 * @module dsh-connect-workbuddy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WorkBuddyCredentialStore } from './auth.ts'
import { deriveCatalog, FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from './catalog.ts'
import type { WorkBuddyContextBudget, WorkBuddyModelInfo } from './catalog.ts'
import { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } from './adapter.ts'
import { createWorkBuddyShim } from './shim.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { registerWorkBuddyStatusRoute } from './web-status.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'

export { WORKBUDDY_PROVIDER, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, createWorkBuddyAdapter, type WorkBuddyAdapter } from './adapter.ts'
export { createWorkBuddyShim, type WorkBuddyShim } from './shim.ts'
export {
  deriveCatalog,
  FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog,
  type WorkBuddyModelInfo,
} from './catalog.ts'
export {
  defaultDesktopAuthCandidates,
  defaultDesktopAuthDirs,
  defaultDesktopAuthPath,
  parseWorkBuddyAuth,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_AUTH_FILENAME,
  workbuddyAccountId,
  WorkBuddyCredentialStore,
  workbuddyOwnAuthPath,
  type WorkBuddyAccountChoice,
  type WorkBuddyAuthStatus,
  type WorkBuddyCredential,
  type WorkBuddyStoreOptions,
} from './auth.ts'
export {
  classifyUpstreamError,
  parseCreditMultiplier,
  parseReasoning,
  parseUpstreamModel,
  prepareChatBody,
  regionOf,
  WorkBuddyUpstreamClient,
  type UpstreamErrorKind,
  type WorkBuddyChatResult,
  type WorkBuddyCreditAccount,
  type WorkBuddyCredits,
  type WorkBuddyReasoning,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyUpstreamModel,
} from './upstream.ts'
export {
  WORKBUDDY_HOST_HEARTBEAT_FILENAME,
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  writeHostHeartbeat,
  workbuddyHostHeartbeatPath,
  type WorkBuddyHostHeartbeat,
} from './host-heartbeat.ts'
export { WORKBUDDY_CONNECT_VERSION } from './version.ts'
export {
  registerWorkBuddyStatusRoute,
  workBuddyWebStatus,
  type WorkBuddyStatusRouteOptions,
} from './web-status.ts'
export {
  WORKBUDDY_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY_MODELS_REFRESH_PATH,
  WORKBUDDY_USAGE_PATH,
  type WorkBuddyWebAccount,
  type WorkBuddyWebCreditAccount,
  type WorkBuddyWebCredits,
  type WorkBuddyWebModel,
  type WorkBuddyWebUsage,
} from './status-paths.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-connect-workbuddy'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/** Settings namespace for the plugin configuration card. */
export const WORKBUDDY_SETTINGS_NS = settingsNamespace('workbuddy')

/** Plugin configuration. */
export interface Config {
  /** Explicit WorkBuddy desktop auth-file path, overriding env and platform defaults. */
  authFile?: string
  /** Stable local account selector; tokens remain outside settings. */
  accountId?: string
  /** The last-refreshed model directory; what the plugin card displays. */
  lastCatalog?: WorkBuddyModelInfo[]
  /** The user's selection, as model ids. */
  enabledModelIds?: string[]
  /** Local DSH context budget per model; models above 200K default to 200K. */
  contextBudgets?: Record<string, WorkBuddyContextBudget>
}

const modelConfig = z.object({
  id: z.string().required(),
  name: z.string().required(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config: z<Config> = z.object({
  authFile: z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)'),
  accountId: z.string().description('Selected local WorkBuddy account id (never a token)'),
  lastCatalog: z.array(modelConfig).description('Last refreshed WorkBuddy model directory shown by the plugin card') as z<WorkBuddyModelInfo[]>,
  enabledModelIds: z.array(z.string()).default([]).description('WorkBuddy model ids the user enabled'),
  contextBudgets: z.dict(z.number().step(1).min(1)).default({}).description('Local DSH context budget per WorkBuddy model'),
})

/**
 * Start the loopback endpoint, register the `workbuddy` provider, and
 * refresh the model catalog from the upstream once credentials allow it.
 * The static fallback catalog serves from the first moment, so an offline
 * upstream never leaves the provider empty.
 */
export function apply(ctx: Context, config: Config): void {
  const client = new WorkBuddyUpstreamClient()
  const store = new WorkBuddyCredentialStore({
    ...config.authFile === undefined ? {} : { desktopPath: config.authFile },
    refresh: credential => client.refreshToken(credential),
  })
  if (config.accountId !== undefined) store.selectAccount(config.accountId)
  const catalog = new WorkBuddyCatalog()
  const shim = createWorkBuddyShim({ store, client, catalog, logger: ctx.logger })

  const enabledSet = (value: Config): ReadonlySet<string> => new Set(value.enabledModelIds ?? [])
  // Runtime catalog derives from the last-refreshed directory plus the user's
  // selection; an empty selection serves the whole directory so a never-
  // configured plugin still exposes models.
  const configuredModels = (value: Config): readonly WorkBuddyModelInfo[] =>
    deriveCatalog(
      value.lastCatalog?.length ? value.lastCatalog : FALLBACK_WORKBUDDY_MODELS,
      enabledSet(value),
      value.contextBudgets ?? {},
    )
  // What the card displays: the last-refreshed directory, so the user re-reads
  // the current catalog rather than a stale saved snapshot.
  const displayModels = (value: Config): readonly WorkBuddyModelInfo[] =>
    value.lastCatalog?.length ? value.lastCatalog : FALLBACK_WORKBUDDY_MODELS

  let current = () => config
  const discoverModels = async (signal?: AbortSignal): Promise<readonly WorkBuddyModelInfo[]> => {
    const credential = await store.resolve()
    return client.fetchModels(credential, signal)
  }

  // Same-origin routes backing the Plugin-configuration card. `webServer`
  // can mount after this row, so wait reactively for it instead of sampling
  // ctx.get() once during apply (which silently loses all routes on Desktop).
  ctx.inject(['webServer'], (webCtx) => registerWorkBuddyStatusRoute(webCtx, {
    store,
    client,
    displayModels: () => displayModels(current()),
    enabledModelIds: () => current().enabledModelIds ?? [],
    contextBudgets: () => current().contextBudgets ?? {},
    discoverModels,
  }))

  installSettingsSection(ctx, WORKBUDDY_SETTINGS_NS, Config, config, {
    setSource(source) { current = source },
    onChange() {
      const next = current()
      store.setDesktopPath(next.authFile)
      store.selectAccount(next.accountId)
      catalog.set(configuredModels(next))
      invalidateCatalog()
    },
  })

  let stopped = false
  let invalidateCatalog = (): void => {}
  ctx.effect(() => () => {
    stopped = true
    void shim.close()
    void clearHostHeartbeat()
  })

  /**
   * Prefer an account with usable credit. Every account yields the same
   * catalog, but an account at zero credit fails each chat request, so the
   * default must not land there.
   */
  const selectPreferredCreditAccount = async (): Promise<void> => {
    try {
      const accounts = await store.accounts()
      const scored: { id: string; credits: number }[] = []
      for (const account of accounts) {
        try {
          store.selectAccount(account.id)
          const credential = await store.resolve()
          const credits = await client.fetchCredits(credential)
          scored.push({ id: account.id, credits: credits.total })
        } catch (error: unknown) {
          // One account whose token or billing query fails must not block
          // choosing a usable default from the others.
          ctx.logger.warn(`dsh-connect-workbuddy: account ${account.id} unavailable for default selection`, error)
        }
      }
      scored.sort((a, b) => b.credits - a.credits)
      store.setPreferAccountIds(scored.filter(item => item.credits > 0).map(item => item.id))
      // Restore the user's explicit selection (if any) before first use.
      store.selectAccount(current().accountId)
    } catch (error: unknown) {
      ctx.logger.warn('dsh-connect-workbuddy: default account selection failed; continuing', error)
    }
  }

  void shim.ready
    .then(async () => {
      if (stopped) return

      let invalidate: (() => void) | undefined
      try {
        // Constructed only once the listener holds a port: the provider's
        // models read the shim origin at construction time.
        const workbuddy = createWorkBuddyAdapter({
          shim,
          store,
          catalog,
          resolveAttachments: () => ctx.get('attachments'),
        })
        invalidate = workbuddy.invalidate
        invalidateCatalog = () => { workbuddy.invalidate() }

        let releaseAdapter: (() => void) | undefined
        let releaseDirectory: (() => void) | undefined
        try {
          releaseAdapter = ctx.llm.registerAdapter([WORKBUDDY_PROVIDER], workbuddy.adapter)
          releaseDirectory = ctx.llm.registerConfigurableProviders([{
            provider: WORKBUDDY_PROVIDER,
            displayName: 'WorkBuddy',
            settingsNs: WORKBUDDY_SETTINGS_NS,
            settingsPath: [],
            declared: false,
          }])
        } finally {
          if (releaseAdapter === undefined || releaseDirectory === undefined) {
            // Registration threw; release whichever half landed.
            releaseAdapter?.()
            releaseDirectory?.()
          }
        }
        try {
          ctx.effect(() => () => {
            releaseAdapter?.()
            releaseDirectory?.()
          })
        } catch {
          // The plugin was disposed during registration; release immediately —
          // the plugin-level disposer already closed the shim.
          releaseAdapter?.()
          releaseDirectory?.()
        }

        ctx.llm.registerModelDiscovery(WORKBUDDY_SETTINGS_NS, async (request) => {
          if (request.provider !== WORKBUDDY_PROVIDER) return []
          const next = deriveCatalog(await discoverModels(request.signal), new Set(), current().contextBudgets ?? {})
          return next.map(model => ({
            id: model.id,
            name: model.name,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
          }))
        })

        // The host bundle is live: write a heartbeat so the status CLI can
        // report host health without a browser. Cleared on disposal; a stale
        // heartbeat after a crash is detected by PID in the reader.
        void writeHostHeartbeat()
      } catch (error: unknown) {
        ctx.logger.error('dsh-connect-workbuddy: provider registration failed', error)
        return
      }

      // Pick a default account with usable credit, then seed the catalog.
      await selectPreferredCreditAccount()
      if (stopped) return

      void (async () => {
        try {
          const credential = await store.resolve()
          if (stopped) return
          const models = await client.fetchModels(credential)
          if (stopped) return
          catalog.set([...models])
          invalidate?.()
          // `lastCatalog` is deliberately NOT seeded here: it belongs to the
          // user's saved selection, written only by the card's explicit save
          // (via settingsScope). Until then the card shows the live fallback
          // directory and one press of "Refresh" captures the real one.
        } catch (error: unknown) {
          ctx.logger.warn(
            'dsh-connect-workbuddy: dynamic model catalog unavailable; serving the static fallback list',
            error,
          )
        }
      })()
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-connect-workbuddy: loopback endpoint failed to start; provider not registered', error)
    })
}
