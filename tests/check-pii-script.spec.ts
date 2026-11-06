/**
 * Does `scripts/check-pii.mjs` still CATCH things?
 *
 * WHY THIS TEST EXISTS. A privacy scanner that only ever exits 0 is worse than
 * no scanner: it turns "we checked" into a false statement. The failure mode is
 * silent and gradual — someone widens an `allow` predicate to quiet one noisy
 * hit, and the rule stops matching anything at all. Nothing in the repo would
 * notice, because the clean run looks exactly the same.
 *
 * So each case below builds a throwaway directory containing one offending file,
 * runs the real script against THAT directory, and asserts the specific rule
 * fired.
 *
 * WHY A TEMP DIRECTORY AND NOT `docs/`. The first version of this file dropped
 * the probe into `docs/` and deleted it afterwards. That made the suite
 * order-dependent: `privacy-gate.spec.ts` runs the scanner over the real repo in
 * parallel, so it kept seeing the probe and failing at random. Isolating the
 * probe in its own root removes the coupling entirely — and, as a bonus, proves
 * the scanner takes a target directory rather than assuming the cwd.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const scanner = join(root, 'scripts', 'check-pii.mjs')

/** Directories created by the current test; removed in afterEach. */
const scratch: string[] = []

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-pii-'))
  scratch.push(dir)
  // The scanner refuses to run without a manifest; `files` decides what counts
  // as "ships to npm", which is how the [SHIPS TO NPM] marker gets exercised.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', files: ['.'] }, null, 2))
  for (const [name, body] of Object.entries(files)) {
    const target = join(dir, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body, 'utf8')
  }
  return dir
}

function runScanner(dir: string): { code: number, stderr: string } {
  try {
    execFileSync(process.execPath, [scanner, '--quiet', dir], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stderr: '' }
  } catch (error) {
    const e = error as { status?: number, stderr?: string }
    return { code: e.status ?? 1, stderr: e.stderr ?? '' }
  }
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.each([
  ['phone-cn', '账号 13912345678 被限流'],
  ['email', '联系 real.person@gmail.com'],
  ['real-home-path', '日志在 /Users/zhangsan/log.txt'],
  ['uin', "account: { uin: '177888899990' }"],
  ['session-id', 'session-0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'],
  // Added after a second audit found real leaks sitting in the gaps these
  // three shapes cover. Each one below is a shape that actually shipped.
  ['phone-masked', '当前账号 158****6420 余额 1522'],
  ['known-nickname', '显示为 用户7520607992，排行第 1'],
  ['known-nickname', '昵称：张三丰'],
  // A real uin in PROSE, not in a `uin:` fixture — this is how it leaked.
  ['uin', '账号名却读不出来而回退成一串 uin 数字（330105772757）'],
  ['access-token', 'key sk-abcdefghijklmnopqrstuvwx'],
])('check-pii catches %s', (ruleId, line) => {
  it('reports it and exits non-zero', () => {
    const dir = makeRepo({ 'leak.md': line + '\n' })
    const result = runScanner(dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('leak.md')
    expect(result.stderr).toContain(`rule   ${ruleId}`)
    // `files: ["."]` means everything ships, so the marker must be present.
    expect(result.stderr).toContain('[SHIPS TO NPM]')
  })
})

describe('check-pii scans build output', () => {
  it('flags a leak that is only in a JSDoc comment of a built bundle', () => {
    // tsdown keeps JSDoc, so a real nickname written in a source comment ends
    // up verbatim in `lib/client.js` — which is exactly how `用户7520607992`
    // reached the published package. The first version of the scanner listed
    // `lib` in SKIP_DIRS, so it reported "23 of 29 files ship" and never looked
    // at the six files users actually download.
    const dir = makeRepo({
      'lib/client.js': '/* Read as: 「用户7520607992 · 第 1 位」 */\nexport const x = 1\n',
    })
    const result = runScanner(dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('lib/client.js')
    expect(result.stderr).toContain('known-nickname')
  })
})

describe('check-pii does not exempt whole files', () => {
  it('flags a masked number in the demo page', () => {
    // The demo page used to be exempt by filename, so a real number pasted
    // there later would have passed. Only the exact invented values pass now.
    const dir = makeRepo({ 'docs/assets/account-pool-demo.html': '<td>159****1234</td>\n' })
    const result = runScanner(dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('phone-masked')
  })

  it('flags a real number in the policy document too', () => {
    const dir = makeRepo({ 'docs/PRIVACY.md': '例如 158****6420 这种掩码也是敏感信息\n' })
    expect(runScanner(dir).code).toBe(1)
  })
})

describe('check-pii leaves obvious fixtures alone', () => {
  it('does not flag the placeholders the suite already uses', () => {
    // If these started failing, every fixture in the repo would have to change
    // and people would just widen `allow` — which is how a scanner dies.
    const dir = makeRepo({
      'fixtures.md': [
        "home: 'C:\\\\Users\\\\test'",
        "const p = '/Users/currentUser/.local/share'",
        "account: { uin: '100000000001' }",
        "expect(x).not.toContain('13800000000')",
        'contact someone@example.com',
      ].join('\n'),
    })
    const result = runScanner(dir)
    expect(result.code).toBe(0)
  })

  it('lets the policy document use obviously-fake placeholders', () => {
    // PRIVACY.md must spell the forbidden shapes out to be useful, and it was
    // exempt from scanning for exactly that reason — which is how a real masked
    // account number lived in it, in the published tarball, for a whole release.
    // It is scanned now; the escape hatch is the placeholder values, not the
    // filename.
    const dir = makeRepo({
      'docs/PRIVACY.md': [
        '完整手机号如 1XX****XXXX 不许出现，本机路径 /Users/<you> 也不行。',
        '测试里可以用 13800000000 和 someone@example.com。',
      ].join('\n'),
    })
    expect(runScanner(dir).code).toBe(0)
  })
})
