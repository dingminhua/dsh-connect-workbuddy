import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEVICE_TOKEN_DEFAULT_TTL_MS,
  DEVICE_TOKEN_MAX_BYTES,
  createDeviceTokenReader,
  readDeviceTokenFile,
  resolveDeviceTokenPath,
} from '../src/device-token.ts'

/** A 1210-character token — the real length behind the 4 KB cap (see the module note). */
const LONG_TOKEN = `v3:${'A'.repeat(1207)}`

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-device-token-'))
  file = join(dir, 'device-token')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('resolveDeviceTokenPath', () => {
  it('expands ~ against the home directory', () => {
    expect(resolveDeviceTokenPath('~/x.json')).toBe(join(homedir(), 'x.json'))
  })

  it('resolves anything else against the process cwd', () => {
    expect(resolveDeviceTokenPath('./x.json').endsWith('x.json')).toBe(true)
  })
})

describe('readDeviceTokenFile', () => {
  it('reads a bare token, trimmed', async () => {
    await writeFile(file, `  ${LONG_TOKEN}\n`)
    const readout = await readDeviceTokenFile(file)
    expect(readout.state).toBe('ok')
    expect(readout.token).toBe(LONG_TOKEN)
  })

  it('reads A\'s {token, ts} envelope — pointing at its cache must just work', async () => {
    // The whole compatibility claim of P2: a user of workbuddy2openapi can point
    // this at .turing_token_cache.json with no extra script.
    await writeFile(file, JSON.stringify({ token: LONG_TOKEN, ts: 1761900000000 }))
    const readout = await readDeviceTokenFile(file)
    expect(readout.state).toBe('ok')
    expect(readout.token).toBe(LONG_TOKEN)
  })

  it('accepts the real 1210-character token that B\'s 1 KB cap would reject', async () => {
    // B's `deviceTokenFileMaxLen = 1024` turns this exact file into "not
    // configured" (silently). The limit here is 4 KB on purpose.
    expect(LONG_TOKEN.length).toBeGreaterThan(1024)
    await writeFile(file, LONG_TOKEN)
    const readout = await readDeviceTokenFile(file)
    expect(readout.state).toBe('ok')
    expect(readout.token).toHaveLength(LONG_TOKEN.length)
  })

  it('reports a missing file as absent — that is a normal state, not an error', async () => {
    const readout = await readDeviceTokenFile(file)
    expect(readout.state).toBe('absent')
    expect(readout.reason).toBeUndefined()
  })

  it('rejects an oversized file instead of reading it', async () => {
    await writeFile(file, 'x'.repeat(DEVICE_TOKEN_MAX_BYTES + 1))
    const readout = await readDeviceTokenFile(file)
    expect(readout.state).toBe('too-large')
    expect(readout.reason).toContain(String(DEVICE_TOKEN_MAX_BYTES))
  })

  it('rejects an empty file, a multi-line raw value, and a broken envelope', async () => {
    await writeFile(file, '   \n')
    expect((await readDeviceTokenFile(file)).state).toBe('unreadable')

    await writeFile(file, 'v3:abc\nv3:def')
    expect((await readDeviceTokenFile(file)).reason).toContain('single line')

    await writeFile(file, '{"token":')
    expect((await readDeviceTokenFile(file)).reason).toContain('not valid JSON')

    await writeFile(file, JSON.stringify({ ts: 1 }))
    expect((await readDeviceTokenFile(file)).reason).toContain('token field')
  })

  it('rejects a directory', async () => {
    expect((await readDeviceTokenFile(dir)).reason).toContain('not a regular file')
  })

  it('never echoes the token in a failure reason', async () => {
    // A reason string ends up in `doctor` and in issue reports.
    await writeFile(file, `${LONG_TOKEN}\n${LONG_TOKEN}`)
    const readout = await readDeviceTokenFile(file)
    expect(readout.state).toBe('unreadable')
    expect(readout.reason).not.toContain(LONG_TOKEN)
  })
})

describe('createDeviceTokenReader', () => {
  it('caches for ttlMs and re-reads after it', async () => {
    // The token expires in minutes while the process lives for hours: reading it
    // once at construction (as the salt is read) would pin a dead value.
    await writeFile(file, 'v3:first')
    const reader = createDeviceTokenReader({ file, ttlMs: 60_000 })

    expect(await reader.current(0)).toBe('v3:first')
    await writeFile(file, 'v3:second')
    expect(await reader.current(59_999)).toBe('v3:first')
    expect(await reader.current(60_001)).toBe('v3:second')
  })

  it('falls back to the default TTL when none is given', () => {
    expect(DEVICE_TOKEN_DEFAULT_TTL_MS).toBe(5 * 60 * 1000)
    const reader = createDeviceTokenReader({ file })
    expect(reader.last()).toBeUndefined()
  })

  it('warns once per bad state, not once per request', async () => {
    const warn = vi.fn()
    const reader = createDeviceTokenReader({ file, ttlMs: 1, warn })

    expect(await reader.current(0)).toBeUndefined()
    expect(await reader.current(10)).toBeUndefined()
    expect(await reader.current(20)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('absent')
    expect(warn.mock.calls[0]?.[0]).not.toContain('v3:')
  })

  it('reports again after a recovery and a new break', async () => {
    const warn = vi.fn()
    const reader = createDeviceTokenReader({ file, ttlMs: 1, warn })

    expect(await reader.current(0)).toBeUndefined()
    await writeFile(file, 'v3:good')
    expect(await reader.current(10)).toBe('v3:good')
    await rm(file)
    expect(await reader.current(20)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('exposes the last readout for diagnostics without leaking it elsewhere', async () => {
    await writeFile(file, 'v3:abc')
    const reader = createDeviceTokenReader({ file })
    await reader.current(0)
    expect(reader.last()?.state).toBe('ok')
    expect(reader.last()?.token).toBe('v3:abc')
  })
})
