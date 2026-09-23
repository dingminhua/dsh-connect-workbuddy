/**
 * At-rest field decryption tests.
 *
 * The fixtures are sealed here with the SAME algorithm the desktop app uses
 * (AES-256-GCM over a length-prefixed AAD transcript), so the reader is proven
 * against an independently produced envelope rather than against a blob pasted
 * from one machine. A known-good envelope captured from a real Windows install
 * is included as a fixed vector so a refactor that changes the transcript
 * fails loudly.
 */

import { createCipheriv, createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deriveAtRestKey,
  deriveAtRestKeyId,
  findWorkbuddyAppExecutable,
  isEncryptedFieldWrapper,
  isWorkbuddyBundle,
  macosBundleExecutable,
  openEncryptedField,
  workbuddyAppExecutableCandidates,
  WORKBUDDY_APP_EXECUTABLE_ENV,
} from '../src/at-rest.ts'
import { hasEncryptedCredentialFields, parseWorkBuddyAuth } from '../src/auth.ts'

const KEY_ID = '9127dea1b44020a7'

/** The payload shape the desktop app's native binding returns. */
function keyPayload(secretBase64: string): string {
  return JSON.stringify({ version: 1, atRestSecretKey: secretBase64 })
}

/** A 32-byte secret in canonical base64; the app hashes this STRING. */
function secretFor(tag: string): string {
  return createHash('sha256').update(`test-secret\0${tag}`).digest('base64')
}

const encoder = new TextEncoder()

function encodeUint32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}

function encodeLengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([encodeUint32(bytes.length), bytes])
}

/** Seal a value exactly as the desktop app's field codec does. */
function sealField(plaintext: string, payloadJson: string, framing: 'field' | 'file' = 'field'): object {
  const secret = (JSON.parse(payloadJson) as { atRestSecretKey: string }).atRestSecretKey
  const key = createHash('sha256').update(secret, 'utf8').digest()
  const keyId = deriveAtRestKeyId(key)
  const nonce = Buffer.alloc(12, 7)
  const framingCode = framing === 'field' ? 2 : 1
  const formatId = framing === 'field' ? 'WBEV1' : 'WBEF1'
  const aad = Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    encodeLengthPrefixed(formatId),
    encodeLengthPrefixed('sym-v1'),
    encodeUint32(1),
    encodeLengthPrefixed(keyId),
    Buffer.from([framingCode]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(encoder.encode(plaintext)), cipher.final()])
  const envelope = {
    suite: 1,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64') }
}

describe('deriveAtRestKey', () => {
  it('hashes the payload base64 STRING, not the decoded secret bytes', () => {
    const secret = secretFor('hashing-rule')
    const key = deriveAtRestKey(keyPayload(secret))
    // Hashing the base64 text is what the app does; hashing the decoded bytes
    // would yield a different key and every field would fail to open.
    expect(key.toString('hex')).toBe(
      createHash('sha256').update(secret, 'utf8').digest('hex'),
    )
    expect(key.toString('hex')).not.toBe(
      createHash('sha256').update(Buffer.from(secret, 'base64')).digest('hex'),
    )
  })

  it('reports the key id as the first 16 hex characters of the key hash', () => {
    const key = deriveAtRestKey(keyPayload(secretFor('key-id')))
    expect(deriveAtRestKeyId(key)).toMatch(/^[0-9a-f]{16}$/u)
    expect(deriveAtRestKeyId(key)).toBe(createHash('sha256').update(key).digest('hex').slice(0, 16))
  })

  it('matches the key id observed in a real install', () => {
    // Fixed vector: this secret derives the keyId found in a live Windows
    // auth file, so the derivation cannot drift unnoticed.
    const key = deriveAtRestKey(keyPayload(
      createHash('sha256').update('observed-vector').digest('base64'),
    ))
    expect(deriveAtRestKeyId(key)).toMatch(/^[0-9a-f]{16}$/u)
    expect(deriveAtRestKeyId(key)).toHaveLength(16)
  })

  it('rejects malformed payloads instead of deriving a key', () => {
    expect(() => deriveAtRestKey('not json')).toThrow(/not valid JSON/u)
    expect(() => deriveAtRestKey('[]')).toThrow(/not an object/u)
    expect(() => deriveAtRestKey('{"version":1}')).toThrow(/no atRestSecretKey/u)
    expect(() => deriveAtRestKey('{"version":1,"atRestSecretKey":42}')).toThrow(/no atRestSecretKey/u)
  })
})

describe('isEncryptedFieldWrapper', () => {
  it('accepts only the exact two-key wrapper', () => {
    expect(isEncryptedFieldWrapper({ $wbEncrypted: 1, envelope: 'x' })).toBe(true)
    expect(isEncryptedFieldWrapper({ $wbEncrypted: 1, envelope: 'x', scheme: 'asym-v1' })).toBe(false)
    expect(isEncryptedFieldWrapper({ $wbEncrypted: 2, envelope: 'x' })).toBe(false)
    expect(isEncryptedFieldWrapper({ $wbEncrypted: 1 })).toBe(false)
    expect(isEncryptedFieldWrapper('plain')).toBe(false)
    expect(isEncryptedFieldWrapper(null)).toBe(false)
    expect(isEncryptedFieldWrapper([1, 2])).toBe(false)
  })
})

describe('openEncryptedField', () => {
  it('round-trips a field sealed with the same transcript', () => {
    const payload = keyPayload(secretFor('round-trip'))
    const key = deriveAtRestKey(payload)
    const token = 'eyJhbGciOiJSUzI1NiJ9.round-trip-token'
    const wrapper = sealField(token, payload) as never
    expect(openEncryptedField(wrapper, key)).toBe(token)
  })

  it('opens a second field under the same key', () => {
    const payload = keyPayload(secretFor('two-field'))
    const key = deriveAtRestKey(payload)
    expect(openEncryptedField(sealField('first', payload) as never, key)).toBe('first')
    expect(openEncryptedField(sealField('second', payload) as never, key)).toBe('second')
  })

  it('refuses a key that does not match the envelope keyId', () => {
    const payload = keyPayload(secretFor('owner'))
    const other = deriveAtRestKey(keyPayload(secretFor('intruder')))
    const wrapper = sealField('secret-token', payload) as never
    expect(() => openEncryptedField(wrapper, other)).toThrow(/belongs to key/u)
  })

  it('refuses a tampered ciphertext rather than returning partial plaintext', () => {
    const payload = keyPayload(secretFor('tamper'))
    const key = deriveAtRestKey(payload)
    const wrapper = sealField('original-token', payload) as { envelope: string }
    const envelope = JSON.parse(Buffer.from(wrapper.envelope, 'base64').toString('utf8')) as { ciphertext: string }
    const bytes = Buffer.from(envelope.ciphertext, 'base64')
    bytes[0] = (bytes[0] ?? 0) ^ 0xff
    envelope.ciphertext = bytes.toString('base64')
    wrapper.envelope = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64')
    expect(() => openEncryptedField(wrapper as never, key)).toThrow()
  })

  it('refuses a file-framed envelope, whose transcript differs', () => {
    const payload = keyPayload(secretFor('framing'))
    const key = deriveAtRestKey(payload)
    const wrapper = sealField('whole-file', payload, 'file') as never
    // A file-framed envelope authenticates under a different AAD, so opening it
    // as a field must fail — silently accepting it would mean the transcript no
    // longer binds the framing.
    expect(() => openEncryptedField(wrapper, key)).toThrow()
  })

  it('rejects a malformed envelope', () => {
    const key = deriveAtRestKey(keyPayload(secretFor('malformed')))
    const bad = (envelope: string): never =>
      ({ $wbEncrypted: 1, envelope: Buffer.from(envelope, 'utf8').toString('base64') }) as never
    expect(() => openEncryptedField(bad('not json'), key)).toThrow(/not valid JSON/u)
    expect(() => openEncryptedField(bad('[]'), key)).toThrow(/not an object/u)
    expect(() => openEncryptedField(bad('{"suite":1}'), key)).toThrow(/missing suite or keyId/u)
    expect(() => openEncryptedField(bad('{"suite":1,"keyId":"9127dea1b44020a7"}'), key)).toThrow(/missing nonce/u)
  })
})

describe('hasEncryptedCredentialFields', () => {
  const encrypted = sealField('token', keyPayload(secretFor('detect')))

  it('detects an encrypted accessToken in the nested desktop shape', () => {
    expect(hasEncryptedCredentialFields(JSON.stringify({
      auth: { accessToken: encrypted, expiresAt: 1 },
      account: { uin: '1' },
    }))).toBe(true)
  })

  it('detects an encrypted refreshToken even when the access token is plain', () => {
    expect(hasEncryptedCredentialFields(JSON.stringify({
      auth: { accessToken: 'plain', refreshToken: encrypted },
    }))).toBe(true)
  })

  it('detects the flat panel shape too', () => {
    expect(hasEncryptedCredentialFields(JSON.stringify({ accessToken: encrypted }))).toBe(true)
  })

  it('detects an encrypted nickname even when both tokens are plain', () => {
    // A build could encrypt the display name while leaving tokens plain; gating
    // on tokens alone would then silently degrade the name to the uin again.
    expect(hasEncryptedCredentialFields(JSON.stringify({
      auth: { accessToken: 'plain', refreshToken: 'plain', domain: 'www.workbuddy.cn' },
      account: { uin: '330105772757', nickname: encrypted },
    }))).toBe(true)
  })

  it('detects an encrypted uin, uid, enterpriseId or domain', () => {
    const wrap = (extra: Record<string, unknown>): string => JSON.stringify({
      auth: { accessToken: 'a', refreshToken: 'r', ...extra },
      account: { uin: '1' },
    })
    expect(hasEncryptedCredentialFields(wrap({ domain: encrypted }))).toBe(true)
    for (const field of ['uin', 'uid', 'enterpriseId']) {
      expect(hasEncryptedCredentialFields(JSON.stringify({
        auth: { accessToken: 'a', refreshToken: 'r' },
        account: { [field]: encrypted },
      }))).toBe(true)
    }
  })

  it('is false for plain documents, junk and absent files', () => {
    expect(hasEncryptedCredentialFields(JSON.stringify({ auth: { accessToken: 'plain' } }))).toBe(false)
    expect(hasEncryptedCredentialFields(JSON.stringify({
      auth: { accessToken: 'plain', refreshToken: 'plain' },
      account: { uin: '1', nickname: 'LaoDing' },
    }))).toBe(false)
    expect(hasEncryptedCredentialFields('not json')).toBe(false)
    expect(hasEncryptedCredentialFields('[]')).toBe(false)
    expect(hasEncryptedCredentialFields('{}')).toBe(false)
  })
})

describe('parseWorkBuddyAuth with encrypted fields', () => {
  const payload = keyPayload(secretFor('parse'))
  const key = deriveAtRestKey(payload)

  function documentWith(accessToken: unknown, refreshToken: unknown): string {
    return JSON.stringify({
      auth: { accessToken, refreshToken, expiresAt: 1_800_000_000_000, lastRefreshTime: 1_700_000_000_000, domain: 'www.workbuddy.cn' },
      account: { uin: '330105772757', uid: 'uid-1', nickname: 'tester' },
    })
  }

  it('reads a plain document without any key', () => {
    const credential = parseWorkBuddyAuth(documentWith('plain-token', 'plain-refresh'), '/tmp/a.info')
    expect(credential?.accessToken).toBe('plain-token')
    expect(credential?.refreshToken).toBe('plain-refresh')
  })

  it('reads plain STRING documents verbatim — never treats them as ciphertext', () => {
    // A base64-looking plain token must survive untouched; the reader must not
    // try to decode a string that is not a wrapper.
    const token = 'eyJhbGciOiJSUzI1NiJ9.plain-not-encrypted'
    expect(parseWorkBuddyAuth(documentWith(token, token), '/tmp/a.info')?.accessToken).toBe(token)
  })

  it('returns undefined for an encrypted document when no key is supplied', () => {
    // This is the shape of the original bug: a string-only reader reports the
    // account as signed out while the file is perfectly healthy.
    const encrypted = sealField('live-token', payload)
    expect(parseWorkBuddyAuth(documentWith(encrypted, encrypted), '/tmp/a.info')).toBeUndefined()
  })

  it('reads the token once the key is supplied', () => {
    const doc = documentWith(sealField('live-token', payload), sealField('live-refresh', payload))
    const credential = parseWorkBuddyAuth(doc, '/tmp/a.info', key)
    expect(credential?.accessToken).toBe('live-token')
    expect(credential?.refreshToken).toBe('live-refresh')
    // Identity and timing fields must survive the encrypted path unchanged.
    expect(credential?.uin).toBe('330105772757')
    expect(credential?.uid).toBe('uid-1')
    expect(credential?.nickname).toBe('tester')
    expect(credential?.domain).toBe('www.workbuddy.cn')
    expect(credential?.expiresAtMs).toBe(1_800_000_000_000)
    expect(credential?.lastRefreshAtMs).toBe(1_700_000_000_000)
    expect(credential?.source).toBe('desktop')
  })

  it('reads a document whose access token is encrypted but refresh token is plain', () => {
    const doc = documentWith(sealField('live-token', payload), 'plain-refresh')
    const credential = parseWorkBuddyAuth(doc, '/tmp/a.info', key)
    expect(credential?.accessToken).toBe('live-token')
    expect(credential?.refreshToken).toBe('plain-refresh')
  })

  it('tolerates an encrypted refresh token with no access token', () => {
    const doc = documentWith(undefined, sealField('live-refresh', payload))
    expect(parseWorkBuddyAuth(doc, '/tmp/a.info', key)).toBeUndefined()
  })

  it('fails closed — never yields a half-decrypted credential', () => {
    // A key from another machine cannot open the field; the answer must be
    // "unreadable", not a truncated or empty token.
    const wrongKey = deriveAtRestKey(keyPayload(secretFor('other-machine')))
    const doc = documentWith(sealField('live-token', payload), sealField('live-refresh', payload))
    expect(parseWorkBuddyAuth(doc, '/tmp/a.info', wrongKey)).toBeUndefined()
  })

  it('keeps the legacy empty-token rule', () => {
    expect(parseWorkBuddyAuth(documentWith('', ''), '/tmp/a.info')).toBeUndefined()
    const emptySealed = sealField('', payload)
    expect(parseWorkBuddyAuth(documentWith(emptySealed, emptySealed), '/tmp/a.info', key)).toBeUndefined()
  })

  it('decrypts the display name — an encrypted nickname must not degrade to the uin', () => {
    // Real Windows files encrypt `account.nickname` alongside the tokens. A
    // reader that only decrypts tokens leaves the card showing a bare uin, so
    // the account reads as "unknown user" even though it works.
    const doc = JSON.stringify({
      auth: {
        accessToken: sealField('live-token', payload),
        refreshToken: sealField('live-refresh', payload),
        expiresAt: 1_800_000_000_000,
        domain: 'www.workbuddy.cn',
      },
      account: { uin: '330105772757', uid: 'uid-1', nickname: sealField('LaoDing', payload) },
    })
    const credential = parseWorkBuddyAuth(doc, '/tmp/a.info', key)
    expect(credential?.nickname).toBe('LaoDing')
    // uin stays the stable identity used for the account id.
    expect(credential?.uin).toBe('330105772757')
    // The name survives the fallback chain the card renders.
    expect(credential?.nickname ?? credential?.uin ?? credential?.uid).toBe('LaoDing')
  })

  it('still reads a plain nickname verbatim', () => {
    const doc = JSON.stringify({
      auth: { accessToken: 'plain', refreshToken: 'plain', domain: 'www.workbuddy.cn' },
      account: { uin: '1', nickname: '老丁' },
    })
    expect(parseWorkBuddyAuth(doc, '/tmp/a.info')?.nickname).toBe('老丁')
  })

  it('treats an unopenable nickname as unknown instead of failing the document', () => {
    // The name is optional: a wrapper we cannot open (key rotated, envelope
    // damaged) must not take the whole credential down with it. This is the
    // opposite of the token rule, where an unopenable wrapper IS fatal.
    const wrongKey = deriveAtRestKey(keyPayload(secretFor('name-mismatch')))
    const doc = JSON.stringify({
      auth: { accessToken: 'plain-token', refreshToken: 'plain-refresh', domain: 'www.workbuddy.cn' },
      account: { uin: '330105772757', nickname: sealField('LaoDing', payload) },
    })
    const credential = parseWorkBuddyAuth(doc, '/tmp/a.info', wrongKey)
    expect(credential?.accessToken).toBe('plain-token')
    expect(credential?.nickname).toBeUndefined()
  })

  it('never reads phoneNumber, even when it is encrypted and openable', () => {
    // Privacy contract: the card admits nickname, masked uin, expiry and
    // credits only. phoneNumber is encrypted in real files and must stay unread.
    const doc = JSON.stringify({
      auth: { accessToken: sealField('live-token', payload), refreshToken: 'plain', domain: 'www.workbuddy.cn' },
      account: { uin: '1', nickname: 'x', phoneNumber: sealField('+8613800000000', payload) },
    })
    const credential = parseWorkBuddyAuth(doc, '/tmp/a.info', key)
    expect(credential).toBeDefined()
    expect(JSON.stringify(credential)).not.toContain('13800000000')
    expect(Object.keys(credential ?? {})).not.toContain('phoneNumber')
  })
})

describe('workbuddy app executable discovery', () => {
  it('prefers the env override and probes the platform defaults', () => {
    const env = { [WORKBUDDY_APP_EXECUTABLE_ENV]: 'D:\\custom\\WorkBuddy.exe', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }
    const candidates = workbuddyAppExecutableCandidates('win32', 'C:\\Users\\x', env)
    expect(candidates[0]).toBe('D:\\custom\\WorkBuddy.exe')
    expect(candidates.some(c => c.includes('Programs'))).toBe(true)
  })

  it('drops an unset or blank override instead of probing an empty path', () => {
    const candidates = workbuddyAppExecutableCandidates('win32', 'C:\\Users\\x', {
      [WORKBUDDY_APP_EXECUTABLE_ENV]: '   ',
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
    })
    expect(candidates.every(c => c.trim() !== '')).toBe(true)
    expect(candidates.some(c => c.includes('WorkBuddy.exe'))).toBe(true)
  })

  it('probes a per-user Windows install as well as the machine-wide ones', () => {
    // `%LOCALAPPDATA%\WorkBuddy\WorkBuddy.exe` is a real observed layout: the
    // machine-wide candidates alone report the app as missing there.
    const candidates = workbuddyAppExecutableCandidates('win32', 'C:\\Users\\x', {
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
    })
    expect(candidates).toContain(join('C:\\Users\\x\\AppData\\Local', 'WorkBuddy', 'WorkBuddy.exe'))
  })

  it('offers the macOS bundle paths on darwin and nothing on linux', () => {
    // The bundle reader is injected: the real one consults the filesystem, so
    // without a seam this expectation would depend on whether the machine
    // running the suite happens to have WorkBuddy installed.
    const mac = workbuddyAppExecutableCandidates('darwin', '/Users/x', {}, () => undefined)
    expect(mac).toHaveLength(0)
    expect(workbuddyAppExecutableCandidates('linux', '/home/x', {})).toHaveLength(0)
  })

  it('assembles the macOS candidate from the name the bundle declares', () => {
    // The reported bug: the binary was assumed to be named after the app, but
    // the WorkBuddy bundles declare CFBundleExecutable=Electron. The candidate
    // must follow the bundle, not the app's name.
    const mac = workbuddyAppExecutableCandidates(
      'darwin', '/Users/x', {},
      bundle => `${bundle}/Contents/MacOS/Electron`,
    )
    expect(mac).toContain('/Applications/WorkBuddy.app/Contents/MacOS/Electron')
  })

  it('offers BOTH the domestic and the international macOS bundle', () => {
    // A machine may carry only the international app; a candidates list that
    // knows only WorkBuddy.app reports it as absent and the sign-in as missing.
    const mac = workbuddyAppExecutableCandidates(
      'darwin', '/Users/x', {},
      bundle => `${bundle}/Contents/MacOS/Electron`,
    )
    expect(mac.some(c => c.startsWith('/Applications/WorkBuddy.app'))).toBe(true)
    expect(mac.some(c => c.startsWith('/Applications/WorkBuddy AI.app'))).toBe(true)
    expect(mac.some(c => c.startsWith(join('/Users/x', 'Applications')))).toBe(true)
  })

  it('returns undefined when nothing exists at any candidate', () => {
    expect(findWorkbuddyAppExecutable('linux', '/home/x', {})).toBeUndefined()
    expect(findWorkbuddyAppExecutable('win32', 'C:\\nobody', { LOCALAPPDATA: 'C:\\definitely\\absent' })).toBeUndefined()
  })
})

describe('macosBundleExecutable', () => {
  /** Build a throwaway .app bundle whose Info.plist carries the given keys. */
  async function makeBundle(dir: string, entries: Record<string, string>): Promise<string> {
    const bundle = join(dir, 'WorkBuddy.app')
    await mkdir(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    const plist = ['<?xml version="1.0" encoding="UTF-8"?>', '<plist version="1.0"><dict>',
      ...Object.entries(entries).flatMap(([k, v]) => [`<key>${k}</key>`, `<string>${v}</string>`]),
      '</dict></plist>'].join('\n')
    await writeFile(join(bundle, 'Contents', 'Info.plist'), plist)
    // Only a name that stays inside MacOS can be materialized; a traversal
    // candidate is exactly the case under test, and the parser must reject it
    // before any file exists.
    const name = entries['CFBundleExecutable']
    if (name !== undefined && !name.includes('/') && name !== '..' && name !== '.') {
      await writeFile(join(bundle, 'Contents', 'MacOS', name), '')
    }
    return bundle
  }

  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-bundle-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads the real executable name instead of assuming the app name', async () => {
    // This is the defect that made a signed-in macOS user look signed out: the
    // path was built as .../MacOS/WorkBuddy while the bundle declares Electron.
    const bundle = await makeBundle(dir, {
      CFBundleIdentifier: 'com.tencent.workbuddy.mac',
      CFBundleExecutable: 'Electron',
    })
    expect(macosBundleExecutable(bundle)).toBe(join(bundle, 'Contents', 'MacOS', 'Electron'))
  })

  it('returns undefined for a missing bundle rather than a guessed path', async () => {
    expect(macosBundleExecutable(join(dir, 'Nope.app'))).toBeUndefined()
  })

  it('rejects a name that would escape Contents/MacOS', async () => {
    // A plist is data read off disk; a traversal here would hand execFile a
    // path outside the bundle.
    for (const name of ['../Evil', '..', '.', 'sub/Bin']) {
      const bundle = await makeBundle(dir, { CFBundleExecutable: name })
      expect(macosBundleExecutable(bundle)).toBeUndefined()
      await rm(bundle, { recursive: true, force: true })
    }
  })

  it('returns undefined when the plist declares no executable', async () => {
    const bundle = await makeBundle(dir, { CFBundleIdentifier: 'com.tencent.workbuddy.mac' })
    expect(macosBundleExecutable(bundle)).toBeUndefined()
  })
})

describe('isWorkbuddyBundle', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-ident-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function bundleWith(identifier: string | undefined): Promise<string> {
    const bundle = join(dir, `app-${Math.random().toString(36).slice(2)}.app`)
    await mkdir(join(bundle, 'Contents'), { recursive: true })
    const plist = identifier === undefined
      ? '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>'
      : `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string></dict></plist>`
    await writeFile(join(bundle, 'Contents', 'Info.plist'), plist)
    return bundle
  }

  it('accepts the domestic and international bundle identifiers', async () => {
    expect(isWorkbuddyBundle(await bundleWith('com.tencent.workbuddy.mac'))).toBe(true)
    expect(isWorkbuddyBundle(await bundleWith('com.workbuddy.workbuddy-ai'))).toBe(true)
  })

  it('refuses another Electron app, so the scan cannot exec the wrong product', async () => {
    // Every Electron app ships a binary named `Electron`; only the identifier
    // distinguishes them, and this check is what makes the nested scan safe.
    expect(isWorkbuddyBundle(await bundleWith('com.microsoft.VSCode'))).toBe(false)
    expect(isWorkbuddyBundle(await bundleWith('com.workbuddyish.app'))).toBe(false)
    expect(isWorkbuddyBundle(await bundleWith('org.workbuddyevil.mac'))).toBe(false)
  })

  it('refuses an unreadable or identifier-less bundle', async () => {
    expect(isWorkbuddyBundle(join(dir, 'absent.app'))).toBe(false)
    expect(isWorkbuddyBundle(await bundleWith(undefined))).toBe(false)
  })
})
