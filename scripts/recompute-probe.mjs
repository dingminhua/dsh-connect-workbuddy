#!/usr/bin/env node
/**
 * §7 纯离线复算器。只读一个 JSONL 记录文件即可重产：
 *   - 完整性报告（dataStatus + 逐轮记录校验）
 *   - 组级统计（R_ON / R_OFF / D）
 *   - 配对 mean(D) 与 bootstrap 区间（若记录完整）
 *   - 结论文本与退出码
 *
 * 硬约束：
 *   - 不访问网络、不读凭证 / profile / 账号、不依赖隐藏日志、不读真实实验数据。
 *   - 所有输入都来自传入的 JSONL 文本；随机数只由记录里的 seed 驱动（确定性）。
 *   - 输出只有固定状态类别、计数、运行内别名与结论文本；绝不打印响应正文、headers、
 *     原始异常、真实 ID 前缀。
 *   - E 阶段未授权：不生成真实数据文件，只提供 schema + 合成样例 + 复算自测。
 *
 * 用法：
 *   node scripts/recompute-probe.mjs --in /tmp/probe.jsonl
 *   node scripts/recompute-probe.mjs --self-test
 *
 * 退出码：0 复算成功（不论数据是否完整）；1 输入损坏 / 参数错误。
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import * as core from './probe-core.ts'

export const RECOMPUTE_EXIT = { OK: 0, BAD_INPUT: 1 }

/**
 * 解析 JSONL：第一行必须是 meta，中间是 record，最后可选一行现场 report。
 * 任何解析失败都抛固定类别错误（不带原文）。
 */
export function parseJsonl(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) throw new Error('EMPTY_JSONL')
  const parsed = lines.map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      throw new Error('MALFORMED_JSONL_LINE')
    }
  })
  const meta = parsed[0]
  if (meta === undefined || meta.kind !== 'meta') throw new Error('MISSING_META')
  if (meta.schemaVersion !== core.SCHEMA_VERSION) throw new Error('SCHEMA_MISMATCH')
  if (meta.params === undefined || meta.plan === undefined || meta.wiring === undefined) {
    throw new Error('META_INCOMPLETE')
  }
  const records = []
  let storedReport = null
  for (let i = 1; i < parsed.length; i += 1) {
    const item = parsed[i]
    if (item.kind === 'record') records.push(item)
    else if (item.kind === 'report') storedReport = item
    else throw new Error('UNKNOWN_JSONL_RECORD_KIND')
  }
  return { meta, records, storedReport }
}

/**
 * 从 JSONL 文本独立重建报告与统计。仅用 meta.params / meta.plan / meta.wiring /
 * 逐轮 records，不借用现场 report 的任何派生结论。
 */
export function recomputeFromJsonl(text) {
  const { meta, records, storedReport } = parseJsonl(text)
  const params = meta.params
  const plan = meta.plan
  const wiring = meta.wiring

  const dataStatus = core.computeDataStatus(records, params, plan)
  const stats = core.computeStats(records, params)
  const perRecord = records.map((r) => core.validateRecord(r))
  const recomputedReport = core.computeReport(records, wiring, params, plan)

  let match = null
  if (storedReport !== null) {
    match = core.stableStringify(recomputedReport) === core.stableStringify(storedReport)
  }

  return {
    params,
    plan,
    wiring,
    dataStatus,
    stats,
    perRecord,
    report: recomputedReport,
    storedReport,
    match,
    completeness: {
      totalRecords: records.length,
      plannedRequests: plan.totalRequests,
      completeRecords: records.filter((r) => r.complete).length,
      incompleteRecords: records.filter((r) => !r.complete).length,
      conflictRecords: records.filter((r) => r.conflicts.length > 0).length,
      invalidRecords: records.filter((r) => r.invalidCodes.length > 0).length,
      completeGroups: stats.completeGroups,
      plannedGroups: stats.plannedGroups,
    },
  }
}

/** 固定格式渲染：完整性与组级统计、配对区间、结论、与现场 report 是否一致。 */
export function renderRecompute(res) {
  const c = res.completeness
  const s = res.stats
  const r = res.report
  const fmt = (v) => (v === null ? 'null' : String(v))
  const lines = [
    `SCHEMA ${r.schemaVersion}`,
    `RUN ${r.runId}`,
    `TEMPLATE ${r.templateVersion}`,
    `EXPERIMENT ${r.experimentKind}`,
    `REAL ${r.realExperiment}`,
    `WIRING ${r.wiringStatus}`,
    `DATA ${r.dataStatus}`,
    `EFFECT ${r.effectStatus}`,
    `EXIT ${r.exitCode}`,
    `COMPLETENESS records=${c.totalRecords}/${c.plannedRequests} `
      + `complete=${c.completeRecords} incomplete=${c.incompleteRecords} `
      + `conflict=${c.conflictRecords} invalid=${c.invalidRecords}`,
    `GROUPS complete=${c.completeGroups}/${c.plannedGroups}`,
    `MEAN_D ${fmt(s.meanD)} CI [${fmt(s.ciLow)}, ${fmt(s.ciHigh)}] `
      + `BOOTSTRAP_ITER ${fmt(s.bootstrapIterations)} BOOTSTRAP_SEED ${fmt(s.bootstrapSeed)}`,
    `FIRST_WARM_DIFF ${fmt(s.firstWarmDiff)}`,
    `WEIGHTED_ON ${fmt(s.weightedOnHitRate)} WEIGHTED_OFF ${fmt(s.weightedOffHitRate)}`,
    `CONCLUSION ${r.conclusionText}`,
    `MECHANISM_PROVEN ${r.mechanismProven}`,
    `MATCH_LIVE_REPORT ${res.match === null ? 'NO_STORED_REPORT' : String(res.match)}`,
  ]
  for (const g of s.groupStats) {
    lines.push(`GROUP ${g.group} R_OFF=${fmt(g.rOff)} R_ON=${fmt(g.rOn)} `
      + `D=${fmt(g.d)} COMPLETE=${g.complete} REASON=${fmt(g.reason)}`)
  }
  return lines
}

// ---------------------------------------------------------------------------
// 合成样例 + 复算自测（E 未授权：只在内存里造数据，不落真实文件）
// ---------------------------------------------------------------------------

/** 生成一段脱敏合成 JSONL（内存），结构与探针产物一致。 */
export function makeSyntheticJsonl(params, hitFraction = 0.5) {
  const plan = core.buildPlan(params)
  const records = []
  const snapshots = []
  for (const entry of plan.entries) {
    const hit = Math.round(hitFraction * 100)
    const usage = {
      prompt_cache_hit_tokens: hit,
      prompt_cache_miss_tokens: 100 - hit,
      completion_tokens: 1,
      prompt_tokens: 100,
    }
    const sse = core.makeUsageSse(usage)
    const analysis = core.analyzeStream(sse)
    const norm = core.normalizeUsage(analysis.terminal)
    const snapshot = core.buildSyntheticWiringSnapshot(entry)
    snapshots.push(snapshot)
    records.push(core.buildRecord({
      params,
      entry,
      httpStatus: 200,
      requestStatus: 'OK',
      streamStatus: analysis.streamStatus,
      norm,
      failureCode: 'NONE',
      aliases: core.wiringAliases(entry),
      wiringSnapshotValid: core.isValidWiringSnapshot(snapshot, params),
      sentAt: 0,
      completedAt: 1,
    }))
  }
  const wiring = core.evaluateWiring(snapshots, params)
  const report = core.computeReport(records, wiring, params, plan)
  const meta = {
    kind: 'meta',
    schemaVersion: core.SCHEMA_VERSION,
    runId: core.syntheticRunId(params),
    scriptHash: 'synthetic',
    buildHash: 'synthetic',
    templateVersion: params.templateVersion,
    seed: params.seed,
    params,
    plan,
    wiring,
  }
  const lines = [core.stableStringify(meta)]
  for (const r of records) lines.push(core.serializeRecord(r))
  lines.push(core.stableStringify(report))
  return `${lines.join('\n')}\n`
}

/** 复算自测：合成数据 → 复算 → 断言与现场 report 逐字节一致。 */
export function selfTest() {
  const params = {
    groups: 2,
    warmTurns: 2,
    repeats: 1,
    maxTokens: 16,
    accountAlias: '账号A',
    model: 'model-x',
    endpointAlias: 'endpoint-alias',
    seed: 7,
    templateVersion: core.TEMPLATE_VERSION,
    usageIdentity: false,
    wireProfile: 'balanced',
    experimentKind: 'OFFLINE_SYNTHETIC',
  }
  const jsonl = makeSyntheticJsonl(params)
  const res = recomputeFromJsonl(jsonl)
  const lines = renderRecompute(res)
  lines.push(`SELF_TEST_MATCH ${res.match === true ? 'PASS' : 'FAIL'}`)
  lines.push('E_PHASE_NOT_RUN')
  return { res, lines, ok: res.match === true }
}

async function main(argv = process.argv.slice(2)) {
  let inPath = ''
  let doSelfTest = false
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--in') {
      if (i + 1 >= argv.length) {
        process.stdout.write('STATUS BAD_INPUT\n')
        return RECOMPUTE_EXIT.BAD_INPUT
      }
      inPath = argv[i + 1]
      i += 1
    } else if (argv[i] === '--self-test') {
      doSelfTest = true
    } else {
      process.stdout.write('STATUS BAD_INPUT\n')
      return RECOMPUTE_EXIT.BAD_INPUT
    }
  }

  if (doSelfTest) {
    const out = selfTest()
    for (const line of out.lines) process.stdout.write(`${line}\n`)
    return out.ok ? RECOMPUTE_EXIT.OK : RECOMPUTE_EXIT.BAD_INPUT
  }

  if (inPath === '') {
    process.stdout.write('STATUS BAD_INPUT\n')
    return RECOMPUTE_EXIT.BAD_INPUT
  }

  let text
  try {
    text = readFileSync(inPath, 'utf8')
  } catch {
    // 绝不回显路径 / 异常原文。
    process.stdout.write('STATUS INPUT_READ_FAILED\n')
    return RECOMPUTE_EXIT.BAD_INPUT
  }

  let res
  try {
    res = recomputeFromJsonl(text)
  } catch (err) {
    const code = err instanceof Error ? err.message : 'UNKNOWN'
    // 只允许输出固定类别码；未知类别归一为 MALFORMED_JSONL。
    const fixed = /^[A-Z_]+$/.test(code) ? code : 'MALFORMED_JSONL'
    process.stdout.write(`STATUS ${fixed}\n`)
    return RECOMPUTE_EXIT.BAD_INPUT
  }
  for (const line of renderRecompute(res)) process.stdout.write(`${line}\n`)
  process.stdout.write('E_PHASE_NOT_RUN\n')
  return RECOMPUTE_EXIT.OK
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
      process.exitCode = RECOMPUTE_EXIT.BAD_INPUT
    })
}
