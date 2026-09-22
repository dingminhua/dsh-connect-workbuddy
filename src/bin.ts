#!/usr/bin/env node
/**
 * Standalone status/diagnostics CLI for the dsh-connect-workbuddy bundle.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）
 *   — 三个子命令（`doctor` / `status` / `logout`）、`--json` 输出、
 *     `safeMessage` 脱敏、schemaVersion 字段、以及
 *     「宿主心跳 + 桌面端凭据文件 + 登录态」三项联合诊断的结构，
 *     均由该项目设计。
 * 改动：凭据诊断由单文件扩展为「目录扫描 + 按账号分组」，
 *     doctor 会列出发现的每个账号及其文件来源，便于确认多账号是否可用；
 *     另补 desktopAuthDir 字段。双 provider 化后，doctor/status 按
 *     区域（cn | global）分别报告各自的账号与登录态，logout 清除
 *     所有插件自有凭据副本（两个区域文件 + 旧单文件）。
 *
 * @module dsh-connect-workbuddy/bin
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  defaultDesktopAuthCandidates,
  defaultDesktopAuthDirs,
  legacyWorkbuddyOwnAuthPath,
  WORKBUDDY_AUTH_FILE_ENV,
  WorkBuddyCredentialStore,
  workbuddyOwnAuthPath,
} from './auth.ts'
import { WORKBUDDY_APP_EXECUTABLE_ENV, findWorkbuddyAppExecutable } from './at-rest.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import type { WorkBuddyRegion } from './upstream.ts'
import { FALLBACK_WORKBUDDY_MODELS, FALLBACK_WORKBUDDY_MODELS_GLOBAL } from './catalog.ts'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'
import { isHeartbeatProcessAlive, readHostHeartbeat, workbuddyHostHeartbeatPath } from './host-heartbeat.ts'

type Action = 'doctor' | 'logout' | 'status'

const JSON_SCHEMA_VERSION = 2

/** Both regions, in reporting order. */
const REGIONS: readonly WorkBuddyRegion[] = ['cn', 'global']

/** Region labels for human output. */
const REGION_LABELS: Readonly<Record<WorkBuddyRegion, string>> = {
  cn: 'CN (domestic)',
  global: 'Global',
}

/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
}

function printHelp(): void {
  process.stdout.write([
    'Usage: dsh-connect-workbuddy <doctor|status|logout> [--json]',
    '',
    '  doctor   secret-free sign-in and environment diagnostics',
    '  status   per-region sign-in state, remaining credit, and host-bundle health',
    '  logout   remove every plugin-owned credential copy (the desktop app keeps its sign-in)',
    '  --json   emit one secret-free JSON document (doctor/status only)',
    '',
  ].join('\n'))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/** One region-scoped credential store (its own plugin-owned copy file). */
function makeStore(region: WorkBuddyRegion): WorkBuddyCredentialStore {
  const client = new WorkBuddyUpstreamClient()
  return new WorkBuddyCredentialStore({
    region,
    refresh: credential => client.refreshToken(credential),
  })
}

/** The region-unscoped store (reads every plugin-owned copy). */
function makeAnyStore(): WorkBuddyCredentialStore {
  const client = new WorkBuddyUpstreamClient()
  return new WorkBuddyCredentialStore({ refresh: credential => client.refreshToken(credential) })
}

async function doctor(jsonOutput: boolean): Promise<number> {
  const anyStore = makeAnyStore()
  const desktopPresent = await anyStore.desktopFilePresent()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const appExecutable = findWorkbuddyAppExecutable()
  const regionLists = await Promise.all(REGIONS.map(async region => ({
    region,
    accounts: await makeStore(region).accounts(),
  })))
  const anySignedIn = regionLists.some(({ accounts }) => accounts.length > 0)
  const report = {
    schemaVersion: JSON_SCHEMA_VERSION,
    package: 'dsh-connect-workbuddy',
    version: WORKBUDDY_CONNECT_VERSION,
    node: process.version,
    desktopAuthFile: {
      path: anyStore.desktopAuthPath() ?? '(no platform default; set WORKBUDDY_AUTH_FILE)',
      dir: defaultDesktopAuthDirs()[0] ?? '(no platform default)',
      candidates: defaultDesktopAuthCandidates(),
      present: desktopPresent,
    },
    /**
     * Whether the encrypted-credential path is available. The desktop app
     * encrypts token fields on Windows builds; opening them needs that same
     * app, so an install location is exactly what this records. No key
     * material is read or reported here.
     */
    atRestDecryption: {
      appExecutable: appExecutable ?? `(not found; set ${WORKBUDDY_APP_EXECUTABLE_ENV})`,
      available: appExecutable !== undefined,
    },
    ownAuthFiles: {
      cn: workbuddyOwnAuthPath('cn'),
      global: workbuddyOwnAuthPath('global'),
      legacy: legacyWorkbuddyOwnAuthPath(),
    },
    hostHeartbeat: {
      path: workbuddyHostHeartbeatPath(),
      present: heartbeat !== undefined,
      ...heartbeat === undefined ? {} : { registeredAt: heartbeat.registeredAt, pid: heartbeat.pid },
      processAlive: hostAlive,
    },
    regions: Object.fromEntries(regionLists.map(({ region, accounts }) => [region, accounts.map(account => ({
      id: account.id,
      accountName: account.accountName,
      domain: account.domain === '' ? undefined : account.domain,
      source: account.source,
      selected: account.selected,
      tokenExpiresAt: new Date(account.tokenExpiresAtMs).toISOString(),
    }))])),
    fallbackModels: {
      cn: FALLBACK_WORKBUDDY_MODELS.length,
      global: FALLBACK_WORKBUDDY_MODELS_GLOBAL.length,
    },
    hints: [
      ...anySignedIn ? [] : ['Sign in once in the WorkBuddy desktop app (either region), then run status again.'],
      ...desktopPresent ? [] : [`No WorkBuddy desktop auth file at the expected path; set ${WORKBUDDY_AUTH_FILE_ENV} if it lives elsewhere.`],
      ...appExecutable === undefined
        ? [`The WorkBuddy desktop app was not found, so encrypted credential fields cannot be opened; set ${WORKBUDDY_APP_EXECUTABLE_ENV} to its executable if it is installed elsewhere.`]
        : [],
      ...hostAlive ? [] : ['Host bundle not running in this DSH profile (or the process exited). The browser card and providers are unavailable until DSH starts the plugin.'],
    ],
  }
  if (jsonOutput) {
    printJson(report)
  } else {
    process.stdout.write([
      `WorkBuddy Connect ${WORKBUDDY_CONNECT_VERSION} on ${process.version}`,
      `Desktop auth file: ${report.desktopAuthFile.present ? 'present' : 'missing'} (${report.desktopAuthFile.path})`,
      `Encrypted-credential support: ${report.atRestDecryption.available ? 'available' : 'unavailable'} (${report.atRestDecryption.appExecutable})`,
      `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : heartbeat !== undefined ? 'stale heartbeat (process exited)' : 'not started'}`,
      ...regionLists.flatMap(({ region, accounts }) => [
        `${REGION_LABELS[region]} accounts: ${accounts.length} (own copy ${workbuddyOwnAuthPath(region)})`,
        ...accounts.map(account => `  - ${account.accountName === '' ? '(unnamed)' : account.accountName} (${account.id})${account.selected ? ' [selected]' : ''} expires ${new Date(account.tokenExpiresAtMs).toISOString()}`),
      ]),
      `Static fallback models: CN ${report.fallbackModels.cn}, Global ${report.fallbackModels.global}`,
      ...report.hints.map(hint => `Hint: ${hint}`),
      '',
    ].join('\n'))
  }
  return anySignedIn && desktopPresent ? 0 : 1
}

/** One region's sign-in and credit summary. */
async function regionStatus(region: WorkBuddyRegion): Promise<{
  region: WorkBuddyRegion
  status: 'signed-in' | 'signed-out'
  accessTokenExpires?: string
  nickname?: string
  domain?: string
  accountId?: string
  accountName?: string
  accountCount: number
  credits?: number
  creditsError?: string
}> {
  const store = makeStore(region)
  const client = new WorkBuddyUpstreamClient()
  const authStatus = await store.status()
  const accounts = await store.accounts()
  const selected = accounts.find(account => account.selected)
  const base = {
    region,
    status: authStatus.state,
    ...authStatus.expiresAtMs === undefined ? {} : { accessTokenExpires: new Date(authStatus.expiresAtMs).toISOString() },
    ...authStatus.nickname === undefined ? {} : { nickname: authStatus.nickname },
    ...authStatus.domain === undefined || authStatus.domain === '' ? {} : { domain: authStatus.domain },
    ...selected === undefined ? {} : { accountId: selected.id, accountName: selected.accountName },
    accountCount: accounts.length,
  }
  if (authStatus.state !== 'signed-in') return base
  try {
    const credential = await store.resolve()
    return { ...base, credits: (await client.fetchCredits(credential)).total }
  } catch (error: unknown) {
    return { ...base, credits: 0, creditsError: safeMessage(error) }
  }
}

async function status(jsonOutput: boolean): Promise<number> {
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const hostState = hostAlive ? 'running' : heartbeat !== undefined ? 'stale' : 'not-started'
  const fragments = await Promise.all(REGIONS.map(region => regionStatus(region)))
  const cn = fragments.find(fragment => fragment.region === 'cn')
  if (jsonOutput) {
    printJson({
      schemaVersion: JSON_SCHEMA_VERSION,
      package: 'dsh-connect-workbuddy',
      version: WORKBUDDY_CONNECT_VERSION,
      // Top-level fields mirror the CN region for pre-dual-provider readers.
      status: cn?.status === 'signed-in' ? 'signed-in' : 'signed-out',
      ...cn?.status === 'signed-in' ? {
        ...cn.accessTokenExpires === undefined ? {} : { accessTokenExpires: cn.accessTokenExpires },
        ...cn.nickname === undefined ? {} : { nickname: cn.nickname },
        ...cn.domain === undefined ? {} : { domain: cn.domain },
        ...cn.accountId === undefined ? {} : { accountId: cn.accountId, accountName: cn.accountName },
      } : {},
      regions: Object.fromEntries(fragments.map(fragment => [fragment.region, fragment])),
      hostBundle: hostState,
    })
    return fragments.some(fragment => fragment.status === 'signed-in') ? 0 : 1
  }
  process.stdout.write([
    ...fragments.flatMap(fragment => [
      `${REGION_LABELS[fragment.region]}: ${fragment.status === 'signed-in'
        ? `signed in${fragment.accountName === undefined ? '' : ` as ${fragment.accountName}`}`
        : 'signed out'}`,
      ...fragment.status === 'signed-in' && fragment.accessTokenExpires !== undefined
        ? [`  Access token expires ${fragment.accessTokenExpires} (refresh is automatic)`] : [],
      `  Local accounts: ${fragment.accountCount}`,
      ...fragment.creditsError !== undefined
        ? [`  Remaining credit: unavailable (${fragment.creditsError})`]
        : fragment.credits !== undefined
          ? [`  Remaining credit: ${fragment.credits}`]
          : [],
    ]),
    `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : hostState === 'stale' ? 'stale heartbeat (DSH process exited)' : 'not started in this profile'}`,
    'Client card: load failures are logged to the browser console only; the host providers are unaffected.',
    '',
  ].join('\n'))
  return fragments.some(fragment => fragment.status === 'signed-in') ? 0 : 1
}

/** Execute one boot-free command. */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const [rawAction, ...flags] = argv
  const actions: readonly Action[] = ['doctor', 'logout', 'status']
  if (!actions.includes(rawAction as Action)) {
    process.stderr.write(`dsh-connect-workbuddy: expected doctor, logout, or status; got ${JSON.stringify(rawAction)}\n`)
    return 1
  }
  const action = rawAction as Action
  const jsonOutput = flags.includes('--json')
  const unknown = flags.filter(flag => flag !== '--json')
  if (unknown.length > 0 || (jsonOutput && action === 'logout')) {
    process.stderr.write(`dsh-connect-workbuddy: invalid options for ${action}: ${flags.join(' ')}\n`)
    return 1
  }
  try {
    switch (action) {
      case 'doctor':
        return await doctor(jsonOutput)
      case 'status':
        return await status(jsonOutput)
      case 'logout': {
        // The unscoped store's logout removes every plugin-owned copy:
        // both per-region files and the legacy single file.
        const store = makeAnyStore()
        await store.logout()
        process.stdout.write(`WorkBuddy Connect: removed the plugin-owned credential copies (${workbuddyOwnAuthPath('cn')}, ${workbuddyOwnAuthPath('global')}, ${legacyWorkbuddyOwnAuthPath()}); the desktop app's sign-in is untouched\n`)
        return 0
      }
    }
  } catch (error: unknown) {
    process.stderr.write(`dsh-connect-workbuddy: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
