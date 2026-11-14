import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as heartbeat from '../src/host-heartbeat.ts'
import * as WorkBuddy from '../src/index.ts'

const children: ChildProcess[] = []
const homes: string[] = []
const contexts: Context[] = []

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'wb-heartbeat-owner-'))
  homes.push(value)
  return value
}

async function childAt(directory: string) {
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    fileURLToPath(new URL('./fixtures/host-heartbeat-owner-process.mjs', import.meta.url)),
  ], {
    env: { ...process.env, DSH_HOME: directory },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  })
  children.push(child)
  const [ready] = await once(child, 'message')
  expect(ready).toEqual({ ready: true })
  let requestId = 0
  return async (action: string, name = 'owner', targetHome?: string): Promise<void> => {
    const id = ++requestId
    const response = once(child, 'message')
    child.send({ id, action, name, ...(targetHome === undefined ? {} : { home: targetHome }) })
    const [message] = await response
    expect(message.id).toBe(id)
    if (!message.ok) throw Object.assign(new Error(message.error.message), { code: message.error.code })
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null) return
    const exited = once(child, 'exit')
    child.send({ id: -1, action: 'exit' })
    const [code] = await exited
    expect(code).toBe(0)
  }))
  await Promise.all(homes.splice(0).map(directory => rm(directory, { recursive: true, force: true, maxRetries: 5 })))
})

it('keeps the current writer across two real processes, including an unwritten failed startup', async () => {
  const directory = await home()
  const file = join(directory, heartbeat.WORKBUDDY_HOST_HEARTBEAT_FILENAME)
  const a = await childAt(directory)
  const b = await childAt(directory)
  await a('write', 'first')
  const first = await readFile(file, 'utf8')
  await b('clear', 'never-written')
  expect(await readFile(file, 'utf8')).toBe(first)

  const missing = join(directory, 'parent-does-not-exist', 'home')
  await expect(b('write', 'failed', missing)).rejects.toHaveProperty('code', 'ENOENT')
  await b('clear', 'failed')
  expect(await readFile(file, 'utf8')).toBe(first)

  await b('write', 'second', directory)
  const second = await readFile(file, 'utf8')
  expect(JSON.parse(second).pid).not.toBe(JSON.parse(first).pid)
  await a('clear', 'first')
  expect(await readFile(file, 'utf8')).toBe(second)
  await b('clear', 'second')
  await expect(readFile(file)).rejects.toHaveProperty('code', 'ENOENT')
})

it('distinguishes same-process registrations and uses the captured Home when disposing', async () => {
  const firstHome = await home()
  const otherHome = await home()
  vi.stubEnv('DSH_HOME', firstHome)
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  const first = await heartbeat.writeHostHeartbeat()
  const second = await heartbeat.writeHostHeartbeat()
  expect(JSON.parse(first.contents).registeredAt).toBe(JSON.parse(second.contents).registeredAt)
  expect(JSON.parse(first.contents).registrationId).not.toBe(JSON.parse(second.contents).registrationId)
  expect(first.contents).not.toBe(second.contents)
  await heartbeat.clearHostHeartbeat(first)
  expect(await readFile(second.path, 'utf8')).toBe(second.contents)
  const otherFile = join(otherHome, heartbeat.WORKBUDDY_HOST_HEARTBEAT_FILENAME)
  await writeFile(otherFile, 'another synthetic owner')
  vi.stubEnv('DSH_HOME', otherHome)
  await heartbeat.clearHostHeartbeat(second)
  await heartbeat.clearHostHeartbeat(second)
  expect(await readFile(otherFile, 'utf8')).toBe('another synthetic owner')
  await expect(readFile(second.path)).rejects.toHaveProperty('code', 'ENOENT')
})

it('preserves replacements and reports unexpected read errors', async () => {
  vi.stubEnv('DSH_HOME', await home())
  const owner = await heartbeat.writeHostHeartbeat()
  await writeFile(owner.path, 'replacement is deliberately not valid JSON')
  await heartbeat.clearHostHeartbeat(owner)
  expect(await readFile(owner.path, 'utf8')).toBe('replacement is deliberately not valid JSON')
  await rm(owner.path)
  await mkdir(owner.path)
  await expect(heartbeat.clearHostHeartbeat(owner)).rejects.toThrow()
  await expect(readFile(owner.path)).rejects.toThrow()
})

it('waits for a pending heartbeat write when the actual plugin is disposed', async () => {
  const directory = await home()
  vi.stubEnv('DSH_HOME', directory)
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  const file = join(directory, heartbeat.WORKBUDDY_HOST_HEARTBEAT_FILENAME)
  const contents = 'synthetic delayed registration'
  vi.spyOn(heartbeat, 'writeHostHeartbeat').mockImplementation(async () => {
    started.resolve()
    await release.promise
    await writeFile(file, contents)
    finished.resolve()
    return { path: file, contents }
  })
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  // Direct apply follows the repository's provider fixtures without requiring a settings UI service.
  WorkBuddy.apply(ctx, { authFile: join(directory, 'missing-auth'), deviceSdkEnabled: false } as WorkBuddy.Config)
  await started.promise
  let disposed = false
  const closing = ctx.fiber.dispose().then(() => { disposed = true })
  try {
    await new Promise(resolve => setImmediate(resolve))
    expect(disposed).toBe(false)
  } finally {
    release.resolve()
    await finished.promise
    await closing
  }
  expect(disposed).toBe(true)
  await expect(readFile(file)).rejects.toHaveProperty('code', 'ENOENT')
})

it('contains a failed heartbeat write and leaves another owner intact during plugin disposal', async () => {
  const directory = await home()
  vi.stubEnv('DSH_HOME', directory)
  const file = join(directory, heartbeat.WORKBUDDY_HOST_HEARTBEAT_FILENAME)
  await writeFile(file, 'another synthetic Host')
  const write = vi.spyOn(heartbeat, 'writeHostHeartbeat').mockRejectedValue(new Error('synthetic write failure'))
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  WorkBuddy.apply(ctx, { authFile: join(directory, 'missing-auth'), deviceSdkEnabled: false } as WorkBuddy.Config)
  await expect.poll(() => write.mock.calls.length).toBe(1)
  await ctx.fiber.dispose()
  expect(await readFile(file, 'utf8')).toBe('another synthetic Host')
})
