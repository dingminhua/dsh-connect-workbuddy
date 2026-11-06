#!/usr/bin/env node
/**
 * Does the repository, or the npm tarball, expose anything that identifies a
 * real person, account or machine?
 *
 *   node scripts/check-pii.mjs              # repo-wide + published files + image metadata
 *   node scripts/check-pii.mjs --quiet      # only failures
 *
 * WHY THIS EXISTS. In 5.20.2 an audit found real leaks that no existing gate
 * could see: `docs/pool-header-redesign.html` carried five full mainland phone
 * numbers in plain text, `CHANGELOG.md` carried two more (and CHANGELOG ships in
 * the npm package), two `docs/pr188-mac-shots/*.png` screenshots showed masked
 * account numbers next to nicknames, and `dsh-connect-workbuddy-model-picker.png`
 * had a *cropped but unredacted* account number along its top edge — while that
 * image's alt text claimed "no account data". Nothing failed: not typecheck, not
 * the test suite, not `npm pack`. That is exactly why this is a script and not a
 * habit.
 *
 * WHAT IT CHECKS
 *   1. Every file in the `package.json` `files` whitelist (what users download).
 *   2. Every text file in the repo (docs/, tests/, HTML mock-ups included) —
 *      because "not in the tarball" is not "not public": the repo is on GitHub.
 *   3. PNG metadata chunks (tEXt / iTXt / zTXt / eXIf) for usernames and paths.
 *   4. The screenshot registry (`screenshots.json`) points at files that exist.
 *
 * WHAT IT CANNOT DO. It only recognises the shapes listed in RULES below. A new
 * kind of leak — a developer-tools screenshot, a real device fingerprint, a
 * session id in a new format — will pass. `docs/PRIVACY.md` §6 says so, and says
 * the human has to look anyway.
 *
 * Read-only. No network, no writes.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'

const args = process.argv.slice(2)
const QUIET = args.includes('--quiet')
const TARGET = args.find(a => !a.startsWith('--'))
const ROOT = resolve(TARGET ?? process.cwd())

/** Directories that are never ours to police. */
const SKIP_DIRS = new Set([
  'node_modules', 'lib', 'coverage', '.git', '.dsh-vision-router',
  '.dsh-npm-cache', '.pnpm-store', 'dist',
])

/** Binary formats we do not scan as text. Images get their own pass below. */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.node', '.zst', '.gz', '.zip', '.tgz', '.mp4', '.mp3', '.woff', '.woff2',
])

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

/**
 * Every rule says: what to look for, why it matters, and how to fix the hit.
 * `allow` lets a match through when it is a known-safe placeholder.
 */

/**
 * Path segments that are obviously invented. A real person's login name is not
 * in this set; `tester`, `dev`, `test` and `me` are the ones the suite already
 * uses as fixtures, and keeping them green is what makes the failures readable.
 */
const GENERIC_USER = new Set([
  'test', 'tests', 'tester', 'dev', 'developer', 'user', 'users', 'me',
  'you', 'runner', 'example', 'someone', 'username', 'name', 'x', 'xxx', '...',
])

/** Fictional account data in the hand-written demo page. */
const DEMO_FILE = 'docs/assets/account-pool-demo.html'

/** Numbers that exist only to prove the real one is *not* written. */
const FIXTURE_PHONES = new Set([
  '13800000000', '138****0000', '139****0001', '139****0002',
  '137****0003', '136****0004',
])

const RULES = [
  {
    id: 'phone-cn',
    pattern: /(?<![0-9])1[3-9][0-9]{9}(?![0-9])/g,
    why: '完整手机号（11 位中国大陆号码）',
    fix: '写成 1XX****XXXX，或换 138****0000 这种明显假号',
    allow: (m) => FIXTURE_PHONES.has(m),
  },
  {
    id: 'phone-masked',
    pattern: /(?<![0-9])1[0-9]{2}\*{3,6}[0-9]{2,4}(?![0-9])/g,
    why: '掩码手机号（与余额、过期时间组合后可指纹化账号）',
    fix: '正文里写成 1XX****XXXX；截图里打成实心块',
    allow: (m, file) => FIXTURE_PHONES.has(m) || file === DEMO_FILE,
  },
  {
    id: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    why: '完整邮箱地址',
    fix: '换成 someone@example.com',
    allow: (m, file, text, index) =>
      /@(example\.(com|org|net)|users\.noreply\.github\.com)$/i.test(m)
      // `https://user:secret@host` — a credential-in-URL fixture, not an address.
      // The colon immediately before the match is what gives it away.
      || (text[index - 1] === ':' && /^(secret|password|passwd|token|pwd)@/i.test(m))
      || file.endsWith('THIRD_PARTY_NOTICES.md')
      || file.endsWith('pnpm-lock.yaml'),
  },
  {
    id: 'access-token',
    pattern: /(?:\bsk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})/g,
    why: '疑似密钥 / JWT',
    fix: '立刻删除并轮换；占位写 at-fixture',
    // The suite builds JWTs whose signature is a literal word, which is how a
    // reader can tell it is not a real one.
    allow: (m) => /\.(abc+|signature|c2lnbmF0dXJl|abcdefghij)$/i.test(m),
  },
  {
    id: 'credential-in-url',
    pattern: /[A-Za-z0-9._%+-]+:([A-Za-z0-9._%-]{6,})@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    why: 'URL 里内嵌的用户名:口令',
    fix: '换成 user:secret@host 这种明显假值',
    // The gateway resolver has a case that must REJECT credentials in the URL;
    // it uses the literal `user:secret@`, which is obviously fake.
    allow: (m) => /^user:secret@/i.test(m),
  },
  {
    id: 'real-home-path',
    pattern: /(?:\/Users\/(?!<)[A-Za-z0-9._-]{2,}|\/home\/(?!<)[A-Za-z0-9._-]{2,}|[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!<)[A-Za-z0-9._-]{2,})/g,
    why: '本机绝对路径里的用户名',
    fix: '占位成 /Users/<you> 或 C:\\Users\\<you>',
    allow: (m) => {
      const seg = m.split(/[\\/]+/).filter(Boolean).pop() ?? ''
      // `/Users/currentUser` is the documented HarmonyOS mount point; the
      // comment in src/auth.ts spells a *broken* join, `currentUser.localshare`,
      // which is not a user name either.
      return GENERIC_USER.has(seg.toLowerCase())
        || seg === 'currentUser'
        || seg.startsWith('currentUser.')
    },
  },
  {
    id: 'session-id',
    pattern: /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    why: '真实会话 id',
    fix: '占位成 <session-id>',
    allow: () => false,
  },
  {
    id: 'uin',
    pattern: /(?<!\d)(?:uin|uid)['"]?\s*[:=]\s*['"]?([0-9]{11,12})(?!\d)/g,
    why: '疑似真实 uin / uid（账号级持久标识）',
    fix: '测试用 1 或 100000000001；真机日志里的数字不要粘',
    allow: (m) => /^1000000000\d{2}$/.test(m),
  },
]

/**
 * Files whose whole point is to contain the patterns being searched for.
 * The policy states them, the scanner implements them, and the mutation test
 * feeds them in to prove the scanner still bites. Scanning these would make
 * every rule match itself.
 */
const POLICY_FILES = [
  'docs/PRIVACY.md',
  'scripts/check-pii.mjs',
  'tests/check-pii-script.spec.ts',
]

const problems = []
const notes = []

function rel(p) {
  return relative(ROOT, p).split(sep).join('/')
}

function isPolicy(file) {
  return POLICY_FILES.includes(file)
}

/** Walk the tree, yielding text-file paths and skipping build/vendor dirs. */
function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

function readManifest() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Which repo files npm would actually ship, given the `files` whitelist. */
function publishedSet(manifest) {
  const files = manifest?.files ?? []
  const all = walk(ROOT)
  const shipped = new Set()
  for (const entry of files) {
    // `"."` is how a throwaway fixture dir declares "everything ships".
    const normalized = entry.replace(/[\\/]+$/, '')
    if (normalized === '.' || normalized === '') {
      for (const f of all) shipped.add(rel(f))
      continue
    }
    const target = join(ROOT, entry)
    if (!existsSync(target)) continue
    const st = statSync(target)
    if (st.isFile()) {
      shipped.add(rel(target))
    } else if (st.isDirectory()) {
      for (const f of all) {
        if (rel(f).startsWith(normalized + '/')) shipped.add(rel(f))
      }
    }
  }
  // package.json itself always ships.
  shipped.add('package.json')
  return shipped
}

function scanText(file, shippedSet) {
  if (isPolicy(rel(file))) return
  const ext = extname(file).toLowerCase()
  if (BINARY_EXT.has(ext)) return
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  if (text.includes('\u0000')) return // looks binary after all

  const repoPath = rel(file)
  const lines = text.split('\n')
  for (const rule of RULES) {
    // Re-create the regex so the shared object never carries lastIndex state.
    const rx = new RegExp(rule.pattern.source, rule.pattern.flags)
    let m
    while ((m = rx.exec(text)) !== null) {
      const value = rule.id === 'uin' ? m[1] : m[0]
      if (rule.allow(value, repoPath, text, m.index)) continue
      const lineNo = text.slice(0, m.index).split('\n').length
      problems.push({
        file,
        line: lineNo,
        rule: rule.id,
        value,
        snippet: (lines[lineNo - 1] ?? '').trim().slice(0, 140),
        why: rule.why,
        fix: rule.fix,
        shipped: shippedSet.has(repoPath),
      })
    }
  }
}

/** PNG text/exif chunks survive cropping; a username in tEXt leaks identically. */
function scanPngMetadata(file) {
  if (extname(file).toLowerCase() !== '.png') return
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    return
  }
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    if (['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(type)) {
      const raw = buf.toString('utf8', off + 8, Math.min(off + 8 + len, buf.length))
      // EXIF under icons is only pixel dimensions; only flag readable text.
      const printable = raw.replace(/[^\x20-\x7E]/g, ' ').trim()
      if (printable.length > 0 && /[:\\/\\]|Users|@/.test(printable)) {
        problems.push({
          file,
          line: 0,
          rule: 'image-metadata',
          value: printable.slice(0, 80),
          snippet: `${type} chunk`,
          why: '图片元数据携带文本（可能含用户名或路径）',
          fix: '剥离元数据再入库：`magick in.png -strip out.png`',
          shipped: true,
        })
      } else if (!QUIET) {
        notes.push(`${file}: ${type} chunk present (no readable text)`)
      }
    }
    off += 12 + len
  }
}

function checkScreenshotRegistry() {
  const p = join(ROOT, 'screenshots.json')
  if (!existsSync(p)) return
  let list
  try {
    list = JSON.parse(readFileSync(p, 'utf8'))
  } catch (error) {
    problems.push({
      file: 'screenshots.json', line: 0, rule: 'registry',
      value: String(error), snippet: 'cannot parse', shipped: true,
      why: '截图登记表无法解析', fix: '修正 JSON',
    })
    return
  }
  if (!Array.isArray(list)) return
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    if (!existsSync(join(ROOT, entry))) {
      problems.push({
        file: 'screenshots.json', line: 0, rule: 'registry', value: entry,
        snippet: 'declared screenshot is missing', shipped: true,
        why: '登记了不存在的截图', fix: '补图或删掉这一条',
      })
    }
  }
}

function main() {
  const manifest = readManifest()
  if (!manifest) {
    console.error(`check-pii: cannot read ${join(ROOT, 'package.json')}`)
    process.exit(2)
  }

  const all = walk(ROOT)
  const shipped = publishedSet(manifest)

  for (const file of all) {
    scanText(file, shipped)
    scanPngMetadata(file)
  }
  checkScreenshotRegistry()

  const reported = problems.map(p => ({ ...p, file: rel(p.file) }))

  // Published leaks are worse than repo-only leaks: they are already on npm.
  reported.sort((a, b) => Number(b.shipped) - Number(a.shipped))

  if (!QUIET) {
    console.log(`check-pii: scanned ${all.length} files (${shipped.size} of them ship to npm)`)
  }

  if (reported.length === 0) {
    if (!QUIET) {
      console.log('check-pii: clean — no phone numbers, emails, tokens, home paths, session ids or uins found')
      for (const n of notes) console.log(`  note ${n}`)
    }
    return 0
  }

  console.error(`\ncheck-pii: ${reported.length} problem(s)\n`)
  for (const p of reported) {
    const where = p.line ? `${p.file}:${p.line}` : p.file
    console.error(`${p.shipped ? '[SHIPS TO NPM] ' : ''}${where}`)
    console.error(`  rule   ${p.rule} — ${p.why}`)
    console.error(`  value  ${p.value}`)
    if (p.snippet) console.error(`  line   ${p.snippet}`)
    console.error(`  fix    ${p.fix}`)
    console.error('')
  }
  console.error('See docs/PRIVACY.md. Published leaks also need a patch release and a CHANGELOG entry that says what leaked.')
  return 1
}

process.exit(main())
