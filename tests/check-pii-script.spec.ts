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
import { execFileSync, spawnSync } from 'node:child_process'
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

function runScanner(
  dir: string,
  options: { CI?: string, quiet?: boolean } = {},
): { code: number, stderr: string } {
  const argv = [scanner]
  if (options.quiet !== false) argv.push('--quiet')
  argv.push(dir)
  try {
    execFileSync(process.execPath, argv, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // `CI` is what makes the scanner redact the value; unset means "a person
      // is reading this in a terminal".
      env: options.CI === undefined
        ? { ...process.env, CI: undefined }
        : { ...process.env, CI: options.CI },
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

/**
 * Counter-examples, BUILT AT RUNTIME rather than written down.
 *
 * A fixture file has to contain the shapes the scanner hunts for, which makes it
 * the one place where "obviously fake" and "actually fake" look identical to a
 * reader — and this repo has already been burned by exactly that: the fix for
 * one leak moved the real value into the scanner's own fixture, where it sat in
 * a public repository looking like test data.
 *
 * So these strings are assembled from pieces. The scanner sees the same bytes it
 * would see from a real leak (that is what makes the test bite), but no one can
 * copy a ready-made account number out of this file, and no exemption is needed
 * for it.
 */
const fake = {
  /** 11 digits, `1[3-9]` head, real-looking tail: the classic leak shape. */
  phone: ['139', '1234', '5678'].join(''),
  masked: ['158', '****', '6420'].join(''),
  email: ['real.person', 'gmail.com'].join('@'),
  homePath: ['/Users', 'zhangsan', 'log.txt'].join('/'),
  uin: ['1778', '8889', '9990'].join(''),
  sessionId: ['session-0f1e2d3c', '4b5a', '6978', '8a9b', '0c1d2e3f4a5b'].join('-'),
  nickname: ['用户', '7000000001'].join(''),
  nicknameLabelled: ['昵称：', '张三丰'].join(''),
  token: ['sk-', 'abcdefghijklmnopqrstuvwx'].join(''),
}

describe.each([
  ['phone-cn', `账号 ${fake.phone} 被限流`],
  ['email', `联系 ${fake.email}`],
  ['real-home-path', `日志在 ${fake.homePath}`],
  ['uin', `account: { uin: '${fake.uin}' }`],
  ['session-id', fake.sessionId],
  // Added after a second audit found real leaks sitting in the gaps these
  // three shapes cover. Each one below is a shape that actually shipped.
  ['phone-masked', `当前账号 ${fake.masked} 余额 1522`],
  ['known-nickname', `显示为 ${fake.nickname}，排行第 1`],
  ['known-nickname', fake.nicknameLabelled],
  // A uin in PROSE, not in a `uin:` fixture — this is how it leaked.
  ['uin', `账号名却读不出来而回退成一串 uin 数字（${fake.uin}）`],
  ['access-token', `key ${fake.token}`],
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
    // up verbatim in `lib/client.js` — which is exactly how a real nickname
    // reached the published package. The first version of the scanner listed
    // `lib` in SKIP_DIRS, so it reported "23 of 29 files ship" and never looked
    // at the six files users actually download.
    const dir = makeRepo({
      'lib/client.js': `/* Read as: 「${['用户', '7000000001'].join('')} · 第 1 位」 */\nexport const x = 1\n`,
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
    const dir = makeRepo({ 'docs/assets/account-pool-demo.html': `<td>${['159', '****', '1234'].join('')}</td>\n` })
    const result = runScanner(dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('phone-masked')
  })

  it('flags a real number in the policy document too', () => {
    const dir = makeRepo({ 'docs/PRIVACY.md': `例如 ${['158', '****', '6420'].join('')} 这种掩码也是敏感信息\n` })
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

/**
 * The capabilities added after an independent audit defeated the first draft.
 *
 * Every case below was a MEASURED bypass: each string passed the previous
 * scanner with exit 0. They are written at runtime for the same reason the
 * counter-examples above are — a fixture file full of plausible phone numbers is
 * the exact thing this scanner exists to catch.
 */
describe('check-pii catches the bypasses an audit found', () => {
  const build = (...parts: string[]): string => parts.join('')

  const cases: [string, string, string][] = [
    // [rule, why it used to pass, the line]
    ['phone-cn', 'separators between groups', `账号 ${build('138', '-', '1234', '-', '5678')} 被限流`],
    ['phone-cn', 'spaces between groups', `账号 ${build('138', ' ', '1234', ' ', '5678')} 被限流`],
    ['phone-cn', 'international prefix', `账号 ${build('+86', '138', '1234', '5678')} 被限流`],
    ['phone-cn', 'full-width digits', `账号 ${build('１３８', '１２３４', '５６７８')} 被限流`],
    ['uin', 'prefixed by QQ：', `QQ：${build('3301', '0577', '2757')}`],
    ['uin', 'prefixed by 账号', `账号 ${build('3301', '0577', '2757')}`],
    ['known-nickname', 'labelled without a colon', `显示名：${build('张', '三丰')}`],
    ['real-home-path', 'CJK user name', build('C:\\Users\\', '张三', '\\log.txt')],
    ['access-token', 'GitLab prefix', build('glpat-', 'abcdefghijklmnop')],
    ['access-token', 'Slack prefix', build('xoxb-', '123456789012')],
  ]

  it.each(cases)('reports %s (%s)', (ruleId, _why, line) => {
    const dir = makeRepo({ 'leak.md': line + '\n' })
    const result = runScanner(dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`rule   ${ruleId}`)
  })

  it('reads a UTF-16LE file instead of skipping it', () => {
    // Windows editors emit UTF-16 with a BOM by default; the old scanner saw the
    // NUL bytes and returned without a word.
    const dir = makeRepo({})
    const body = Buffer.from([0xFF, 0xFE])
    const text = `手机号 ${build('139', '1234', '5678')}\n`
    writeFileSync(join(dir, 'utf16.md'), Buffer.concat([body, Buffer.from(text, 'utf16le')]))
    const result = runScanner(dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('utf16.md')
  })

  it('scans hidden files, not just visible ones', () => {
    // `.env`, `.npmrc` and `.vscode/` are exactly what a hurried commit sweeps
    // in, and the first version skipped every dot entry.
    //
    // The leak below is deliberately a PATH, not a token: a token-shaped string
    // in the FILE NAME would also be caught by the name scanner, which would let
    // this test pass even with the content scan switched off (verified — that is
    // exactly what a mutation run showed).
    const dir = makeRepo({
      '.vscode/settings.json': `{ "terminal.integrated.cwd": "${build('C:\\\\Users\\\\', 'zhangsan')}" }\n`,
    })
    const result = runScanner(dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('.vscode/settings.json')
    expect(result.stderr).toContain('real-home-path')
  })

  it('flags a leak carried by a FILE NAME', () => {
    const dir = makeRepo({ [`${build('138', '1234', '5678')}-shot.md`]: 'nothing here\n' })
    const result = runScanner(dir)
    expect(result.code).toBe(1)
  })

  it('redacts the value when the output may be published', () => {
    // The gate failing on a real leak used to PRINT that leak — on a public repo
    // the CI log is public, permanent and search-indexed.
    const dir = makeRepo({ 'leak.md': `账号 ${build('139', '1234', '5678')}\n` })
    const result = runScanner(dir, { CI: '1', quiet: false })
    expect(result.code).toBe(1)
    expect(result.stderr).not.toContain(build('139', '1234', '5678'))
    expect(result.stderr).toContain('rule   phone-cn')
  })

  it('scans stdin, so a commit message can be checked', () => {
    const dir = makeRepo({ 'package.json': JSON.stringify({ name: 'x', files: [] }) })
    const result = spawnSync(process.execPath, [scanner, '--stdin'], {
      cwd: dir, encoding: 'utf8',
      input: `fix: 账号 ${build('139', '1234', '5678')}\n`,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('stdin')
  })
})
