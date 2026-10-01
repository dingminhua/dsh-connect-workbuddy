#!/usr/bin/env node
/**
 * Is the WorkBuddy markup leak real, and is it still happening? Answers it
 * with evidence a reader can re-derive rather than a claim they must trust.
 *
 *   node scripts/verify-dsml.mjs              # 静态核对（不联网，约 1 秒）
 *   node scripts/verify-dsml.mjs --live 3     # 再加 3 轮真上游请求（花积分）
 *
 * Two modes, on purpose:
 *
 *   Static (default) reads the DSH session store, the plugin source, and git —
 *   offline, no credentials, no writes. It answers "does recorded evidence of
 *   the defect exist, and could today's code have prevented it?"
 *
 *   Live calls the real upstream and reports which shape came back. Live is
 *   opt-in because it spends credit, and because the model OSCILLATES: this
 *   project has captured 6/6 markup on one run and 3/3 clean on another. A
 *   single clean live run therefore proves nothing, and the script says so
 *   instead of implying the defect is gone.
 *
 * Detection logic lives in `src/markup-diagnosis.ts` (pure, unit-tested); this
 * file only does the reading. Both are read-only: nothing here writes to the
 * repo, the profile, or the upstream.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  analyzeSessionEvents,
  classifyStream,
  MARKUP_TOKEN,
} from '../src/markup-diagnosis.ts'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const SESSION_ROOT = join(homedir(), '.dsh', 'sessions')

/** Strip anything token-like before it can reach a terminal or a log. */
function redact(text) {
  return String(text)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[token]')
    .replace(/((?:token|refresh_token|access_token|code)"?\s*[:=]\s*"?)[A-Za-z0-9._-]{12,}/giu, '$1[redacted]')
    .replaceAll(homedir(), '~')
}

/** Run a command that is EXPECTED to fail without matching anything. */
function tryExec(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim()
  } catch {
    return ''
  }
}

/**
 * Find every DSH session directory that belongs to this project.
 *
 * Returns newest-first so the report can lead with the most recent occurrence,
 * and skips directories without a session log (locks, empty scaffolding).
 */
function findSessions() {
  if (!existsSync(SESSION_ROOT)) return []
  const found = []
  for (const group of readdirSync(SESSION_ROOT)) {
    if (!group.includes('dsh-connect-workbuddy')) continue
    for (const entry of readdirSync(join(SESSION_ROOT, group))) {
      const log = join(SESSION_ROOT, group, entry, 'session.v4.jsonl.zstd')
      if (existsSync(log)) found.push({ name: entry, log })
    }
  }
  return found
}

/** Decompress one session log to JSONL text, or '' when unreadable. */
function readSessionLog(logPath) {
  try {
    return execFileSync('zstd', ['-dc', logPath], { encoding: 'utf8', maxBuffer: 1 << 30 })
  } catch {
    return ''
  }
}

/**
 * Reduce one session log to the messages the pure analyzer understands.
 *
 * Two event shapes carry model output, and both are read: `assistant/message`
 * (the transcript) and the model's own recovery feedback. Route selection is
 * tracked alongside, because "which route produced this" is the first question
 * anyone asks and it is not recorded on the message itself.
 */
function messagesOf(jsonl) {
  const messages = []
  const selections = []
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'model/selection') {
      selections.push({ seq: event.seq, provider: event.data?.provider, model: event.data?.model })
      continue
    }
    if (event.type !== 'assistant/message') continue
    const content = event.data?.message?.content ?? []
    const route = selections.filter(s => s.seq <= event.seq).slice(-1)[0]
    messages.push({
      blockTypes: content.map(c => c.type),
      text: content.filter(c => c.type === 'text').map(c => c.text).join(''),
      provider: route?.provider,
      model: route?.model,
      seq: event.seq,
    })
  }
  return messages
}

function staticChecks() {
  console.log('=== 1. 会话记录里，模型真的把调用写进正文过吗 ===')
  const sessions = findSessions()
  let emissions = 0
  let emissionsWithCall = 0
  let mentions = 0
  const hits = []
  for (const session of sessions) {
    const jsonl = readSessionLog(session.log)
    if (jsonl === '') continue
    const report = analyzeSessionEvents(messagesOf(jsonl))
    if (report.emissions === 0) continue
    emissions += report.emissions
    emissionsWithCall += report.emissionsWithStructuredCall
    mentions += report.mentions
    hits.push({ session: session.name, report })
  }
  hits.sort((a, b) => b.report.emissions - a.report.emissions)
  console.log(`  扫了 ${sessions.length} 个本项目的会话`)
  for (const hit of hits.slice(0, 8)) {
    console.log(`  · ${hit.session}: 正文里发出 ${hit.report.emissions} 次`
      + `（其中 ${hit.report.emissionsWithStructuredCall} 次同时也带真正的工具调用块）`
      + `　另有 ${hit.report.mentions} 次只是在讨论/引用它，不计入`)
  }
  if (emissions === 0) {
    console.log('  （没有找到真实发出的记录——如果这是新机器/新配置，说明还没复现过）')
  }
  const unrouted = emissions - emissionsWithCall
  console.log(`  合计：正文里发出 ${emissions} 次，其中 ${unrouted} 次**没有**任何工具调用块`
    + `（这些必然被当正文渲染）`)
  console.log(`  另有 ${mentions} 条只是在讨论/引用它（写在代码块里），已单独计数、不计入上面——`
    + `把它们算进去会把问题夸大成好几倍。`)
  if (hits[0]) {
    const sample = hits[0].report.sample
    const tool = hits[0].report.sampleTool ?? '?'
    console.log(`\n  最近一条真实发出的样子（${sample.provider ?? '?'} / ${sample.model ?? '?'}，`
      + `第 ${sample.seq} 条，想调的工具名 ${tool}）：`)
    console.log(`  ${redact(sample.text).slice(-500).replace(/\n/g, '\n  ')}`)
  }

  console.log('\n=== 2. 现在的代码有没有能力拦住它 ===')
  const grepHits = tryExec('grep', ['-rIn', 'DSML\\|uff5c\\|FF5C', join(REPO, 'src')])
  const shimLine = tryExec('grep', ['-n', 'body.pipe(res)', join(REPO, 'src', 'shim.ts')])
  const commits = tryExec('git', ['-C', REPO, 'log', '--all', '--oneline', '--grep=DSML'])
  console.log(`  src/ 里提到标记的代码：${grepHits === '' ? '只有本诊断模块（见下）' : `${grepHits.split('\n').length} 处`}`)
  for (const line of grepHits.split('\n').filter(Boolean).slice(0, 6)) {
    console.log(`    ${redact(line).slice(0, 140)}`)
  }
  console.log(`  响应路径：${shimLine === '' ? '未找到' : redact(shimLine)}`)
  console.log(`  修过这个问题的提交：${commits === '' ? '没有' : commits}`)

  console.log('\n=== 结论 ===')
  const branch = tryExec('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'])
  const dirty = tryExec('git', ['-C', REPO, 'status', '--porcelain'])
  console.log(`  仓库状态：${branch}${dirty === '' ? '（干净）' : '（有未提交改动）'}`)
  const stillPassThrough = /body\.pipe\(res\)/.test(shimLine)
  if (unrouted > 0 && !stillPassThrough) {
    console.log('  ⚠ 记录里有泄漏，而响应路径已不再原样透传——需要人工确认是谁拦的。')
  } else if (unrouted > 0) {
    console.log(`  → 记录证明泄漏真实发生过（${unrouted} 次调用无法被路由），而响应路径仍是原样透传、`)
    console.log('    src/ 里除了本诊断模块没有任何转换器：所以"能拦住它的代码"今天并不存在。')
    console.log('    这不是"修复后回归"，是从来没修过。')
  } else {
    console.log('  → 本次没有找到真实发出的记录。（模型会摇摆，这不等于问题不存在。）')
  }
}

async function liveChecks(rounds) {
  console.log(`\n=== 3. 现在再问一次上游（${rounds} 轮，会花积分）===`)
  let plugin
  try {
    plugin = await import('../lib/index.js')
  } catch (error) {
    console.log(`  跳过：读不到构建产物 lib/index.js（先跑 pnpm run build）。${redact(error.message)}`)
    return
  }
  const { WorkBuddyCredentialStore, WorkBuddyUpstreamClient, prepareChatBody } = plugin
  const client = new WorkBuddyUpstreamClient()
  const store = new WorkBuddyCredentialStore({ refresh: c => client.refreshToken(c) })
  const accounts = await store.accounts()
  if (accounts.length === 0) {
    console.log('  跳过：这台机器上没有可用的 WorkBuddy 凭据。')
    return
  }
  const credential = await store.resolve()
  console.log(`  账号：${credential.nickname}（${credential.domain || 'cn'}）`)

  // The model id comes from the account's own catalog, not a guess: a hardcoded
  // id silently becomes a 404 the day the roster changes, and a diagnostic that
  // fails for an unrelated reason still looks like "nothing reproduced". The
  // defect has only ever been observed on the v4.1-flash family, so prefer that
  // when the account offers it and say so when falling back.
  let model = ''
  try {
    const catalog = await client.fetchModels(credential)
    model = catalog.find(m => m.id === 'deepseek-v4.1-flash')?.id
      ?? catalog.find(m => /v4\.1-flash/.test(m.id))?.id
      ?? ''
    if (model === '') {
      console.log(`  跳过：该账号的模型目录里没有 v4.1-flash 系列（共 ${catalog.length} 个模型）。`)
      console.log('  这个缺陷只在 v4.1-flash 上观察到过，换别的模型测没有意义。')
      return
    }
    console.log(`  模型：${model}（取自该账号的真实目录）`)
  } catch (error) {
    console.log(`  跳过：取模型目录失败。${redact(error.message)}`)
    return
  }

  // Two tools only: the smallest request that still asks for a call. The tool
  // set does not have to be the real one — what is being measured is whether
  // the model writes the call into the text, which is a property of the model.
  const tools = [{
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  }]
  const shapes = { 'markup-in-content': 0, 'native-tool-call': 0, 'text-only': 0, empty: 0 }
  for (let i = 1; i <= rounds; i++) {
    const body = prepareChatBody(JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are an AI agent. Use the provided tools to act; never describe a tool call in prose.' },
        { role: 'user', content: `用 bash 工具列出 /tmp 的文件（第 ${i} 次）。` },
      ],
      tools,
      stream: true,
    }))
    const result = await client.chatStream(credential, body, AbortSignal.timeout(120_000))
    if (!result.ok) {
      console.log(`  第 ${i} 轮：上游返回 ${result.status}，本轮不算`)
      continue
    }
    const verdict = classifyStream(await result.response.text())
    shapes[verdict.shape] += 1
    const icon = verdict.shape === 'markup-in-content' ? '❌' : verdict.shape === 'native-tool-call' ? '✅' : '·'
    console.log(`  ${icon} 第 ${i} 轮：${verdict.shape}`
      + `　content 分片 ${verdict.contentFrames}／tool_calls 分片 ${verdict.toolCallFrames}`
      + `／finish_reason=${verdict.finishReason || '-'}`)
    if (verdict.markup) console.log(`      ${redact(verdict.markup.excerpt).slice(0, 200)}`)
  }
  console.log(`\n  实际分布：标记 ${shapes['markup-in-content']}／原生 ${shapes['native-tool-call']}`
    + `／纯文字 ${shapes['text-only']}／空 ${shapes.empty}（共 ${rounds} 轮）`)
  // The summary sentence is generated, not asserted: telling a reader "the
  // defect is back" from one bad round, or "it's fixed" from one clean one,
  // would misuse exactly the oscillation this script warns about.
  if (shapes['markup-in-content'] > 0) {
    console.log(`  → 复现了：这一次模型把调用写进了正文。`)
  } else if (shapes['native-tool-call'] > 0) {
    console.log('  → 本次没复现。注意：这个模型在两种形态之间摇摆，一次干净**不能**证明问题消失——多跑几轮才有效。')
  } else {
    console.log('  → 本次没有得到可用结果（既没有标记也没有原生调用），不能作为证据。')
  }
}

const liveIndex = process.argv.indexOf('--live')
const rounds = liveIndex >= 0 ? Math.max(1, Math.min(20, Number(process.argv[liveIndex + 1]) || 3)) : 0

// The constant is the DOUBLED spelling, but matching accepts one or two bars on
// each side — a real captured emission mixed both spellings inside ONE block, and
// the bar count is not part of what identifies the marker. Printing the constant
// as "the detected token" understates what is actually matched, which is exactly
// the kind of quiet mismatch this script exists to catch elsewhere.
console.log('标记检测：｜DSML｜ 与 ｜｜DSML｜｜（任意 1–2 个全角竖线 U+FF5C，两种写法都命中）')
void MARKUP_TOKEN
console.log(`仓库：${REPO}\n`)
staticChecks()
if (rounds > 0) await liveChecks(rounds)
console.log('\n（本脚本只读：不写仓库、不改配置、不发任何非 AI 请求。）')
