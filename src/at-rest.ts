/**
 * WorkBuddy desktop "at-rest" credential decryption.
 *
 * From 5.6.0 the WorkBuddy desktop app no longer stores `auth.accessToken` /
 * `auth.refreshToken` as plain strings. It writes a field wrapper:
 *
 *   { "$wbEncrypted": 1, "envelope": "<base64 of a JSON envelope>" }
 *
 * where the envelope is `{suite, keyId, nonce, authTag, ciphertext}` for
 * AES-256-GCM with a 12-byte nonce and a 16-byte tag. The authenticated
 * additional data is a length-prefixed transcript over the scheme, suite,
 * keyId and framing, so the ciphertext can only be opened for the exact field
 * shape it was sealed for.
 *
 * The field key itself is NOT a user secret: it is a build-time constant
 * compiled into the app's own Electron native module
 * (`electron_browser_workbuddy_storage`). The app fetches it through
 * `loggerGet()` and hashes the returned base64 STRING (not the decoded bytes)
 * to obtain the 32-byte key; `keyId` is the first 16 hex characters of that
 * key's SHA-256.
 *
 * This module re-derives the same key by asking the installed app for the same
 * payload, and caches it in memory for the process lifetime. Nothing is ever
 * written to disk, and the payload is never logged.
 *
 * 改动：**「macOS 也加密」这一事实**（issue #15 真机取证）。本模块原先假设该
 *   policy 是 Windows 先行、macOS 只是「将来可能」，于是 macOS 的可执行文件
 *   路径用 App 名拼成 `<bundle>/Contents/MacOS/WorkBuddy`——而两个真实 bundle
 *   的 `CFBundleExecutable` 都是 `Electron`，该路径并不存在。结果是 macOS 上
 *   加密凭据**永远**取不到密钥，用户却被报成「未登录」。现在二进制名向 bundle
 *   自己问（`macosBundleExecutable()`），候选含国际版 `WorkBuddy AI.app`，
 *   并允许 App 被归入 applications 目录的子目录——扫到的候选必须先用
 *   `CFBundleIdentifier` 确认身份才 `execFile`，因为**每个 Electron 应用的
 *   二进制都叫 `Electron`**，只按名字匹配就可能启动另一个产品。
 *
 * @module dsh-connect-workbuddy/at-rest
 */

import { execFile, execFileSync } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** A `{$wbEncrypted:1,envelope}` field wrapper, the only shape this module opens. */
export interface WorkBuddyEncryptedField {
  $wbEncrypted: 1
  envelope: string
}

/** Envelope framing names, mapped to the single-byte AAD framing code. */
const FRAMING_CODE: Readonly<Record<string, number>> = {
  file: 1,
  field: 2,
  record: 3,
  stream: 4,
}

/** Standard (symmetric) format identifiers, transcripted into the AAD. */
const STANDARD_FORMAT_ID: Readonly<Record<string, string>> = {
  file: 'WBEF1',
  field: 'WBEV1',
  record: 'WBER1',
  stream: 'WBES1',
}

/** Domain separator the AAD transcript starts with. */
const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii')

/** Scheme name of the symmetric envelope this module opens. */
const SYMMETRIC_SCHEME = 'sym-v1'

/** Env override pointing at the WorkBuddy desktop executable. */
export const WORKBUDDY_APP_EXECUTABLE_ENV = 'WORKBUDDY_APP_EXECUTABLE'

/** How long the app is given to answer with its key payload. */
const KEY_FETCH_TIMEOUT_MS = 10_000

/** File name of the WorkBuddy desktop executable on Windows. */
const APP_EXECUTABLE_NAME = 'WorkBuddy.exe'

/**
 * macOS bundles the desktop app may be installed as, in probe order.
 *
 * `WorkBuddy.app` is the domestic build; `WorkBuddy AI.app` is the
 * international one, and a machine may carry either or both. The user-level
 * `~/Applications` location is included because macOS lets an app live there,
 * and installs have been observed under a subdirectory of /Applications too —
 * hence {@link findWorkbuddyAppExecutable}'s parent scan, which covers those
 * without guessing any particular folder name.
 */
const MACOS_APP_BUNDLE_NAMES: readonly string[] = ['WorkBuddy.app', 'WorkBuddy AI.app']

function encodeUint32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}

/** Length-prefixed UTF-8 string: uint32 big-endian length followed by the bytes. */
function encodeLengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([encodeUint32(bytes.length), bytes])
}

/**
 * The authenticated additional data for one `sym-v1` FIELD-framed envelope.
 *
 * Only the field framing is implemented: it is the shape the desktop app uses
 * for credential fields, and it is also the shape that cannot be confused with
 * a whole-file envelope, so an unexpected framing is a parse error rather than
 * a silently wrong transcript.
 */
function fieldAad(keyId: string, suite: number, scheme: string = SYMMETRIC_SCHEME): Buffer {
  if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error(`workbuddy: envelope keyId is malformed`)
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(STANDARD_FORMAT_ID['field']!),
    encodeLengthPrefixed(scheme),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FRAMING_CODE['field']!]),
    // encodeOptionalUint64(undefined): field framing carries no sequence.
    Buffer.from([0]),
    // final === undefined
    Buffer.from([0]),
  ])
}

/** Whether a value is the app's encrypted-field wrapper. */
export function isEncryptedFieldWrapper(value: unknown): value is WorkBuddyEncryptedField {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const wrapper = value as Record<string, unknown>
  const keys = Object.keys(wrapper).sort()
  return keys.length === 2
    && keys[0] === '$wbEncrypted'
    && keys[1] === 'envelope'
    && wrapper['$wbEncrypted'] === 1
    && typeof wrapper['envelope'] === 'string'
}

/**
 * The at-rest key id for a derived 32-byte key: the first 16 hex characters of
 * its SHA-256. This is what the envelope's `keyId` is checked against, so a
 * mismatched key fails loudly instead of returning garbage.
 */
export function deriveAtRestKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/**
 * Derive the 32-byte field key from the app's key payload JSON.
 *
 * The app hashes the payload's base64 STRING — not its decoded bytes — so the
 * same spelling is required here; hashing the decoded secret would produce a
 * different key and every field would fail to open.
 */
export function deriveAtRestKey(payloadJson: string): Buffer {
  let payload: unknown
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    throw new Error('workbuddy: at-rest key payload is not valid JSON')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('workbuddy: at-rest key payload is not an object')
  }
  const secret = (payload as Record<string, unknown>)['atRestSecretKey']
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('workbuddy: at-rest key payload carries no atRestSecretKey')
  }
  return createHash('sha256').update(secret, 'utf8').digest()
}

/**
 * Open one encrypted field with a derived key and return its plaintext.
 *
 * Throws when the envelope is malformed, belongs to another key, or fails
 * authentication — a GCM tag mismatch is the signal that the transcript or the
 * key is wrong, and it must never degrade into a truncated token.
 */
export function openEncryptedField(field: WorkBuddyEncryptedField, key: Buffer): string {
  let envelope: unknown
  try {
    envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'))
  } catch {
    throw new Error('workbuddy: encrypted field envelope is not valid JSON')
  }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new Error('workbuddy: encrypted field envelope is not an object')
  }
  const record = envelope as Record<string, unknown>
  const suite = record['suite']
  const keyId = record['keyId']
  const nonce = record['nonce']
  const authTag = record['authTag']
  const ciphertext = record['ciphertext']
  if (typeof suite !== 'number' || typeof keyId !== 'string') {
    throw new Error('workbuddy: encrypted field envelope is missing suite or keyId')
  }
  if (typeof nonce !== 'string' || typeof authTag !== 'string' || typeof ciphertext !== 'string') {
    throw new Error('workbuddy: encrypted field envelope is missing nonce, authTag or ciphertext')
  }
  const expectedKeyId = deriveAtRestKeyId(key)
  if (keyId !== expectedKeyId) {
    throw new Error(`workbuddy: encrypted field belongs to key ${keyId}, not the available key ${expectedKeyId}`)
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), { authTagLength: 16 })
  decipher.setAAD(fieldAad(keyId, suite))
  decipher.setAuthTag(Buffer.from(authTag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * The executable inside a macOS app bundle, read from the bundle's own
 * `Info.plist`.
 *
 * The binary is NOT reliably named after the app: the WorkBuddy bundles ship
 * with `CFBundleExecutable` set to `Electron`, so a path assembled as
 * `<bundle>/Contents/MacOS/WorkBuddy` does not exist and the app looks absent
 * even when it is installed in the default location. Because the bundle
 * documents the real name, asking it is both correct and robust to a future
 * build that renames the binary.
 *
 * Returns undefined when the plist is absent, unreadable, or carries no usable
 * name — never a guessed path, so a caller can keep probing.
 */
export function macosBundleExecutable(bundle: string): string | undefined {
  let plist: string
  try {
    plist = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8')
  } catch {
    return undefined
  }
  // The plist is XML for every bundle observed; match the key's following
  // <string> without pulling in a plist parser. A name is rejected when it is
  // empty or would escape Contents/MacOS ('.', '..', or a path separator).
  const match = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist)
  const name = match?.[1]?.trim()
  if (name === undefined || name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    return undefined
  }
  return join(bundle, 'Contents', 'MacOS', name)
}

/**
 * The executable path WorkBuddy's own uninstall registration points at, or
 * undefined when the app was never registered.
 *
 * Why this exists: the four directory candidates in
 * {@link workbuddyAppExecutableCandidates} encode the DEFAULT install layout.
 * An app installed anywhere else — a second drive (the observed case was
 * `E:\workbuddy\WorkBuddy.exe`) — is installed and signed in, yet every
 * candidate misses, so the encrypted credential file cannot be opened and a
 * user who IS signed in is reported as signed out. The README's answer was to
 * set `WORKBUDDY_APP_EXECUTABLE` by hand; the installer already recorded the
 * answer, so this reads it instead.
 *
 * The registration is the app's own claim about itself, which is what makes it
 * safe to hand the path to the credential probe: a display name alone would be
 * a guess, whereas the path here was written by the installer that placed the
 * binary. The value is still checked against {@link APP_EXECUTABLE_NAME} and for
 * existence before use, and the callers fall through to the documented hint when
 * it is absent.
 *
 * The read is done through ALL THREE uninstall views, because the hive a
 * registration lands in depends on how the app was installed: per-user
 * (`/currentuser`, the layout WorkBuddy uses) registers under `HKCU`, a
 * machine-wide install under `HKLM`, and a 32-bit machine-wide one under
 * `HKLM\...\WOW6432Node`. A hive that does not exist or is unreadable is the
 * normal case on a machine without the app, not an error: every failure path
 * returns undefined so the caller can try the next candidate.
 */
export function windowsRegistryAppExecutable(
  query: (args: readonly string[]) => string | undefined = queryRegistry,
): string | undefined {
  // `DisplayIcon` is tried first because it names the binary directly;
  // `InstallLocation` is the fallback for a registration that omits the icon
  // (the icon value is optional, whereas the install directory is what the
  // uninstaller is anchored to, so it is the more reliable of the two).
  const keys = [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  for (const root of keys) {
    const listing = query(['query', root, '/s', '/f', 'WorkBuddy', '/t', 'REG_SZ'])
    if (listing === undefined) continue
    const executable = registryExecutableFromQuery(listing)
    if (executable !== undefined) return executable
    const fromDirectory = registryInstallLocationFromQuery(listing)
    if (fromDirectory !== undefined) return fromDirectory
  }
  return undefined
}

/**
 * Parse `reg query` output for the value that names the installed executable.
 *
 * `reg query` prints keys as `HKEY_CURRENT_USER\...\Uninstall\<id>` followed by
 * indented `    ValueName    REG_SZ    Data` lines. Only `DisplayIcon` is
 * trusted here: it is the one value the installer writes pointing AT the
 * binary. The value is normalised by {@link normalizeRegistryExecutable}, which
 * strips the quotes and the icon index and rejects anything that is not the
 * desktop executable.
 */
export function registryExecutableFromQuery(output: string): string | undefined {
  for (const rawLine of output.split(/\r?\n/u)) {
    const match = /^\s*DisplayIcon\s+REG_SZ\s+(.*?)\s*$/u.exec(rawLine)
    if (match === null) continue
    const executable = normalizeRegistryExecutable(match[1]!)
    if (executable !== undefined) return executable
  }
  return undefined
}

/**
 * The `WorkBuddy.exe` under an `InstallLocation`-style registry directory.
 *
 * Kept separate from {@link registryExecutableFromQuery} because the two values
 * mean different things: `DisplayIcon` NAMES a file, whereas the directory has
 * to have {@link APP_EXECUTABLE_NAME} joined onto it, and the result must still
 * be checked for existence by the caller's probe.
 */
export function registryInstallLocationFromQuery(output: string): string | undefined {
  for (const rawLine of output.split(/\r?\n/u)) {
    const match = /^\s*InstallLocation\s+REG_SZ\s+(.*?)\s*$/u.exec(rawLine)
    if (match === null) continue
    const directory = stripRegistryQuotes(match[1]!)
    if (directory === undefined || directory === '') continue
    return join(directory, APP_EXECUTABLE_NAME)
  }
  return undefined
}

/**
 * A registry executable value reduced to a usable path, or undefined when it
 * cannot be one.
 *
 * `DisplayIcon` is stored as `"E:\workbuddy\WorkBuddy.exe",0`. The quotes and
 * the icon index are stripped, and a value that names something other than the
 * desktop executable — an `.ico`, an uninstaller, another product's binary — is
 * rejected rather than launched. A bare path without quotes is accepted too,
 * because not every installer writes the indexed form.
 */
export function normalizeRegistryExecutable(value: string): string | undefined {
  const unquoted = stripRegistryQuotes(value)
  if (unquoted === undefined || unquoted === '') return undefined
  // Drop a trailing `,<index>` (the icon index) without touching commas that
  // belong to the path itself.
  const withoutIndex = unquoted.replace(/,\s*-?\d+\s*$/u, '')
  if (withoutIndex === '') return undefined
  if (basename(withoutIndex).toLowerCase() !== APP_EXECUTABLE_NAME.toLowerCase()) return undefined
  return withoutIndex
}

/**
 * The path inside a `DisplayIcon`/`InstallLocation` value, unquoted.
 *
 * Registry data may be written either quoted (`"E:\workbuddy\WorkBuddy.exe",0`)
 * or bare. Only a leading quote is treated as quoting: a bare `C:\dir\a"b.exe`
 * is a real (if unusual) filename and must not be truncated at the quote.
 */
export function stripRegistryQuotes(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (!trimmed.startsWith('"')) return trimmed
  const closing = trimmed.indexOf('"', 1)
  // An unterminated quote is malformed; refuse it rather than guessing where
  // the path ends.
  if (closing === -1) return undefined
  return trimmed.slice(1, closing).trim()
}

/**
 * Run `reg query` and return its stdout, or undefined when it cannot be run.
 *
 * `windowsHide` is REQUIRED, not cosmetic: the DSH Desktop host is an Electron
 * GUI process with no console, so spawning a console program without it flashes
 * a visible black window on every probe. The same reason is recorded for the
 * heartbeat probe in `host-heartbeat.ts` and in `docs/WINDOWS.md` §1-3.
 *
 * `execFileSync` (not `execFile`) keeps this synchronous so the candidates list
 * stays a pure function of its inputs: it is called during `findWorkbuddyApp`
 * `Executable`, which `readAtRestKey()` and the `doctor` command both treat as
 * a plain lookup. The read is bounded by the registry query's own output and
 * happens at most once per discovery.
 */
function queryRegistry(args: readonly string[]): string | undefined {
  try {
    return execFileSync('reg', [...args], REGISTRY_PROBE_OPTIONS)
  } catch {
    // `reg` exits non-zero when the key or value is absent — the expected case
    // on a machine without a registered WorkBuddy.
    return undefined
  }
}

/**
 * Options for the registry probe; `windowsHide` is mandatory (see above), and
 * the timeout matches `fetchAtRestKeyPayload()`'s: a hung `reg` must not wedge
 * the synchronous discovery path forever.
 */
const REGISTRY_PROBE_OPTIONS = { encoding: 'utf8', windowsHide: true, timeout: 10_000 } as const

/**
 * Candidate paths of the WorkBuddy desktop executable, in probe order.
 *
 * The Windows build is the one that encrypts credentials, so Windows leads;
 * the macOS bundles are listed because the same native module ships there and
 * the encryption policy is enabled on macOS builds too (observed from 5.6.x),
 * and `undefined` entries (an unset env variable) are dropped.
 *
 * On macOS the executable name comes from each bundle (see
 * {@link macosBundleExecutable}) rather than being assembled from the app name.
 *
 * `readBundleExecutable` is injectable, in the same spirit as `platform`/`home`/
 * `env`: the macOS branch consults the real filesystem, so without a seam the
 * expected candidates would depend on whether the host machine happens to have
 * the app installed — and the test would pass on a developer's Mac while
 * failing in CI.
 */
export function workbuddyAppExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  readBundleExecutable: (bundle: string) => string | undefined = macosBundleExecutable,
): string[] {
  const candidates: (string | undefined)[] = [env[WORKBUDDY_APP_EXECUTABLE_ENV]?.trim()]
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA']?.trim()
    const programFiles = env['ProgramFiles']?.trim()
    const programFilesX86 = env['ProgramFiles(x86)']?.trim()
    candidates.push(
      local === undefined || local === '' ? undefined : join(local, 'Programs', 'WorkBuddy', APP_EXECUTABLE_NAME),
      local === undefined || local === '' ? undefined : join(local, 'WorkBuddy', APP_EXECUTABLE_NAME),
      programFiles === undefined || programFiles === '' ? undefined : join(programFiles, 'WorkBuddy', APP_EXECUTABLE_NAME),
      programFilesX86 === undefined || programFilesX86 === '' ? undefined : join(programFilesX86, 'WorkBuddy', APP_EXECUTABLE_NAME),
    )
  } else if (platform === 'darwin') {
    for (const name of MACOS_APP_BUNDLE_NAMES) {
      candidates.push(
        readBundleExecutable(join('/Applications', name)),
        readBundleExecutable(join(home, 'Applications', name)),
      )
    }
  }
  return candidates.filter((candidate): candidate is string => candidate !== undefined && candidate !== '')
}

/**
 * Bundle identifier PREFIXES the desktop app is signed with — `com.tencent.
 * workbuddy` (domestic, observed as `…workbuddy.mac`) and `com.workbuddy`
 * (international, observed as `com.workbuddy.workbuddy-ai`).
 *
 * Used to CONFIRM that a discovered bundle really is WorkBuddy before it is
 * launched. This matters because the discovery below scans directories and then
 * execs what it finds: every Electron app is built around a binary called
 * `Electron`, so a name-only match could pick a different product's bundle and
 * run it. The identifier is the app's own claim about itself, so it is the
 * check that makes the scan safe.
 */
const APP_BUNDLE_IDENTIFIER_PREFIXES: readonly string[] = ['com.tencent.workbuddy', 'com.workbuddy']

/**
 * Whether a bundle identifies itself as the WorkBuddy desktop app.
 *
 * The match is on dot boundaries, so a hypothetical `com.workbuddyish` cannot
 * pass as `com.workbuddy`.
 *
 * An unreadable or identifier-less plist is treated as NOT WorkBuddy: refusing
 * a candidate only costs a fallback to another path, whereas accepting the
 * wrong one would execute an unrelated application.
 */
export function isWorkbuddyBundle(bundle: string): boolean {
  let plist: string
  try {
    plist = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8')
  } catch {
    return false
  }
  const match = /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist)
  const identifier = match?.[1]?.trim().toLowerCase()
  if (identifier === undefined || identifier === '') return false
  return APP_BUNDLE_IDENTIFIER_PREFIXES.some(prefix =>
    identifier === prefix || identifier.startsWith(`${prefix}.`))
}

/**
 * Bundles of the desktop app found one level BELOW a macOS applications
 * directory.
 *
 * Users do file apps into subfolders (`/Applications/IDE/WorkBuddy.app`), and
 * a hardcoded `/Applications/<name>` then reports the app as missing while it
 * is installed and signed in. The scan is deliberately ONE level deep and
 * matches the known bundle names only, so it stays predictable and cheap; each
 * candidate is then confirmed by {@link isWorkbuddyBundle} before use.
 *
 * Returns [] when the parent is absent or unreadable — a missing directory is
 * the normal case, not an error.
 */
export function macosNestedAppBundles(parent: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return []
  }
  const bundles: string[] = []
  for (const entry of entries) {
    const nested = join(parent, entry)
    for (const name of MACOS_APP_BUNDLE_NAMES) {
      const bundle = join(nested, name)
      try {
        if (!statSync(bundle).isDirectory()) continue
      } catch {
        continue
      }
      if (isWorkbuddyBundle(bundle)) bundles.push(bundle)
    }
  }
  return bundles
}

/**
 * The first candidate that exists as a file, or undefined when the desktop app
 * is not installed where this platform expects it.
 */
export function findWorkbuddyAppExecutable(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  readRegistryAppPath: () => string | undefined = windowsRegistryAppExecutable,
): string | undefined {
  for (const candidate of workbuddyAppExecutableCandidates(platform, home, env)) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Unreadable candidate: try the next one.
    }
  }
  // Windows fallback: an app installed OUTSIDE the four default layout paths,
  // which the exact-path candidates above cannot see. This runs only after
  // every cheap candidate missed, so a default install never pays for the
  // registry query. The installer recorded where it put the binary, so asking
  // the registration is what lets a signed-in account stop being reported as
  // signed out, with no `WORKBUDDY_APP_EXECUTABLE` set by hand.
  //
  // `readRegistryAppPath` is injectable, in the same spirit as `platform`/
  // `home`/`env`: the real reader consults the machine's own registration, so
  // without a seam the "nothing exists" expectation below would depend on
  // whether the host running the suite happens to have WorkBuddy installed.
  if (platform === 'win32') {
    const fromRegistry = readRegistryAppPath()
    if (fromRegistry !== undefined) {
      try {
        if (existsSync(fromRegistry)) return fromRegistry
      } catch {
        // Unreadable: fall through to undefined.
      }
    }
  }
  // macOS fallback: an app filed into a subfolder of an applications
  // directory, which the exact-path candidates above cannot see.
  if (platform === 'darwin') {
    for (const parent of ['/Applications', join(home, 'Applications')]) {
      for (const bundle of macosNestedAppBundles(parent)) {
        const executable = macosBundleExecutable(bundle)
        if (executable === undefined) continue
        try {
          if (existsSync(executable)) return executable
        } catch {
          // Unreadable: try the next bundle.
        }
      }
    }
  }
  return undefined
}

/**
 * Ask the installed desktop app for its key payload by running its own binary
 * as plain Node (`ELECTRON_RUN_AS_NODE`) and calling the native binding.
 *
 * The binding is the app's own public surface for this value, so the plugin
 * never has to carry a copy of a build-specific constant: it asks the very
 * build that wrote the file. The child is given no stdin and a hard timeout,
 * and its stdout is the only thing read.
 */
export function fetchAtRestKeyPayload(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const source = "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}"
      + "catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}"
    execFile(
      executable,
      ['-e', source],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: KEY_FETCH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`workbuddy: the desktop app did not provide its at-rest key (${stderr.trim() || error.message})`))
          return
        }
        const payload = stdout.trim()
        if (payload === '') {
          reject(new Error('workbuddy: the desktop app returned an empty at-rest key payload'))
          return
        }
        resolve(payload)
      },
    )
  })
}

/** Process-lifetime cache of the derived key; never persisted. */
let cachedKey: Buffer | undefined
let inflightKey: Promise<Buffer | undefined> | undefined

/**
 * The desktop app's at-rest field key, or undefined when it cannot be obtained
 * (app not installed, an older build without the native module, or a future
 * build that rotates the payload). Cached after the first success so the app is
 * spawned at most once per process; a failure is retried on the next call,
 * because the user may install or start the app between reads.
 */
export function readAtRestKey(): Promise<Buffer | undefined> {
  if (cachedKey !== undefined) return Promise.resolve(cachedKey)
  inflightKey ??= (async () => {
    const executable = findWorkbuddyAppExecutable()
    if (executable === undefined) return undefined
    const payload = await fetchAtRestKeyPayload(executable)
    const key = deriveAtRestKey(payload)
    cachedKey = key
    return key
  })().finally(() => {
    inflightKey = undefined
  })
  return inflightKey
}

/** Drop the cached key; tests and diagnostics only. */
export function clearAtRestKeyCache(): void {
  cachedKey = undefined
  inflightKey = undefined
}
