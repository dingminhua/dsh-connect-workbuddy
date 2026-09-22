/**
 * WorkBuddy desktop "at-rest" credential decryption.
 *
 * The WorkBuddy desktop app (2.x, Windows builds first) no longer stores
 * `auth.accessToken` / `auth.refreshToken` as plain strings. It now writes a
 * field wrapper:
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
 * @module dsh-connect-workbuddy/at-rest
 */

import { execFile } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

/** File name of the WorkBuddy desktop executable, per platform. */
const APP_EXECUTABLE_NAME = 'WorkBuddy.exe'

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
 * Candidate paths of the WorkBuddy desktop executable, in probe order.
 *
 * The Windows build is the one that encrypts credentials, so Windows leads;
 * the macOS bundle is listed because the same native module ships there and a
 * future build may enable the policy, and `undefined` entries (an unset env
 * variable) are dropped.
 */
export function workbuddyAppExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates: (string | undefined)[] = [env[WORKBUDDY_APP_EXECUTABLE_ENV]?.trim()]
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA']?.trim()
    const programFiles = env['ProgramFiles']?.trim()
    const programFilesX86 = env['ProgramFiles(x86)']?.trim()
    candidates.push(
      local === undefined || local === '' ? undefined : join(local, 'Programs', 'WorkBuddy', APP_EXECUTABLE_NAME),
      programFiles === undefined || programFiles === '' ? undefined : join(programFiles, 'WorkBuddy', APP_EXECUTABLE_NAME),
      programFilesX86 === undefined || programFilesX86 === '' ? undefined : join(programFilesX86, 'WorkBuddy', APP_EXECUTABLE_NAME),
    )
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy',
      join(home, 'Applications', 'WorkBuddy.app', 'Contents', 'MacOS', 'WorkBuddy'),
    )
  }
  return candidates.filter((candidate): candidate is string => candidate !== undefined && candidate !== '')
}

/**
 * The first candidate that exists as a file, or undefined when the desktop app
 * is not installed where this platform expects it.
 */
export function findWorkbuddyAppExecutable(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const candidate of workbuddyAppExecutableCandidates(platform, home, env)) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Unreadable candidate: try the next one.
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
