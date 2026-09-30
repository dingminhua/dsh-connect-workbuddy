import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readPoolProbes,
  workbuddyPoolStorePath,
  writePoolProbes,
} from '../src/account-pool-store.ts'

/**
 * The pool store names its file from `$DSH_HOME`, which vitest.config.ts points
 * at a temp directory, so these tests never touch a real profile.
 */
let home: string
let previousHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-pool-'))
  previousHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
})
afterEach(async () => {
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  await rm(home, { force: true, recursive: true })
})

describe('workbuddyPoolStorePath', () => {
  it('keys the file by region so the two pools never share measurements', () => {
    expect(workbuddyPoolStorePath('cn')).not.toBe(workbuddyPoolStorePath('global'))
    expect(workbuddyPoolStorePath('cn')).toContain('.workbuddy-pool.cn.json')
    expect(workbuddyPoolStorePath('global')).toContain('.workbuddy-pool.global.json')
  })
})

describe('readPoolProbes', () => {
  it('reads nothing when the file is absent', async () => {
    // A fresh pool has measured nothing, which is a valid state the card
    // renders as "not tested yet".
    expect(await readPoolProbes('cn')).toEqual({})
  })

  it('round-trips a written measurement', async () => {
    await writePoolProbes('cn', {
      alpha: { outcome: 'ok', atMs: 1_800_000_000_000 },
      beta: { outcome: 'rate-limited', atMs: 1_800_000_000_000, retryAtMs: 1_800_000_600_000 },
    })
    const probes = await readPoolProbes('cn')
    expect(probes['alpha']).toEqual({ outcome: 'ok', atMs: 1_800_000_000_000 })
    expect(probes['beta']?.retryAtMs).toBe(1_800_000_600_000)
  })

  it('keeps the two regions fully separate', async () => {
    await writePoolProbes('cn', { alpha: { outcome: 'ok', atMs: 1 } })
    expect(await readPoolProbes('global')).toEqual({})
  })

  it('merges rather than replacing, so a partial batch keeps earlier results', async () => {
    // Batches measure one account at a time and can partly fail; a replace
    // would erase what earlier runs learned.
    await writePoolProbes('cn', { alpha: { outcome: 'ok', atMs: 1 } })
    await writePoolProbes('cn', { beta: { outcome: 'out-of-credit', atMs: 2 } })
    const probes = await readPoolProbes('cn')
    expect(Object.keys(probes).sort()).toEqual(['alpha', 'beta'])
  })

  it('overwrites one account without disturbing the others', async () => {
    await writePoolProbes('cn', {
      alpha: { outcome: 'ok', atMs: 1 },
      beta: { outcome: 'ok', atMs: 1 },
    })
    await writePoolProbes('cn', { alpha: { outcome: 'rate-limited', atMs: 9 } })
    const probes = await readPoolProbes('cn')
    expect(probes['alpha']?.atMs).toBe(9)
    expect(probes['beta']?.atMs).toBe(1)
  })

  it('writes nothing for an empty update', async () => {
    await writePoolProbes('cn', {})
    await expect(readFile(workbuddyPoolStorePath('cn'), 'utf8')).rejects.toThrow()
  })

  it('contains no token material', async () => {
    // The store holds measurements only. A credential leaking in here would be
    // a real disclosure, so the file's shape is asserted rather than assumed.
    await writePoolProbes('cn', { alpha: { outcome: 'ok', atMs: 1 } })
    const raw = await readFile(workbuddyPoolStorePath('cn'), 'utf8')
    expect(raw).not.toContain('token')
    expect(raw).not.toContain('refresh')
    expect(raw).not.toContain('accessToken')
  })

  it('survives a corrupt file by reporting nothing measured', async () => {
    await writeFile(workbuddyPoolStorePath('cn'), '{ not json', 'utf8')
    expect(await readPoolProbes('cn')).toEqual({})
  })

  it('ignores a document from an unknown format version', async () => {
    // A future format must not be read as if it were this one.
    await writeFile(
      workbuddyPoolStorePath('cn'),
      JSON.stringify({ version: 99, probes: { alpha: { outcome: 'ok', atMs: 1 } } }),
      'utf8',
    )
    expect(await readPoolProbes('cn')).toEqual({})
  })

  it('skips individual malformed rows without discarding the good ones', async () => {
    await writeFile(
      workbuddyPoolStorePath('cn'),
      JSON.stringify({
        version: 1,
        probes: {
          good: { outcome: 'ok', atMs: 1 },
          bad: { outcome: 'ok' },
          worse: 'nonsense',
          '': { outcome: 'ok', atMs: 3 },
        },
      }),
      'utf8',
    )
    expect(Object.keys(await readPoolProbes('cn'))).toEqual(['good'])
  })

  it('never throws when the write target is unusable', async () => {
    // A failed write loses only the newest measurements; the batch's results
    // are still valid and must not be turned into an error by persistence.
    delete process.env['DSH_HOME']
    process.env['DSH_HOME'] = join(home, 'a-file-not-a-directory')
    await writeFile(process.env['DSH_HOME'], 'x', 'utf8')
    await expect(writePoolProbes('cn', { alpha: { outcome: 'ok', atMs: 1 } })).resolves.toBeUndefined()
  })
})
