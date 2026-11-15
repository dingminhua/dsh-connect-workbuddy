#!/usr/bin/env node
/**
 * 阶段 E 纯离线复算器（§7）。
 *
 * 复用 `recompute-probe.mjs` 的 `parseJsonl` / `recomputeFromJsonl` / `renderRecompute`
 * —— 即「只读一个 JSONL 记录文件，用 probe-core.ts 的同一批纯函数独立重建
 * 完整性报告 / 组级统计 / 配对区间 / 结论」，与现场 report 行交叉比对。
 *
 * 与离线版 `recompute-probe.mjs --in` 的区别：
 *   - 离线版 main 在输出末尾固定打印 `E_PHASE_NOT_RUN`（A–D 阶段的状态行）。
 *     E 阶段真实实验 `REAL RUN` 时这行是误导性遗留行；本包装器**不打印它**。
 *   - 额外打印 `SCRIPT_HASH` / `BUILD_HASH`（来自 meta.e / meta 的证据哈希）、
 *     `PLAN_HASH` / `FROZEN_PLAN_HASH`、`REAL` 与 `RECOMPUTE_VERDICT`。
 *
 * 硬约束（与离线版一致）：
 *   - 不访问网络、不读凭证 / profile / 账号、不读真实实验数据以外任何东西、不依赖隐藏日志。
 *   - 所有输入来自传入的 JSONL 文本；随机数只由记录里的 seed 驱动（确定性）。
 *   - 输出只有固定状态类别、计数、运行内别名、哈希与结论文本。
 *
 * 用法：
 *   node scripts/recompute-probe-real.mjs --in /tmp/formal.jsonl
 *
 * 退出码：0 复算成功（不论数据是否完整、不论 MATCH 是否 true）；1 输入损坏 / 参数错误。
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import * as core from './probe-core.ts'
import {
  RECOMPUTE_EXIT,
  parseJsonl,
  recomputeFromJsonl,
  renderRecompute,
} from './recompute-probe.mjs'

function argValue(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return ''
  return argv[i + 1]
}

function renderRealRecompute(res, meta) {
  const lines = renderRecompute(res)
  const e = meta.e ?? {}
  const extra = [
    `SCRIPT_HASH ${meta.scriptHash ?? 'MISSING'}`,
    `BUILD_HASH ${meta.buildHash ?? 'MISSING'}`,
    `PLAN_HASH ${e.planHash ?? 'MISSING'}`,
    `FROZEN_PLAN_HASH ${e.frozenPlanHash ?? 'MISSING'}`,
    `SALT_SOURCE ${e.saltSource ?? 'MISSING'}`,
    `ON_KEY_MATCH ${e.onKeyMatch ?? 'MISSING'}/${e.onKeyTotal ?? 'MISSING'}`,
    `STOP ${e.stopReason === null || e.stopReason === undefined ? 'none' : e.stopReason}`,
  ]
  // 结论行之前插入证据哈希，保持离线版固定行序不变（便于逐行 diff）。
  const at = lines.findIndex((l) => l.startsWith('CONCLUSION '))
  const merged = at === -1 ? [...lines, ...extra] : [
    ...lines.slice(0, at), ...extra, ...lines.slice(at),
  ]
  // 复算结论只回答「离线重建是否与现场 report 一致、数据是否完整」，
  // 不把 REAL/NOT_RUN 混进来——那由上面的 EXPERIMENT / REAL 两行单独表达。
  const r = res.report
  const verdict = res.match === true
    && r.wiringStatus === 'PASS' && r.dataStatus === 'COMPLETE'
    ? 'CONSISTENT'
    : 'INCONSISTENT_OR_INCOMPLETE'
  merged.push(`RECOMPUTE_VERDICT ${verdict}`)
  return merged
}

function main() {
  const argv = process.argv.slice(2)
  const inPath = argValue(argv, '--in')
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
  let meta
  try {
    meta = parseJsonl(text).meta
    res = recomputeFromJsonl(text)
  } catch (err) {
    const code = err instanceof Error ? err.message : 'UNKNOWN'
    const fixed = /^[A-Z_]+$/u.test(code) ? code : 'MALFORMED_JSONL'
    process.stdout.write(`STATUS ${fixed}\n`)
    return RECOMPUTE_EXIT.BAD_INPUT
  }
  for (const line of renderRealRecompute(res, meta)) process.stdout.write(`${line}\n`)
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
  try {
    process.exitCode = main()
  } catch {
    process.stdout.write('STATUS INTERNAL\n')
    process.exitCode = RECOMPUTE_EXIT.BAD_INPUT
  }
}

// 便于测试与复用：导出纯函数。
export { renderRealRecompute }
void core
