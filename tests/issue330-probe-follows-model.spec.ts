/**
 * ISSUE #330 — the availability probe must test the model the user is ON.
 *
 * The request behind the issue, verbatim: 「当切换模型后应当重新检测账号的可用性」
 * ("switching models should re-check the account's availability").
 *
 * WHY IT DID NOT. The pool's probe ran against its own saved preference
 * (`poolPreferences.targetModelId`), resolved by `resolveTargetModel` against the
 * region's catalog. That preference is independent of the model in use, so a user
 * could switch models and keep a green tick earned by a DIFFERENT model. Per-model
 * quota is what makes this a correctness bug rather than a cosmetic one: a row
 * read 可用 because a free model answered, while the model actually selected was
 * exhausted.
 *
 * WHICH model the user is on is HOST session state — the card's `enabledModelIds`
 * is the set of models OFFERED, not the one in use. The only place this plugin
 * learns the truth is the request body, so the shim reports it per region
 * (`onRequestModel`) and the probe prefers it.
 *
 * PRECEDENCE, which is the design decision worth testing: an EXPLICIT saved
 * preference still wins (it is a deliberate instruction, and overriding it would
 * spend credits on a model the user did not choose); otherwise the observed model
 * is used; otherwise the old automatic resolution stands.
 *
 * @module dsh-connect-workbuddy/tests/issue330-probe-follows-model
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  expiresAtMs: 1_812_001_890_181,
  domain: 'www.codebuddy.cn',
  uid: 'uid-100000000001',
  uin: '100000000001',
  source: 'desktop',
  filePath: '/Users/<you>/.dsh/auth-accountA.info',
}

let shim: WorkBuddyShim | undefined
afterEach(async () => { await shim?.close(); shim = undefined })

/** Drive one chat request and return whatever the shim reported as its model. */
async function chatWith(model: string): Promise<string[]> {
  const seen: string[] = []
  shim = createWorkBuddyShim({
    store: { resolve: async () => CREDENTIAL, credentialFor: async () => CREDENTIAL } as never,
    catalog: new WorkBuddyCatalog(),
    client: {
      chatStream: async () => ({
        ok: false as const,
        status: 500,
        kind: 'server' as const,
        message: '{"code":0,"msg":"stop here"}',
      }),
    } as never,
    onRequestModel: (modelId: string) => { seen.push(modelId) },
  })
  await shim.ready
  await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  }).then(response => response.text())
  return seen
}

describe('issue #330: the shim reports the model each request actually uses', () => {
  it('reports the model id from the request body', async () => {
    expect(await chatWith('deepseek-v4.1-flash')).toEqual(['deepseek-v4.1-flash'])
  })

  it('reports a DIFFERENT id after the user switches models', async () => {
    // The switch is the whole trigger for the issue: the pool must be able to
    // see that the model changed.
    expect(await chatWith('hy4flash-free')).toEqual(['hy4flash-free'])
  })

  it('does not report when the body carries no usable model id', async () => {
    // A guessed model would let the probe measure something the user never used.
    expect(await chatWith('')).toEqual([])
  })
})

describe('issue #330: a bookkeeping failure never fails the chat request', () => {
  it('keeps serving the request when the reporter throws', async () => {
    shim = createWorkBuddyShim({
      store: { resolve: async () => CREDENTIAL, credentialFor: async () => CREDENTIAL } as never,
      catalog: new WorkBuddyCatalog(),
      client: {
        chatStream: async () => ({
          ok: false as const,
          status: 500,
          kind: 'server' as const,
          message: '{"code":0,"msg":"stop here"}',
        }),
      } as never,
      onRequestModel: () => { throw new Error('reporter exploded') },
    })
    await shim.ready
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'hy4flash-free', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const text = await response.text()
    // The upstream failure still reaches the client; the exception did not.
    expect(text).toContain('stop here')
    expect(text).not.toContain('reporter exploded')
  })
})

describe('issue #330: probe-model precedence', () => {
  // `pickFreeModel` keys on `creditMultiplier === 0` and prefers the widest
  // `contextWindow`, so both fields have to be realistic here.
  const catalog = [
    { id: 'hy4flash-free', creditMultiplier: 0, contextWindow: 128_000 },
    { id: 'deepseek-v4.1-flash', creditMultiplier: 1, contextWindow: 128_000 },
    { id: 'glm-5.4', creditMultiplier: 1, contextWindow: 200_000 },
  ] as never

  it('uses the OBSERVED model when no preference is saved', async () => {
    // The core of the fix: the probe measures the model the user is on, not an
    // arbitrary free one.
    const { resolveProbeModel } = await import('../src/account-pool.ts')
    expect(resolveProbeModel(catalog, '', 'deepseek-v4.1-flash')).toEqual({
      modelId: 'deepseek-v4.1-flash',
      source: 'observed',
    })
  })

  it('an EXPLICIT saved preference still wins over the observed model', async () => {
    // Deliberate: overriding a saved choice would spend the user's credits on a
    // model they did not pick.
    const { resolveProbeModel } = await import('../src/account-pool.ts')
    expect(resolveProbeModel(catalog, 'glm-5.4', 'deepseek-v4.1-flash')).toEqual({
      modelId: 'glm-5.4',
      source: 'preferred',
    })
  })

  it('falls back to the old automatic choice when nothing was observed', async () => {
    // No chat request since start-up: behaviour must be unchanged.
    const { resolveProbeModel } = await import('../src/account-pool.ts')
    expect(resolveProbeModel(catalog, '', undefined)).toEqual({
      modelId: 'hy4flash-free',
      source: 'free',
    })
  })

  it('does NOT use an observed model the catalog no longer offers', async () => {
    // The probe must never spend a request asking for a model the roster does
    // not have; falling through keeps the staleness reporting honest.
    const { resolveProbeModel } = await import('../src/account-pool.ts')
    expect(resolveProbeModel(catalog, '', 'retired-model')).toEqual({
      modelId: 'hy4flash-free',
      source: 'free',
    })
  })

  it('reports a stale SAVED id rather than silently probing something else', async () => {
    const { resolveProbeModel } = await import('../src/account-pool.ts')
    expect(resolveProbeModel(catalog, 'gone-model', 'deepseek-v4.1-flash')).toEqual({
      staleModelId: 'gone-model',
      source: 'stale',
    })
  })
})
