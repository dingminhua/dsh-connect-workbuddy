import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyAutoCheckinState } from '../src/auto-checkin.ts'
import { growthStatePath, readGrowthState, writeGrowthState } from '../src/growth-state-store.ts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-growth-state-'))
  process.env.DSH_HOME = root
})
afterEach(async () => { await rm(root, { force: true, recursive: true }) })

describe('growth state store', () => {
  it('keeps the two capabilities in SEPARATE files (done sets cannot collide)', async () => {
    const day = '2026-11-20'
    const redeem = { ...emptyAutoCheckinState(day), doneAccountIds: ['a'] }
    const activity = { ...emptyAutoCheckinState(day), doneAccountIds: ['b'] }
    await writeGrowthState('growth-redeem', 'cn', redeem)
    await writeGrowthState('growth-activity', 'cn', activity)
    expect((await readGrowthState('growth-redeem', 'cn'))?.doneAccountIds).toEqual(['a'])
    expect((await readGrowthState('growth-activity', 'cn'))?.doneAccountIds).toEqual(['b'])
    // Three distinct files: the two growth capabilities and check-in.
    expect(growthStatePath('growth-redeem', 'cn')).not.toBe(growthStatePath('growth-activity', 'cn'))
    expect(growthStatePath('growth-redeem', 'cn')).toContain('growth-redeem')
  })

  it('merges the sibling region instead of overwriting it', async () => {
    const day = '2026-11-20'
    await writeGrowthState('growth-redeem', 'cn', { ...emptyAutoCheckinState(day), doneAccountIds: ['a'] })
    await writeGrowthState('growth-redeem', 'global', { ...emptyAutoCheckinState(day), doneAccountIds: ['g'] })
    expect((await readGrowthState('growth-redeem', 'cn'))?.doneAccountIds).toEqual(['a'])
    expect((await readGrowthState('growth-redeem', 'global'))?.doneAccountIds).toEqual(['g'])
  })

  it('stores no token or account name — only ids and a reason', async () => {
    const state = {
      ...emptyAutoCheckinState('2026-11-20'),
      doneAccountIds: ['supersecret-uid'],
      lastError: 'upstream down',
    }
    await writeGrowthState('growth-activity', 'global', state)
    const raw = await readFile(growthStatePath('growth-activity', 'global'), 'utf8')
    expect(raw).toContain('supersecret-uid')
    expect(raw).toContain('upstream down')
    expect(raw).not.toContain('accessToken')
    expect(raw).not.toContain('refreshToken')
  })

  it('reads nothing from a missing or corrupt file', async () => {
    expect(await readGrowthState('growth-redeem', 'cn')).toBeUndefined()
  })
})
