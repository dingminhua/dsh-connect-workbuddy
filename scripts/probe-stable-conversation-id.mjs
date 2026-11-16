#!/usr/bin/env node
/**
 * stableConversationId 探针（离线安全版）。
 *
 * 设计要点（对应验收方案 B1–B5）：
 *   - 纯逻辑全部在 `probe-core.ts`。本文件只做 I/O 与编排：解析 argv、注入 fetch、
 *     写 JSONL、打印固定状态行。网络通过 `runProbe(params, deps)` 显式 DI（fetch 是
 *     参数），绝不覆写 globalThis.fetch。
 *   - 仅 `import` 本模块不产生任何副作用：main() 只在作为脚本直接执行时运行。
 *     不读凭证、不访问 profile、不发网络、不改全局。
 *   - 本阶段（离线 A–D）E/F 未授权：main() 一律用合成 fetch 跑离线自测并返回
 *     NOT_RUN。真实上游入口保留为 DI —— 未来 E 阶段由调用方把真实 fetch 注入
 *     runProbe，本阶段不启用。
 *   - 输出只有固定状态类别、运行内别名、统计计数；绝不打印响应正文、headers、
 *     原始异常、真实 ID 截断前缀。缺字段用 null，不用 0 补。
 *
 * 用法（全部离线，合成数据，不消耗额度、不访问上游）：
 *   node scripts/probe-stable-conversation-id.mjs --account 账号A --groups 1 --turns 2
 *   node scripts/probe-stable-conversation-id.mjs --account 账号A --out /tmp/probe.jsonl
 *
 * 退出码见 probe-core.ts 的 EXIT：0 完整实验 / 1 执行失败 / 2 数据无效 / 3 NOT_RUN。
 */
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import * as core from './probe-core.ts'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** 解析 argv。任何异常都只抛固定类别码，绝不把参数原文塞进 message。 */
export function parseArgs(argv) {
  const out = {
    groups: 1,
    warmTurns: 2,
    repeats: 1,
    maxTokens: 16,
    accountAlias: '',
    model: 'model-x',
    endpointAlias: 'endpoint-alias',
    seed: 1,
    templateVersion: core.TEMPLATE_VERSION,
    usageIdentity: false,
    wireProfile: 'balanced',
    experimentKind: 'OFFLINE_SYNTHETIC',
    out: '',
    real: false,
    ePhaseAuthorized: false,
  }
  const valueAt = (i) => {
    if (i + 1 >= argv.length) throw new Error('MISSING_VALUE')
    return argv[i + 1]
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    switch (a) {
      case '--groups': out.groups = core.parseStrictInt(valueAt(i)); i += 1; break
      case '--turns': out.warmTurns = core.parseStrictInt(valueAt(i)); i += 1; break
      case '--repeats': out.repeats = core.parseStrictInt(valueAt(i)); i += 1; break
      case '--max-tokens': out.maxTokens = core.parseStrictInt(valueAt(i)); i += 1; break
      case '--seed': out.seed = core.parseStrictInt(valueAt(i)); i += 1; break
      case '--account': out.accountAlias = valueAt(i); i += 1; break
      case '--model': out.model = valueAt(i); i += 1; break
      case '--endpoint': out.endpointAlias = valueAt(i); i += 1; break
      case '--wire-profile': out.wireProfile = valueAt(i); i += 1; break
      case '--usage-identity': out.usageIdentity = true; break
      case '--real': out.real = true; break
      case '--e-phase-authorized': out.ePhaseAuthorized = true; break
      case '--out': out.out = valueAt(i); i += 1; break
      default: throw new Error('UNKNOWN_ARG')
    }
  }
  return out
}

/**
 * 合成 fetch：返回一段带终态 usage 的 SSE，绝不访问网络。
 * 仅用于离线自测/样例；usage 数值为合成值，不代表任何真实收益。
 */
export function makeSyntheticFetch(hitFraction = 0.5) {
  return async (_url, _init) => {
    const hit = Math.round(hitFraction * 100)
    const miss = 100 - hit
    const usage = {
      prompt_cache_hit_tokens: hit,
      prompt_cache_miss_tokens: miss,
      completion_tokens: 1,
      prompt_tokens: 100,
    }
    const sse = core.makeUsageSse(usage, { keepalive: true, crlf: true })
    return {
      status: 200,
      text: async () => sse,
    }
  }
}

/** 渲染：只输出固定状态、别名、计数与结论文本，无任何原始正文 / ID / 异常。 */
export function renderLines(report) {
  return [
    `SCHEMA ${report.schemaVersion}`,
    `RUN ${report.runId}`,
    `TEMPLATE ${report.templateVersion}`,
    `EXPERIMENT ${report.experimentKind}`,
    `REAL ${report.realExperiment}`,
    `WIRING ${report.wiringStatus}`,
    `DATA ${report.dataStatus}`,
    `EFFECT ${report.effectStatus}`,
    `EXIT ${report.exitCode}`,
    `RECORDS ${report.totalRecords} INCOMPLETE ${report.incompleteRecords} `
      + `CONFLICT ${report.conflictRecords} INVALID ${report.invalidRecords}`,
    `CONCLUSION ${report.conclusionText}`,
    `MECHANISM_PROVEN ${report.mechanismProven}`,
  ]
}

/**
 * 把一次运行序列化成逐轮脱敏 JSONL：第一行 meta，中间逐轮记录，末行现场 report。
 * report 行供 §7 复算交叉比对：复算器只从 meta+记录独立重建 report，再与此行比对。
 */
export function buildJsonl(result) {
  const lines = [core.stableStringify(result.meta)]
  for (const r of result.records) lines.push(core.serializeRecord(r))
  lines.push(core.stableStringify(result.report))
  return `${lines.join('\n')}\n`
}

/**
 * 编排一次探针运行。所有外部能力通过 deps 显式注入：
 *   deps.fetch(url, init) -> { status, text() }；deps.now()；deps.onCleanup(entry)；
 *   deps.captureWiring(entry) -> WiringSnapshot；deps.buildBody / buildHeaders。
 * 每个请求都有超时/取消，finally 里必定 abort + 触发 onCleanup（资源恢复）。
 * 失败轮绝不自动重试：每个计划条目恰好一次 fetch。
 */
export async function runProbe(params, deps = {}) {
  const plan = core.buildPlan(params)
  const fetchFn = deps.fetch ?? makeSyntheticFetch()
  const now = deps.now ?? (() => 0)
  const endpoint = deps.endpoint ?? 'endpoint-alias'
  const timeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const buildBody = deps.buildBody ?? ((entry) => JSON.stringify({
    model: params.model,
    messages: [{ role: 'user', content: `synthetic:${entry.prefixAlias}:${entry.stage}:${entry.turn}` }],
    max_tokens: params.maxTokens,
    stream: true,
  }))
  const buildHeaders = deps.buildHeaders ?? (() => ({ 'content-type': 'application/json' }))
  const captureWiring = deps.captureWiring ?? ((entry) => core.buildSyntheticWiringSnapshot(entry))
  const onCleanup = deps.onCleanup

  const records = []
  const snapshots = []

  for (const entry of plan.entries) {
    const controller = new AbortController()
    const timer = AbortSignal.timeout(timeoutMs)
    const relay = () => controller.abort(timer.reason)
    timer.addEventListener('abort', relay, { once: true })

    let httpStatus = null
    let requestStatus = 'OK'
    let streamStatus = 'EMPTY'
    let norm = core.emptyNormalizedUsage()
    let failureCode = 'NONE'
    const sentAt = now()

    try {
      const init = {
        method: 'POST',
        body: buildBody(entry, params),
        headers: buildHeaders(entry, params),
        signal: controller.signal,
      }
      const resp = await fetchFn(endpoint, init)
      httpStatus = typeof resp.status === 'number' ? resp.status : 0
      if (httpStatus < 200 || httpStatus >= 300) {
        requestStatus = 'HTTP_ERROR'
        failureCode = 'HTTP_ERROR'
        // 请求失败：没有 usage 可谈，用「空且无 invalidCodes」保持 INCOMPLETE 语义。
        norm = core.emptyNormalizedUsage()
      } else {
        const text = await resp.text()
        const analysis = core.analyzeStream(text)
        streamStatus = analysis.streamStatus
        // 流不完整/含错误时没有「无效计数」可判：空 usage（无 invalidCodes）→ INCOMPLETE。
        // 只有 COMPLETE 流才对终态 usage 做归一化与冲突/有效性判别。
        norm = analysis.streamStatus === 'COMPLETE'
          ? core.normalizeUsage(analysis.terminal)
          : core.emptyNormalizedUsage()
        if (analysis.streamStatus === 'SSE_ERROR') failureCode = 'SSE_ERROR'
        else if (analysis.streamStatus === 'TRUNCATED') failureCode = 'STREAM_TRUNCATED'
        else if (analysis.streamStatus === 'NO_TERMINAL_USAGE') failureCode = 'NO_TERMINAL_USAGE'
        else if (!norm.valid) failureCode = 'USAGE_INVALID'
        requestStatus = 'OK'
      }
    } catch (err) {
      // 绝不读取 err.message / String(err)：只映射固定类别。
      requestStatus = core.classifyRequestError(err)
      failureCode = core.toFailureCode(err)
      streamStatus = 'ERROR'
      norm = core.emptyNormalizedUsage()
    } finally {
      timer.removeEventListener('abort', relay)
      controller.abort()
      if (onCleanup !== undefined) onCleanup(entry)
    }

    const completedAt = now()
    const snapshot = captureWiring(entry)
    snapshots.push(snapshot)
    const record = core.buildRecord({
      params,
      entry,
      httpStatus,
      requestStatus,
      streamStatus,
      norm,
      failureCode,
      aliases: core.wiringAliases(entry),
      wiringSnapshotValid: core.isValidWiringSnapshot(snapshot, params),
      sentAt,
      completedAt,
    })
    records.push(record)
  }

  const wiring = core.evaluateWiring(snapshots, params)
  const report = core.computeReport(records, wiring, params, plan)
  const planHash = createHash('sha256').update(core.stableStringify(plan)).digest('hex')
  const meta = {
    kind: 'meta',
    schemaVersion: core.SCHEMA_VERSION,
    runId: core.syntheticRunId(params),
    scriptHash: planHash,
    buildHash: createHash('sha256').update(`build|${planHash}`).digest('hex'),
    templateVersion: params.templateVersion,
    seed: params.seed,
    params,
    plan,
    wiring,
  }
  const outputLines = renderLines(report)
  return { params, plan, meta, records, wiring, report, outputLines }
}

function printFixed(code, codes = []) {
  const suffix = codes.length > 0 ? ` ${codes.join(',')}` : ''
  process.stdout.write(`STATUS ${code}${suffix}\n`)
}

/** main：离线阶段只允许合成自测；真实入口以 DI 形式留给未来 E 阶段。 */
export async function main(argv = process.argv.slice(2)) {
  let raw
  try {
    raw = parseArgs(argv)
  } catch {
    printFixed('PARAM_INVALID')
    return core.EXIT.EXECUTION_FAILURE
  }

  const validated = core.validateParams(raw)
  if (!validated.ok) {
    // 只打印固定错误类别，绝不打印字段原始值。
    printFixed('PARAM_INVALID', validated.errors.map((e) => e.code))
    return core.EXIT.EXECUTION_FAILURE
  }
  const params = validated.value

  if (raw.real) {
    // 真实上游需要 E 阶段授权 + 调用方注入真实 fetch；本阶段不启用。
    printFixed('REAL_MODE_NOT_WIRED_IN_OFFLINE_PHASE')
  }

  // 合成 fetch（无网络、无凭证、无 profile）。
  const result = await runProbe(params, { fetch: makeSyntheticFetch(), now: () => 0 })
  for (const line of result.outputLines) process.stdout.write(`${line}\n`)

  if (raw.out !== '') {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(raw.out, buildJsonl(result), 'utf8')
    printFixed('OFFLINE_JSONL_WRITTEN')
  }

  // 真实实验一律 NOT_RUN。
  printFixed('E_PHASE_NOT_RUN')
  return core.EXIT.NOT_RUN
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
  main()
    .then((code) => { process.exitCode = code })
    .catch(() => {
      process.stdout.write('STATUS INTERNAL\n')
      process.exitCode = core.EXIT.EXECUTION_FAILURE
    })
}
