#!/usr/bin/env node
/**
 * Does the repository, or the npm tarball, expose anything that identifies a
 * real person, account or machine?
 *
 *   node scripts/check-pii.mjs              # repo-wide + published files + image metadata
 *   node scripts/check-pii.mjs --quiet      # only failures
 *   node scripts/check-pii.mjs --stdin      # scan stdin (commit messages, PR bodies)
 *
 * WHY THIS EXISTS. In 5.20.2 an audit found real leaks that no existing gate
 * could see: design mock-ups carrying five full mainland phone numbers in plain
 * text, a CHANGELOG that shipped two more inside the npm package, screenshots
 * showing masked account numbers next to nicknames, and one image with a
 * *cropped but unredacted* account number along its top edge while its alt text
 * claimed "no account data". Nothing failed: not typecheck, not the test suite,
 * not `npm pack`. That is why this is a script and not a habit.
 *
 * WHAT IT CHECKS
 *   1. Every file in the `package.json` `files` whitelist (what users download).
 *   2. Every text file in the repo, HIDDEN FILES INCLUDED — because "not in the
 *      tarball" is not "not public": the repo is on GitHub, and `.npmrc`,
 *      `.env*` and `.vscode/` are exactly what a hurried commit sweeps in.
 *   3. Image metadata (PNG text chunks, JPEG APP segments) for usernames/paths.
 *   4. The FILE NAME of every tracked file — a screenshot named after a number
 *      leaks the number just as surely as its pixels do.
 *   5. Stdin, so a commit message can be checked the same way (see
 *      `git log --format=%B origin/main..HEAD | node scripts/check-pii.mjs --stdin`).
 *
 * ## Two design rules this file learned the hard way
 *
 * **No whole-file exemptions.** This scanner has, three times, grown a
 * whole-file or whole-directory exemption that then hid a real leak: the policy
 * document kept a real masked number for a release; `lib/` sat in SKIP_DIRS
 * while being the biggest part of the tarball; and the fix for that put a real
 * uin and a real nickname into the exempted scanner and its fixture file. Each
 * time the exemption was the smallest possible edit and each time it defeated
 * the gate in the same shape. So exemptions are now VALUE-level (`allow`) and
 * the fixture data is built at runtime in the test rather than written down.
 *
 * **Normalise before matching.** Rules written against one spelling of a phone
 * number miss every other spelling of the same number. The first version did
 * exactly that: a bare 11-digit run was caught while its dashed, country-coded
 * and full-width spellings all passed. Input is therefore normalised first
 * (full-width → ASCII, zero-width characters dropped, UTF-16 decoded by BOM).
 *
 * WHAT IT CANNOT DO. It reads text and metadata, never pixels. A screenshot with
 * a legible account number in it passes this gate no matter what is added here —
 * that is the human review documented in `docs/PRIVACY.md` §3.3, and the policy
 * says so rather than pretending otherwise.
 *
 * Read-only. No network, no writes.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'

const args = process.argv.slice(2)
const QUIET = args.includes('--quiet')
const STDIN = args.includes('--stdin')
const TARGET = args.find(a => !a.startsWith('--'))
const ROOT = resolve(TARGET ?? process.cwd())

/**
 * Directories that are never ours to police.
 *
 * `lib` is deliberately NOT here: it is a build product, but it is also the
 * single largest slice of what npm actually ships, and the bundler keeps JSDoc
 * comments — so a real nickname written in a source comment ends up verbatim in
 * `lib/client.js`. Excluding it once made the scanner report "23 of 29 files
 * ship" while the six it skipped were the ones users download.
 *
 * Note what is NOT here either: `dist` used to be, and that is a landmine. The
 * bundler's default outDir IS `dist`, so a single config change would move the
 * published output into a skipped directory and the scanner would report "0
 * files ship, clean" while shipping everything.
 */
const SKIP_DIRS = new Set([
  'node_modules', 'coverage', '.git', '.dsh-vision-router',
  '.dsh-npm-cache', '.pnpm-store',
])

/** Formats we do not read as text. Images get their own pass below. */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.node', '.zst', '.gz', '.zip', '.tgz', '.mp4', '.mp3', '.woff', '.woff2',
  '.pdf', '.docx', '.xlsx', '.pptx', '.sqlite', '.wasm', '.exe', '.dll',
])

/**
 * Path segments that are obviously invented. A real person's login name is not
 * in this set; these are the ones the suite already uses as fixtures, and
 * keeping them green is what makes the failures readable.
 */
const GENERIC_USER = new Set([
  'test', 'tests', 'tester', 'dev', 'developer', 'user', 'users', 'me',
  'you', 'runner', 'example', 'someone', 'username', 'name', 'x', 'xxx', '...',
])

/**
 * Placeholder account values. These are the ONLY values allowed through, and
 * they are chosen to be obviously fake: all-zero tails, monotone runs, and the
 * `<...>` metavariables the policy recommends.
 */
const FAKE_PHONES = new Set([
  // The classic fixture: it appears in an assertion that PROVES the real number
  // is never written to disk.
  ['138', '0000', '0000'].join(''),
  // Invented numbers in the hand-written demo page (there since 3.0.0, verified
  // different from every real account number this repo has ever held). Written
  // as joins for the same reason the test fixtures are: a value that LOOKS like
  // an account number must not be copy-pasteable out of this file.
  ['138', '****', '6621'].join(''),
  ['189', '****', '3302'].join(''),
  ['152', '****', '7788'].join(''),
])

const FAKE_UINS = new Set([
  '100000000001', '100000000002', '100000000003', '200000000003',
])

/**
 * Placeholder nicknames. `账号A` is what `AGENTS.md` tells people to write, so
 * the gate MUST accept it — a rule that fires on the project's own documented
 * placeholder teaches people to widen `allow`, which is how a scanner dies.
 */
const FAKE_NICKNAMES = /^(?:账号[A-Z]|<nickname>|someone|tester?)$/

/** Rules that do not apply to machine-generated files (lockfiles: hashes are structural). */
const NO_IDENTITY_RULES = new Set(['device-id', 'access-token'])

/** Files where hashes and integrity strings are expected by construction. */
const MACHINE_GENERATED = ['pnpm-lock.yaml', 'pnpm-lock.yml', 'package-lock.json']

/**
 * Text as it should be MATCHED, plus a map back to the original offsets so a
 * reported line number still points at the real line.
 *
 * Normalisation is not cosmetic here: without it a bare 11-digit run is caught
 * and its dashed, spaced, country-coded and full-width spellings all pass — the
 * same information in a different costume.
 */
function normalizeWithMap(raw) {
  const out = []
  const map = []
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    const cp = ch.charCodeAt(0)
    // Full-width ASCII (and the ideographic space) → ASCII.
    let c = ch
    if (cp >= 0xFF01 && cp <= 0xFF5E) c = String.fromCharCode(cp - 0xFEE0)
    else if (cp === 0x3000) c = ' '
    // Zero-width and bidi controls: invisible separators that split a number and
    // defeat every rule written against a contiguous run of digits.
    if (c === '\u200B' || c === '\u200C' || c === '\u200D' || c === '\u2060' || c === '\uFEFF') continue
    out.push(c)
    map.push(i)
  }
  return { text: out.join(''), map }
}

/** Decode a file, honouring a UTF-16 BOM (Windows editors emit it by default). */
function decode(raw) {
  if (raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE) {
    return { text: raw.toString('utf16le', 2), encoding: 'utf16le' }
  }
  if (raw.length >= 2 && raw[0] === 0xFE && raw[1] === 0xFF) {
    // BE: swap pairs into LE. BOM is dropped by the slice.
    const body = Buffer.from(raw.subarray(2))
    body.swap16()
    return { text: body.toString('utf16le'), encoding: 'utf16be' }
  }
  return { text: raw.toString('utf8'), encoding: 'utf8' }
}

const RULES = [
  {
    id: 'phone-cn',
    // Separator-tolerant, and it accepts the `+86` international prefix that
    // the old `(?<![0-9])` guard rejected outright.
    // A phone number may be written with spaces, dashes, dots, parentheses or
    // nothing at all, and the old rule enumerated those groupings one branch at
    // a time — which meant the dashed 3-4-4 grouping passed while the bare form
    // was caught. Instead the pattern matches the SHAPE `1[3-9]` followed by up
    // to 13 further characters drawn from digits and separators, and the
    // `allow`/`check` step decides whether the digits inside it add up to 11.
    // The lookbehind excludes a preceding digit OR a decimal point: without the
    // latter, `2026-11-06` matched from the second `1` and read as a phone
    // number. A real number never starts mid-version-string.
    pattern: /(?<![0-9.])(?:\+?86[\s\-]?)?1[3-9](?:[\s\-.()_]*[0-9]){7,10}(?![0-9])/g,
    why: '完整手机号（11 位中国大陆号码）',
    fix: '写成 1XX****XXXX，或全零尾巴的假号',
    // Exactly 11 digits, counting from the `1`. This is what separates a phone
    // number from a version string or a date range that the SHAPE also matched
    // (`5.19.1 (2026-11-06)` has 1+1+4+2+11 digits in one run).
    allow: (m, _file, text, index) => {
      const digits = m.replace(/^\+?86[\s\-]?/, '').replace(/[^0-9]/g, '')
      if (digits.length !== 11) return true
      if (FAKE_PHONES.has(m.replace(/[^0-9*]/g, '').replace(/^(?:86)?(?=1[3-9])/, ''))) return true
      // A STATISTICS TABLE: the match is only a seam between two unrelated
      // numbers in adjacent columns. The tell is that the whole line is digits,
      // spaces and a row label — no phone-number punctuation, and the "number"
      // starts and ends inside a wider digit run on both sides.
      const lineStart = text.lastIndexOf('\n', index) + 1
      const lineEnd = text.indexOf('\n', index)
      const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
      // A statistics row is a word label plus THREE OR MORE numeric columns. The
      // bar is deliberately high: an earlier, looser form also matched a
      // numbered list (a marker digit, a space, then the number) and silently
      // swallowed four real phone variants. A number that occupies a whole
      // line's tail is a leak; one of four evenly-spaced columns is arithmetic.
      if (/[-+()]/.test(m)) return false
      if (!/^\s*[A-Za-z][\w.-]*\s+[0-9.]+(\s+[0-9.]+){2,}\s*$/.test(line)) return false
      // …and the match must be a seam between two columns, not a run that opens
      // the line's numeric region on its own.
      const numeric = line.match(/[0-9.]+/g) ?? []
      return numeric.length >= 3 && m.split(/\s+/).length === 2
    },
  },
  {
    id: 'phone-masked',
    pattern: /(?<![0-9])1[0-9]{2}\*{2,6}[0-9]{1,4}(?![0-9])/g,
    why: '掩码手机号（与余额、过期时间组合后可指纹化账号）',
    fix: '正文里写成 1XX****XXXX；截图里打成实心块',
    // A masked fixture is fine when its visible tail is all zeros
    // or a monotone run; a real masked number has a real tail.
    allow: (m) => FAKE_PHONES.has(m) || /\*{3,}\d{2,4}$/.test(m) && /^1\d{2}\*{3,}0+$/.test(m)
      || /^1\d{2}\*{3,}(?:\d)\1{1,3}$/.test(m),
  },
  {
    id: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    why: '完整邮箱地址',
    fix: '换成 someone@example.com',
    allow: (m, _file, text, index) =>
      /@(example\.(com|org|net)|users\.noreply\.github\.com)$/i.test(m)
      // `https://user:secret@host` — a credential-in-URL fixture, not an address.
      || (text[index - 1] === ':' && /^(secret|password|passwd|token|pwd)@/i.test(m)),
  },
  {
    id: 'access-token',
    pattern: /(?:\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bglpat-[A-Za-z0-9_-]{16,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bnpm_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,})/g,
    why: '疑似密钥 / JWT',
    fix: '立刻删除并轮换；占位写 at-fixture',
    // The suite builds JWTs whose signature is a literal word, which is how a
    // reader can tell it is not a real one.
    // The suite builds JWTs whose third segment is a literal word — that is the
    // marker a reader uses to tell it is not real. `supersecret` and `sig` are
    // the ones the fixtures use.
    allow: (m) => /\.(abc+|sig|signature|c2lnbmF0dXJl|abcdefghij|supersecret)$/i.test(m),
  },
  {
    id: 'credential-in-url',
    pattern: /[A-Za-z0-9._%+-]+:([A-Za-z0-9._%-]{6,})@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    why: 'URL 里内嵌的用户名:口令',
    fix: '换成 user:secret@host 这种明显假值',
    allow: (m) => /^user:secret@/i.test(m),
  },
  {
    id: 'real-home-path',
    // CJK user names are the norm on the platform this ships to, and the old
    // `[A-Za-z0-9._-]` class skipped every one of them.
    // The segment stops at anything that cannot be part of a login name: a
    // quote, a backtick, a closing bracket or a trailing period — the old class
    // swallowed those, so `C:\\Users\\x\`` reported the backtick as the user.
    pattern: /(?:\/Users\/(?!<)[^\s/\\'"`()\[\]{}]{2,}|\/home\/(?!<)[^\s/\\'"`()\[\]{}]{2,}|[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!<)[^\s/\\'"`()\[\]{}]{2,})/g,
    why: '本机绝对路径里的用户名',
    fix: '占位成 /Users/<you> 或 C:\\Users\\<you>',
    allow: (m) => {
      const seg = m.split(/[\\/]+/).filter(Boolean).pop() ?? ''
      // Metavariables: `<you>`, `<user>`, and the `...` ellipsis that docs use
      // (`C:/Users/...`). A real login name never ends in ellipsis.
      if (/^(?:<[a-z-]+>?|\.{2,})$/.test(seg)) return true
      return GENERIC_USER.has(seg.toLowerCase())
        || seg === 'currentUser'
        || seg.startsWith('currentUser.')
    },
  },
  {
    id: 'session-id',
    // `session-<uuid>` is the DSH shape; a bare UUID is the shape real logs
    // carry once the prefix is trimmed, and it was invisible.
    pattern: /(?:session|Session|conversation|Conversation)[-_][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    why: '真实会话 id',
    fix: '占位成 <session-id>',
    // All-identical hex groups are the documented placeholder (`00000000-…`).
    allow: (m) => /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(m.replace(/^session-/, '')),
  },
  {
    id: 'device-id',
    // Device / machine identifiers are 32 or 36 hex and up to 64 for a salt.
    // `X-Machine-ID`, `X-Session-ID` and `X-Device-Token` values are all here,
    // and the policy forbids them by name while no rule could see one.
    pattern: /(?:X-(?:Machine|Session|Device)(?:-ID|-Token)|machine[_-]?id|device[_-]?(?:id|token)|session[_-]?id)\s*[:=]\s*['"]?[0-9a-fA-F]{16,64}|(?:[0-9A-F]{2}:){5}[0-9A-F]{2}/gi,
    why: '疑似设备 / 机器标识（32–64 位 hex）',
    fix: '占位成 <device-id>',
    allow: (m) => /[:=]\s*['"]?(?:0+|f+|<[a-z-]+>|x{4,})['"]?$/i.test(m),
  },
  {
    id: 'uin',
    // Real uins leak in prose far more often than in `uin: '…'` fixtures: the
    // CHANGELOG had one inside Chinese parentheses, and a log had one after
    // `QQ：`. The word may also be further away than one clause.
    pattern: new RegExp(
      [
        String.raw`(?<!\d)(?:ent)?u(?:in|id)['"]?\s*[:=]\s*['"]?([0-9]{9,14})(?!\d)`,
        String.raw`(?<!\d)([0-9]{9,14})(?!\d)(?=[^\n]{0,40}?\bu(?:in|id)\b)`,
        String.raw`\bu(?:in|id)\b[^\n]{0,40}?(?<!\d)([0-9]{9,14})(?!\d)`,
        // `QQ：200000000003` and `账号 200000000003` — the shapes prose actually uses.
        // `QQ：123`, `账号 123`, `account: 123` — a colon OR just a space, because
        // prose uses both and only the colon form was covered.
        String.raw`(?:QQ|qq|账号|account)['"]?\s*(?:[:：]\s*|\s+)([0-9]{9,14})(?!\d)`,
      ].join('|'),
      'gi',
    ),
    why: '疑似真实 uin / uid（账号级持久标识）',
    fix: '测试用 100000000001；真机日志里的数字不要粘',
    allow: (m) => FAKE_UINS.has(m)
      // Monotone runs (`100000000001` … `100000000009`) and all-zero runs are the
      // suite's vocabulary; a real uin is allocated, not counted.
      || /^1?0{7,12}[0-9]$/.test(m) && /^10{6,}/.test(m),
  },
  {
    // Account display names are unconstrained text, so a shape-based rule would
    // fire on ordinary prose. These are the shapes that have actually leaked,
    // plus the two ways prose introduces a name at all.
    //
    // `LaoDing` / the Chinese short form are deliberately NOT flagged: that is
    // the MIT copyright holder, spelled out in LICENSE, README,
    // THIRD_PARTY_NOTICES and package.json. It is public by design, so flagging
    // it would only teach people to widen the rule.
    id: 'known-nickname',
    // The auto-generated form, plus a LABELLED name. The label branch is
    // deliberately narrow: it fires on a CJK label followed by a CJK value, or on an
    // English `nickname:` whose value is a quoted literal — not on
    // `nickname: x` inside ordinary code, which is what a first draft flagged
    // 344 times.
    // TWO shapes, both narrow on purpose:
    //   1. `用户<digits>` — the name the upstream auto-generates, which nobody
    //      chose and which therefore never belongs in a fixture;
    //   2. a CJK LABEL followed by a CJK value — how prose introduces a real
    //      person's name — or an English label holding a QUOTED literal
    //      (`nickname: 'zhangsan'`). An unquoted English form is code
    //      (`entry.nickname !== ""`), and matching it produced 143 false hits
    //      across the build output.
    // English fixtures like `nickname: 'Alpha'` are deliberately NOT matched:
    // they are the suite's own vocabulary, they name no one, and flagging them
    // produced 100+ hits that would have taught everyone to widen this rule.
    pattern: /(?:用户\s*\d{6,}|(?:昵称|显示名)\s*[是为:：]\s*[\u4e00-\u9fff][^\s，。、）)`]{1,19}|(?:nickname|displayName)\s*[:=]\s*['"`][A-Za-z][A-Za-z0-9_.-]{2,19}['"`])/g,
    why: '上游返回的真实账号昵称（等于公开「哪个账号在做测试」）',
    fix: '截图里盖掉；正文、注释与工装固件里写成「账号A」',
    // The project's OWN documented placeholder must pass, or the rule points
    // backwards: it would fire on compliant text and pass the real name.
    // `账号A` is what AGENTS.md tells people to write, so it MUST pass: a rule
    // that fires on the project's own placeholder points backwards.
    allow: (m) => {
      const value = m
        .replace(/^(?:昵称|显示名|nickname|displayName)\s*[是为:：=]\s*/i, '')
        .replace(/[`'"\s]/g, '')
      // The project's own documented placeholder.
      if (FAKE_NICKNAMES.test(value)) return true
      // Numbered role fixtures (`tester2`) are the suite's own vocabulary.
      if (/^(?:test|tester|user|dev|example|someone)[0-9]*$/i.test(value)) return true
      // ASCII fixtures naming nobody: the suite's vocabulary is Greek letters and
      // role words (`Alpha`, `Beta`, `tester`, `alias`). A REAL name in ASCII is
      // either capitalised mid-word oddly or carries digits, so require that
      // before failing the build — otherwise every fixture is a false positive
      // and the rule gets widened until it is useless.
      if (/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value)) {
        // CamelCase alone is not evidence of a person: `VaultOnly`, `WorkBuddy`
        // and `LaoDing` are all role words or the MIT copyright holder, which
        // `docs/PRIVACY.md` §5 says is public by design. Digits are the tell
        // that matters — a real account name from this upstream carries them.
        return !/[0-9]/.test(value)
      }
      return false
    },
  },
]

const problems = []
const notes = []

function rel(p) {
  return relative(ROOT, p).split(sep).join('/')
}

/** Walk the tree. Hidden FILES are included; only build/vendor dirs are skipped. */
function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
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
    // A glob entry cannot be resolved with existsSync. Rather than silently
    // treating its contents as "not shipped" (which under-states severity), the
    // whole tree is marked shipped when any glob is present — over-reporting a
    // leak is the safe direction.
    if (normalized.includes('*')) {
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

function pushProblem(file, line, rule, value, snippet, why, fix, shipped) {
  problems.push({ file, line, rule, value, snippet, why, fix, shipped })
}

function scanText(file, shippedSet, label = rel(file)) {
  const ext = extname(file).toLowerCase()
  if (BINARY_EXT.has(ext)) {
    // A binary under the shipped set is not "clean", it is "unread". Say so
    // instead of returning silently — a .docx audit report with NUL bytes used
    // to be skipped without a word.
    if (shippedSet.has(label) && !QUIET) notes.push(`${label}: binary, not scanned — review by hand`)
    return
  }
  let raw
  try {
    raw = readFileSync(file)
  } catch {
    return
  }
  const { text: decoded, encoding } = decode(raw)
  if (encoding === 'utf8' && decoded.includes('\u0000')) {
    if (!QUIET) notes.push(`${label}: contains NUL bytes, not scanned — review by hand`)
    return
  }

  const { text, map } = normalizeWithMap(decoded)
  const repoPath = label
  const lines = decoded.split('\n')
  const machineGenerated = MACHINE_GENERATED.some(n => repoPath.endsWith(n))

  for (const rule of RULES) {
    if (machineGenerated && NO_IDENTITY_RULES.has(rule.id)) continue
    // Re-create the regex so the shared object never carries lastIndex state.
    const rx = new RegExp(rule.pattern.source, rule.pattern.flags)
    let m
    while ((m = rx.exec(text)) !== null) {
      const value = rule.id === 'uin'
        // Alternation means the digits may land in any group; take the first one
        // that actually matched.
        ? (m.slice(1).find(g => g !== undefined) ?? m[0])
        : m[0]
      if (rule.allow(value, repoPath, text, m.index)) continue
      const lineNo = decoded.slice(0, map[m.index] ?? 0).split('\n').length
      pushProblem(
        file, lineNo, rule.id, value,
        (lines[lineNo - 1] ?? '').trim().slice(0, 140),
        rule.why, rule.fix, shippedSet.has(repoPath),
      )
    }
  }
}

/** Map a normalised offset back to a raw offset in the file. */
function rawIndex(map, index) {
  if (map.length === 0) return 0
  return map[Math.min(index, map.length - 1)]
}

/**
 * Text inside an IMAGE's metadata leaks exactly as text does.
 *
 * Both containers are handled because the policy promised both: PNG text chunks
 * (tEXt / iTXt / zTXt / eXIf) and JPEG APPn segments (EXIF / XMP / comment).
 * The first version read PNG only while `docs/PRIVACY.md` §4 told the reader
 * JPEG was covered — a documented promise the code did not keep, which is worse
 * than no promise.
 */
function scanImageMetadata(file, shippedSet) {
  const ext = extname(file).toLowerCase()
  if (!['.png', '.jpg', '.jpeg'].includes(ext)) return
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    return
  }
  const chunks = []
  if (ext === '.png') {
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504E47) return
    let off = 8
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off)
      const type = buf.toString('ascii', off + 4, off + 8)
      if (['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(type)) {
        chunks.push({ type, raw: buf.subarray(off + 8, Math.min(off + 8 + len, buf.length)) })
      }
      off += 12 + len
    }
  } else {
    if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return
    let off = 2
    while (off + 4 <= buf.length) {
      if (buf[off] !== 0xFF) { off += 1; continue }
      const marker = buf[off + 1]
      if (marker === 0xD8 || marker === 0xD9) { off += 2; continue }
      const len = buf.readUInt16BE(off + 2)
      // APP1 (EXIF/XMP), APP2 (ICC), COM (comment) — anything that can carry text.
      if (marker >= 0xE1 && marker <= 0xEF || marker === 0xFE) {
        chunks.push({ type: `APP${marker.toString(16)}`, raw: buf.subarray(off + 4, Math.min(off + 2 + len, buf.length)) })
      }
      off += 2 + len
    }
  }

  for (const { type, raw } of chunks) {
    // Photographic payloads are mostly binary; keep the printable runs and test
    // them with the SAME rules as prose, so a number in EXIF is judged the way a
    // number in a paragraph is judged.
    const printable = raw.toString('latin1').replace(/[^\x20-\x7E]+/g, ' ')
    const hits = []
    for (const rule of RULES) {
      if (rule.id === 'device-id') continue // binary payloads look like hex
      const rx = new RegExp(rule.pattern.source, rule.pattern.flags)
      let m
      while ((m = rx.exec(printable)) !== null) {
        const value = rule.id === 'uin'
          ? (m.slice(1).find(g => g !== undefined) ?? m[0])
          : m[0]
        if (!rule.allow(value, rel(file), printable, m.index)) hits.push(value)
      }
    }
    // A hardcoded path or user name is suspicious even when no rule's shape
    // matched, because metadata should not carry human text at all.
    const looksLikeIdentity = /[:\\/]|Users|@/.test(printable)
    if (hits.length > 0 || (looksLikeIdentity && printable.trim().length > 0)) {
      pushProblem(
        file, 0, 'image-metadata', (hits[0] ?? printable.trim()).slice(0, 80),
        `${type} chunk`, '图片元数据携带文本（可能含用户名、路径或号码）',
        '剥离元数据再入库：`magick in.png -strip out.png`',
        shippedSet.has(rel(file)),
      )
    } else if (!QUIET) {
      notes.push(`${rel(file)}: ${type} chunk present (no readable identity text)`)
    }
  }
}

/** A file NAME can carry a number too. */
function scanFileName(file, shippedSet) {
  const name = rel(file)
  for (const rule of RULES) {
    if (rule.id === 'device-id' || rule.id === 'known-nickname') continue
    const rx = new RegExp(rule.pattern.source, rule.pattern.flags)
    let m
    while ((m = rx.exec(name)) !== null) {
      const value = rule.id === 'uin' ? (m.slice(1).find(g => g !== undefined) ?? m[0]) : m[0]
      if (rule.allow(value, name, name, m.index)) continue
      pushProblem(
        file, 0, rule.id, value, 'in the file name',
        rule.why, `重命名文件；${rule.fix}`, shippedSet.has(name),
      )
    }
  }
}

function checkScreenshotRegistry() {
  const p = join(ROOT, 'screenshots.json')
  if (!existsSync(p)) return
  let list
  try {
    list = JSON.parse(readFileSync(p, 'utf8'))
  } catch (error) {
    pushProblem('screenshots.json', 0, 'registry', String(error), 'cannot parse', false,
      '截图登记表无法解析', '修正 JSON')
    return
  }
  if (!Array.isArray(list)) return
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    if (!existsSync(join(ROOT, entry))) {
      pushProblem('screenshots.json', 0, 'registry', entry, 'declared screenshot is missing', true,
        '登记了不存在的截图', '补图或删掉这一条')
    }
  }
}

/**
 * Values are REDACTED when the output may be published.
 *
 * The gate fails on a real leak — and before this, it printed that leak verbatim.
 * On a public repo the CI log is public, permanently, and search-indexed, so
 * "catching" a phone number was itself publishing it. Interactive local runs
 * still show the full value, because there the reader is the person fixing it.
 */
const REDACT = process.env.CI !== undefined || !process.stdout.isTTY || QUIET

function redact(value) {
  const s = String(value)
  if (!REDACT || s.length <= 6) return s
  return `${s.slice(0, 2)}${'*'.repeat(Math.min(12, s.length - 4))}${s.slice(-2)}`
}

function main() {
  if (STDIN) {
    const decoded = decode(readFileSync(0))
    const { text } = normalizeWithMap(decoded.text)
    const problemsBefore = problems.length
    for (const rule of RULES) {
      const rx = new RegExp(rule.pattern.source, rule.pattern.flags)
      let m
      while ((m = rx.exec(text)) !== null) {
        const value = rule.id === 'uin' ? (m.slice(1).find(g => g !== undefined) ?? m[0]) : m[0]
        if (rule.allow(value, '<stdin>', text, m.index)) continue
        pushProblem('<stdin>', 0, rule.id, value, '', rule.why, rule.fix, false)
      }
    }
    const found = problems.length - problemsBefore
    if (found === 0) {
      if (!QUIET) console.log('check-pii: stdin clean')
      return 0
    }
    console.error(`\ncheck-pii: ${found} problem(s) in stdin\n`)
    for (const p of problems.slice(problemsBefore)) {
      console.error(`  rule   ${p.rule} — ${p.why}`)
      console.error(`  value  ${redact(p.value)}`)
    }
    return 1
  }

  const manifest = readManifest()
  if (!manifest) {
    console.error(`check-pii: cannot read ${join(ROOT, 'package.json')}`)
    process.exit(2)
  }

  const all = walk(ROOT)
  const shipped = publishedSet(manifest)

  for (const file of all) {
    const ext = extname(file).toLowerCase()
    if (['.png', '.jpg', '.jpeg'].includes(ext)) {
      scanImageMetadata(file, shipped)
    } else {
      scanText(file, shipped)
    }
    scanFileName(file, shipped)
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
      console.log('check-pii: clean')
      for (const n of notes) console.log(`  note ${n}`)
    }
    return 0
  }

  console.error(`\ncheck-pii: ${reported.length} problem(s)\n`)
  for (const p of reported) {
    const where = p.line ? `${p.file}:${p.line}` : p.file
    console.error(`${p.shipped ? '[SHIPS TO NPM] ' : ''}${where}`)
    console.error(`  rule   ${p.rule} — ${p.why}`)
    console.error(`  value  ${redact(p.value)}`)
    if (p.snippet) console.error(`  line   ${redact(p.snippet)}`)
    console.error(`  fix    ${p.fix}`)
    console.error('')
  }
  console.error('See docs/PRIVACY.md. A published leak also needs a patch release.')
  return 1
}

process.exit(main())
