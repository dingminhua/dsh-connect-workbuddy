#!/usr/bin/env node
/**
 * 阶段 E 真实上游随机配对探针（OFF vs 派生稳定 X-Conversation-ID）。
 *
 * 与离线安全版 `probe-stable-conversation-id.mjs` 的区别：
 *   - 离线版一律合成 fetch、E 入口仅以 DI 预留；本文件是 E 阶段真实驱动。
 *   - 必须调真实 `WorkBuddyUpstreamClient.chatStream`，因为被测 feature 在
 *     `chatStream` 内的 `stableId = identity.stableConversationId === true
 *     ? deriveStableConversationId(bodyJson) : undefined`。自行拼 headers 会绕开被测代码。
 *   - 两臂 client 唯一差异是 `stableConversationId`（单变量）：
 *     OFF = { deviceSalt }；ON = { deviceSalt, stableConversationId: true }。
 *
 * 隐私 / 零写约束（AGENTS.md / 验收方案 §E1 / §7）：
 *   - 凭证只读本机 vault 明文，经 `parseWorkBuddyAuth(readFileSync(...))` 组装；
 *     绕开会写 `.lock` 的 `WorkBuddyCredentialStore.resolve()`。
 *   - 设备盐只读 `$DSH_HOME/.workbuddy-device.json` 的 `salt`，显式传给 client，
 *     使 `resolveWireIdentity` 早返回（不读盘不写盘），且设备头与真实插件一致。
 *   - 不改 vault / profile / 插件、不安装、不重载；唯一新建文件是 `--out` JSONL。
 *   - 日志零回显：不打印响应正文、headers 真值、原始异常、真实 ID、账号真值、绝对路径。
 *   - 真实 ID 只留在内存 wiring snapshot，绝不进 JSONL（`serializeRecord` 白名单禁止
 *     message/body/headers/sseText/responseText/rawError/credential/token 等字段）。
 *
 * 真实 usage 适配（§11 协议修订）：`adaptTerminalUsage()`（纯函数在
 * `probe-usage-adapter.ts`）在交给离线 `normalizeUsage` 前，删除上游恒为 0 的
 * 惰性顶层 `cached_tokens` 冗余字段。不改 A–D 冻结的 `probe-core.ts`（哈希已入
 * D 报告/审核包）；全部一致性护栏保留。详见 §11 与 tests/probe-real-adapter.spec.ts。
 *
 * 网络门控：必须同时给 `--real` 与 `--e-phase-authorized`，否则 NOT_RUN(3)、
 * 零网络、零凭证、零文件写入。`--synthetic` 是免费的全流水线离线自测（合成 SSE，
 * 同一 chatStream / header 捕获 / analyzeStream / JSONL 路径），不消耗额度。
 *
 * 用法：
 *   node scripts/probe-stable-conversation-id-real.mjs --synthetic --groups 2 --turns 2 --out /tmp/dry.jsonl
 *   node scripts/probe-stable-conversation-id-real.mjs --real --e-phase-authorized --groups 5  --seed 7        --out /tmp/pilot.jsonl
 *   node scripts/probe-stable-conversation-id-real.mjs --real --e-phase-authorized --groups 20 --seed 20261113 --out /tmp/formal.jsonl
 *
 * 退出码（probe-core.ts EXIT）：0 完整实验 / 1 执行失败 / 2 数据无效或不完整 / 3 NOT_RUN。
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as core from './probe-core.ts'
import { adaptTerminalUsage } from './probe-usage-adapter.ts'
import {
  parseWorkBuddyAuth,
  prepareChatBody,
  deriveStableConversationId,
  WorkBuddyUpstreamClient,
} from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const FROZEN_PLAN_PATH = join(REPO, 'docs', 'E-PHASE-FROZEN-PLAN.md')

const FILLER = 'The quick brown fox jumps over the lazy dog. Prometheus bound the cache key to the prefix. '
const PREFIX_REPEATS = 420
const SUFFIX = 'Reply with exactly: OK'
const FALLBACK_SALT = '07'.repeat(32) // 64 位小写 hex；仅当盐文件缺失时使用（仍零写盘）

const REALTIME_STOP_STATUSES = new Set([401, 403, 429])
const MAX_CONSECUTIVE_INCOMPLETE = 3

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 严格整数参数：拒绝 NaN / 小数 / 负数 / 超范围，避免静默截断。 */
function strictInt(raw, label) {
  if (!/^-?\d+$/u.test(String(raw))) throw new Error(`BAD_${label}`)
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) throw new Error(`BAD_${label}`)
  return n
}

export function parseArgs(argv) {
  const out = {
    groups: 20,
    warmTurns: 5,
    repeats: 1,
    maxTokens: 16,
    accountAlias: '账号A',
    model: 'hy4free',
    endpointAlias: 'cn-chat-v2',
    seed: 20261113,
    usageIdentity: false,
    wireProfile: 'balanced',
    timeoutMs: 180_000,
    out: '',
    real: false,
    ePhaseAuthorized: false,
    synthetic: false,
  }
  const valueAt = (i) => {
    if (i + 1 >= argv.length) throw new Error('MISSING_VALUE')
    return argv[i + 1]
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    switch (a) {
      case '--groups': out.groups = strictInt(valueAt(i), 'GROUPS'); i += 1; break
      case '--turns': out.warmTurns = strictInt(valueAt(i), 'TURNS'); i += 1; break
      case '--repeats': out.repeats = strictInt(valueAt(i), 'REPEATS'); i += 1; break
      case '--max-tokens': out.maxTokens = strictInt(valueAt(i), 'MAX_TOKENS'); i += 1; break
      case '--seed': out.seed = strictInt(valueAt(i), 'SEED'); i += 1; break
      case '--account': out.accountAlias = valueAt(i); i += 1; break
      case '--model': out.model = valueAt(i); i += 1; break
      case '--endpoint': out.endpointAlias = valueAt(i); i += 1; break
      case '--wire-profile': out.wireProfile = valueAt(i); i += 1; break
      case '--usage-identity': out.usageIdentity = true; break
      case '--timeout-ms': out.timeoutMs = strictInt(valueAt(i), 'TIMEOUT_MS'); i += 1; break
      case '--out': out.out = valueAt(i); i += 1; break
      case '--real': out.real = true; break
      case '--e-phase-authorized': out.ePhaseAuthorized = true; break
      case '--synthetic': out.synthetic = true; break
      default: throw new Error('UNKNOWN_ARG')
    }
  }
  return out
}

/**
 * 驱动源码哈希：覆盖本驱动 + 它 import 的本地纯逻辑模块（probe-usage-adapter.ts）。
 * 分裂成两个文件后只哈希 driver 自身会留缺口——适配逻辑被改而哈希不变就破坏了
 * 「冻结脚本」语义。故按文件名排序带分隔拼接两文件字节，任一字节变化都能检出。
 */
function computeScriptHash() {
  const h = createHash('sha256')
  const names = ['probe-stable-conversation-id-real.mjs', 'probe-usage-adapter.ts'].sort()
  for (const f of names) {
    h.update(f).update('\0').update(readFileSync(join(HERE, f))).update('\0')
  }
  return h.digest('hex')
}

/** 构建产物哈希：lib/ 下全部 .js 按名字排序后带分隔拼接，检测任一字节/文件变化。 */
function computeBuildHash() {
  const libDir = join(REPO, 'lib')
  const h = createHash('sha256')
  const files = readdirSync(libDir).filter((f) => f.endsWith('.js')).sort()
  for (const f of files) {
    h.update(f).update('\0').update(readFileSync(join(libDir, f))).update('\0')
  }
  return h.digest('hex')
}

/** 本机状态目录候选：优先 DSH_HOME，其次 ~/.dsh；去重且均只读。 */
function homeCandidates() {
  const list = []
  const env = process.env.DSH_HOME
  if (env !== undefined && env !== '') list.push(env)
  const fallback = join(homedir(), '.dsh')
  if (!list.includes(fallback)) list.push(fallback)
  return list
}

/** 只读加载凭证；错误只映射固定类别码，绝不回显路径 / 异常 / 值。 */
function loadCredential() {
  let lastError = 'CREDENTIAL_NOT_FOUND'
  for (const dshHome of homeCandidates()) {
    const vaultDir = join(dshHome, 'workbuddy-vault', 'cn')
    let files
    try {
      files = readdirSync(vaultDir).filter((f) => f.endsWith('.json')).sort()
    } catch {
      lastError = 'CREDENTIAL_VAULT_UNREADABLE'
      continue
    }
    if (files.length === 0) { lastError = 'CREDENTIAL_NOT_FOUND'; continue }
    const vaultPath = join(vaultDir, files[0])
    let credential
    try {
      credential = parseWorkBuddyAuth(readFileSync(vaultPath, 'utf8'), vaultPath)
    } catch {
      lastError = 'CREDENTIAL_PARSE'
      continue
    }
    if (credential === undefined || typeof credential.accessToken !== 'string'
      || credential.accessToken.length === 0) {
      lastError = 'CREDENTIAL_PARSE'
      continue
    }
    return credential
  }
  throw new Error(lastError)
}

/** 只读设备盐（零写）；缺失时返回确定性占位盐并在 meta 标注来源。 */
function loadDeviceSalt() {
  for (const dshHome of homeCandidates()) {
    try {
      const obj = JSON.parse(readFileSync(join(dshHome, '.workbuddy-device.json'), 'utf8'))
      if (typeof obj.salt === 'string' && /^[0-9a-f]{64}$/u.test(obj.salt)) {
        return { salt: obj.salt, source: 'file' }
      }
    } catch {
      // 尝试下一个候选；绝不回显路径 / 异常 / 盐值。
    }
  }
  return { salt: FALLBACK_SALT, source: 'placeholder' }
}

/** 从可能被覆写的 fetch init.headers 中按大小写不敏感取值。 */
function headerValue(headers, name) {
  if (headers === null || headers === undefined) return null
  const lower = name.toLowerCase()
  if (typeof headers.get === 'function') return headers.get(lower)
  if (Array.isArray(headers)) {
    const found = headers.find(([k]) => String(k).toLowerCase() === lower)
    return found === undefined ? null : String(found[1])
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return String(v)
  }
  return null
}

/**
 * 增量 wiring 不变量检查（忽略「快照数 < 计划数」——中途本来就不等）。
 * 返回首个违规码，或 null。用于在每组/每条之后尽早停止，避免硬烧预算。
 */
function wiringViolation(snapshots, params) {
  const offConvos = []
  const onByGroup = new Map()
  const msgIds = new Set()
  const reqIds = new Set()
  for (const s of snapshots) {
    if (!core.isValidWiringSnapshot(s, params)) return 'INVALID_OR_EMPTY_ID'
    if (s.arm === 'OFF') {
      if (offConvos.includes(s.conversationId)) return 'OFF_CONVERSATION_NOT_FRESH'
      offConvos.push(s.conversationId)
    } else if (!onByGroup.has(s.group)) {
      onByGroup.set(s.group, s.conversationId)
    } else if (onByGroup.get(s.group) !== s.conversationId) {
      return 'ON_CONVERSATION_NOT_STABLE'
    }
    if (msgIds.has(s.messageId)) return 'MESSAGE_ID_REUSED'
    msgIds.add(s.messageId)
    if (reqIds.has(s.requestId)) return 'REQUEST_ID_REUSED'
    reqIds.add(s.requestId)
    if (s.rootId !== s.requestId) return 'ROOT_REQUEST_MIRROR_BROKEN'
  }
  return null
}

/** 合成 fetch：返回带终态 usage 的 SSE；仅 --synthetic 自测用，绝不访问网络。 */
function makeSyntheticFetch() {
  let n = 0
  return async (_url, _init) => {
    n += 1
    const hit = n % 2 === 0 ? 60 : 30
    // 复刻真实 hy4free 冗余 schema：规范 hit/miss + details.cached_tokens(=hit)
    // + 顶层 cached_tokens(=0)。适配后应走 HIT_MISS 且全程 valid。
    const usage = {
      prompt_cache_hit_tokens: hit,
      prompt_cache_miss_tokens: 100 - hit,
      completion_tokens: 1,
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: hit },
      cached_tokens: 0,
    }
    const sse = core.makeUsageSse(usage, { keepalive: true, crlf: true })
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
}

function renderReal(report, meta, extra) {
  const r = report
  const f = (v) => (v === null || v === undefined ? 'null' : String(v))
  return [
    `SCHEMA ${r.schemaVersion}`,
    `RUN ${r.runId}`,
    `TEMPLATE ${r.templateVersion}`,
    `EXPERIMENT ${r.experimentKind}`,
    `REAL ${r.realExperiment}`,
    `WIRING ${r.wiringStatus}`,
    `DATA ${r.dataStatus}`,
    `EFFECT ${r.effectStatus}`,
    `EXIT ${r.exitCode}`,
    `RECORDS ${r.totalRecords} INCOMPLETE ${r.incompleteRecords} `
      + `CONFLICT ${r.conflictRecords} INVALID ${r.invalidRecords}`,
    `MEAN_D ${f(r.stats.meanD)} CI [${f(r.stats.ciLow)}, ${f(r.stats.ciHigh)}] `
      + `BOOTSTRAP_ITER ${f(r.stats.bootstrapIterations)}`,
    `CONCLUSION ${r.conclusionText}`,
    `MECHANISM_PROVEN ${r.mechanismProven}`,
    `SCRIPT_HASH ${meta.scriptHash}`,
    `BUILD_HASH ${meta.buildHash}`,
    `PLAN_HASH ${extra.planHash}`,
    `FROZEN_PLAN_HASH ${extra.frozenPlanHash}`,
    `SALT_SOURCE ${extra.saltSource}`,
    `ON_KEY_MATCH ${extra.onKeyMatch}/${extra.onKeyTotal}`,
    `STOP ${extra.stopReason === null ? 'none' : extra.stopReason}`,
    `STATUS ${extra.status}`,
  ]
}

/**
 * 跑一次实验。返回 { meta, records, report, lines, exitCode }。
 * `network` 决定走真实上游还是合成自测；调用方负责门控。
 */
export async function runExperiment(opts) {
  const { args, network } = opts
  const synthetic = !network
  const params = {
    groups: args.groups,
    warmTurns: args.warmTurns,
    repeats: args.repeats,
    maxTokens: args.maxTokens,
    accountAlias: args.accountAlias,
    model: args.model,
    endpointAlias: args.endpointAlias,
    seed: args.seed,
    templateVersion: core.TEMPLATE_VERSION,
    usageIdentity: args.usageIdentity,
    wireProfile: args.wireProfile,
    experimentKind: synthetic ? 'OFFLINE_SYNTHETIC' : 'REAL',
  }
  const check = core.validateParams(params)
  if (!check.ok) {
    throw new Error(check.errors[0]?.code ?? 'PARAM_INVALID')
  }
  const plan = core.buildPlan(params)

  const scriptHash = computeScriptHash()
  const buildHash = computeBuildHash()
  const planHash = sha256(core.stableStringify(plan))
  let frozenPlanHash = 'MISSING'
  try { frozenPlanHash = sha256(readFileSync(FROZEN_PLAN_PATH)) } catch { /* 可选证据 */ }

  // 冷前缀：每进程一次性 nonce。跨 run（pilot / formal 独立进程）前缀互异 ⇒ 冷启动。
  const runTag = randomBytes(8).toString('hex')
  const tagFor = (prefixAlias) => createHash('sha256')
    .update(`dsh-e/v1|${runTag}|${params.seed}|${prefixAlias}`).digest('hex').slice(0, 16)
  const prefix = FILLER.repeat(PREFIX_REPEATS)

  // 每臂 body 只构建一次：cold + 5 warm 复用同一 byte-identical body。
  const bodyFor = new Map()
  for (const entry of plan.entries) {
    if (bodyFor.has(entry.prefixAlias)) continue
    const content = `${tagFor(entry.prefixAlias)}\n\n${prefix}\n\n${SUFFIX}`
    bodyFor.set(entry.prefixAlias, prepareChatBody(JSON.stringify({
      model: params.model,
      messages: [{ role: 'user', content }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: params.maxTokens,
    })))
  }

  // 凭证 / 设备盐：仅真实模式读本机；合成模式用假凭证（无网络、无 token 真值）。
  // 盐只读一次，两个 client 共享同一值，来源写入 meta。
  let credential
  let deviceSalt
  let saltSource = 'synthetic'
  if (!synthetic) {
    credential = { ...loadCredential() } // 可能抛固定类别码
    const saltInfo = loadDeviceSalt()
    deviceSalt = saltInfo.salt
    saltSource = saltInfo.source
  } else {
    credential = {
      accessToken: 'synthetic-token',
      domain: 'synthetic.cn',
      uid: '100000000001',
    }
    deviceSalt = FALLBACK_SALT
  }

  const offClient = new WorkBuddyUpstreamClient(undefined, { deviceSalt })
  const onClient = new WorkBuddyUpstreamClient(undefined, { deviceSalt, stableConversationId: true })

  // 窄范围 fetch 桩：捕获 init.headers 后转发（真实或合成）。串行 ⇒ 每次一捕获一请求。
  // 绑定 globalThis：真实 undici fetch 以裸函数调用更稳妥，避免脱离 receiver 报错。
  const realFetch = globalThis.fetch.bind(globalThis)
  const baseFetch = synthetic ? makeSyntheticFetch() : realFetch
  let capturedHeaders = null
  globalThis.fetch = async (url, init) => {
    capturedHeaders = init !== undefined && init.headers !== undefined ? init.headers : null
    return baseFetch(url, init)
  }

  const now = () => Date.now()
  const records = []
  const snapshots = []
  let stopReason = null
  let consecutiveIncomplete = 0
  let onKeyMatch = 0
  let onKeyTotal = 0

  try {
    for (const entry of plan.entries) {
      const body = bodyFor.get(entry.prefixAlias)
      const client = entry.arm === 'ON' ? onClient : offClient
      capturedHeaders = null
      const sentAt = now()
      let httpStatus = null
      let requestStatus = 'OK'
      let streamStatus = 'EMPTY'
      let norm = core.emptyNormalizedUsage()
      let failureCode = 'NONE'

      try {
        const result = await client.chatStream(credential, body, AbortSignal.timeout(args.timeoutMs))
        if (result.ok === true) {
          httpStatus = typeof result.response.status === 'number' ? result.response.status : 200
          const text = await result.response.text() // 完整读取后才发下一条（串行）
          const analysis = core.analyzeStream(text)
          streamStatus = analysis.streamStatus
          norm = analysis.streamStatus === 'COMPLETE'
            ? core.normalizeUsage(adaptTerminalUsage(analysis.terminal))
            : core.emptyNormalizedUsage()
          if (analysis.streamStatus === 'SSE_ERROR') failureCode = 'SSE_ERROR'
          else if (analysis.streamStatus === 'TRUNCATED') failureCode = 'STREAM_TRUNCATED'
          else if (analysis.streamStatus === 'NO_TERMINAL_USAGE') failureCode = 'NO_TERMINAL_USAGE'
          else if (!norm.valid) failureCode = 'USAGE_INVALID'
        } else {
          // 绝不读 / 打印 result.message（可能含上游文本 / 账号信息）。
          const st = typeof result.status === 'number' ? result.status : 0
          httpStatus = st
          streamStatus = 'ERROR'
          if (st === 0) { requestStatus = 'NETWORK_ERROR'; failureCode = 'NETWORK_ERROR' }
          else { requestStatus = 'HTTP_ERROR'; failureCode = 'HTTP_ERROR' }
          norm = core.emptyNormalizedUsage()
        }
      } catch (err) {
        // 只读 error.name / ctor.name 类别，绝不读 err.message / String(err)。
        requestStatus = core.classifyRequestError(err)
        failureCode = core.toFailureCode(err)
        streamStatus = 'ERROR'
        norm = core.emptyNormalizedUsage()
      }
      const completedAt = now()

      const headers = capturedHeaders
      const snapshot = {
        group: entry.group,
        arm: entry.arm,
        order: entry.order,
        conversationId: headerValue(headers, 'X-Conversation-ID') ?? '',
        requestId: headerValue(headers, 'X-Conversation-Request-ID') ?? '',
        messageId: headerValue(headers, 'X-Conversation-Message-ID') ?? '',
        rootId: headerValue(headers, 'X-Root-Request-ID') ?? '',
        xRequestId: headerValue(headers, 'X-Request-ID'), // usageIdentity=false ⇒ null
      }

      // feature 参与一致性：ON 的 conversationId 必须等于派生键。
      if (entry.arm === 'ON') {
        onKeyTotal += 1
        const derived = deriveStableConversationId(body)
        if (derived !== undefined && snapshot.conversationId === derived) onKeyMatch += 1
      }

      const record = core.buildRecord({
        params, entry, httpStatus, requestStatus, streamStatus, norm, failureCode,
        aliases: core.wiringAliases(entry),
        wiringSnapshotValid: core.isValidWiringSnapshot(snapshot, params),
        sentAt, completedAt,
      })
      records.push(record)
      snapshots.push(snapshot)

      const violation = wiringViolation(snapshots, params)
      if (violation !== null) { stopReason = `WIRING_${violation}`; break }
      if (REALTIME_STOP_STATUSES.has(httpStatus)) { stopReason = `HTTP_${httpStatus}`; break }
      if (record.complete) {
        consecutiveIncomplete = 0
      } else {
        consecutiveIncomplete += 1
        if (consecutiveIncomplete >= MAX_CONSECUTIVE_INCOMPLETE) {
          stopReason = 'CONSECUTIVE_INCOMPLETE'
          break
        }
      }
    }
  } finally {
    globalThis.fetch = realFetch
  }

  const wiring = core.evaluateWiring(snapshots, params)
  const report = core.computeReport(records, wiring, params, plan)
  const meta = {
    kind: 'meta',
    schemaVersion: core.SCHEMA_VERSION,
    runId: core.syntheticRunId(params),
    scriptHash,
    buildHash,
    templateVersion: params.templateVersion,
    seed: params.seed,
    params,
    plan,
    wiring,
    e: {
      runTag,
      saltSource,
      prefixChars: prefix.length,
      planHash,
      frozenPlanHash,
      requestTimeoutMs: args.timeoutMs,
      stopReason,
      onKeyMatch,
      onKeyTotal,
    },
  }
  const lines = renderReal(report, meta, {
    planHash, frozenPlanHash, saltSource, onKeyMatch, onKeyTotal, stopReason,
    status: synthetic ? 'SYNTHETIC_DRY_RUN' : (stopReason === null ? 'COMPLETED' : 'STOPPED'),
  })
  return { meta, records, report, lines, exitCode: report.exitCode }
}

function writeJsonl(outPath, meta, records, report) {
  const lines = [core.stableStringify(meta)]
  for (const r of records) lines.push(core.serializeRecord(r))
  lines.push(core.stableStringify(report))
  try {
    writeFileSync(outPath, `${lines.join('\n')}\n`)
    return true
  } catch {
    return false
  }
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    const code = err instanceof Error && /^[A-Z_]+$/u.test(err.message) ? err.message : 'BAD_ARGS'
    process.stdout.write(`STATUS ${code}\nE_PHASE_NOT_RUN\n`)
    process.exitCode = core.EXIT.EXECUTION_FAILURE
    return core.EXIT.EXECUTION_FAILURE
  }

  const network = args.real && args.ePhaseAuthorized && !args.synthetic
  if (!network && !args.synthetic) {
    // 双 flag 门控：未授权 ⇒ 零网络、零凭证、零文件写入。
    process.stdout.write('STATUS NOT_RUN\nE_PHASE_NOT_RUN\n')
    process.exitCode = core.EXIT.NOT_RUN
    return core.EXIT.NOT_RUN
  }
  if (network && args.out === '') {
    process.stdout.write('STATUS OUT_REQUIRED\n')
    process.exitCode = core.EXIT.EXECUTION_FAILURE
    return core.EXIT.EXECUTION_FAILURE
  }

  let result
  try {
    result = await runExperiment({ args, network })
  } catch (err) {
    const code = err instanceof Error && /^[A-Z_]+$/u.test(err.message) ? err.message : 'INTERNAL'
    process.stdout.write(`STATUS ${code}\n`)
    process.exitCode = core.EXIT.EXECUTION_FAILURE
    return core.EXIT.EXECUTION_FAILURE
  }

  if (args.out !== '') {
    const ok = writeJsonl(args.out, result.meta, result.records, result.report)
    if (!ok) {
      process.stdout.write('STATUS OUT_WRITE_FAILED\n')
      process.exitCode = core.EXIT.EXECUTION_FAILURE
      return core.EXIT.EXECUTION_FAILURE
    }
  }
  for (const line of result.lines) process.stdout.write(`${line}\n`)
  process.exitCode = result.exitCode
  return result.exitCode
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined
      && import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
})()

if (isMain) {
  main().catch(() => {
    process.stdout.write('STATUS INTERNAL\n')
    process.exitCode = core.EXIT.EXECUTION_FAILURE
  })
}
