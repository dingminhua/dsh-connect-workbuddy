/**
 * ISSUE #288 — a rate limit must not silently shrink the model directory.
 *
 * THE REPORT. On the international region the upstream answered HTTP 429
 * (`soft_rate` / `quota_exceeded`, 「将在 2026-11-23 09:22:26 UTC+8 重置」),
 * and the model picker was left with ONE model while the profile still held
 * seven in `lastCatalog`. Nothing on screen said the directory could not be
 * read.
 *
 * THE MECHANISM (verified against 5.30.0, not taken from the report). The
 * international region reads the product configuration TWICE — as the CLI
 * channel and as the app channel — because neither document is a superset of
 * the other. The two publish DIFFERENT rosters: the CLI document carries
 * `fast-model` / `balanced-model` / `primary-model` / `deepseek-v4.1-flash` /
 * `hy4-preview` / …, the app document carries `max-model` / `hy4free` /
 * `hy4std` (measured on a real account 2026-11-06).
 *
 * So when ONE read is refused, the fallback to the other is a DOWNGRADE: the
 * answer is missing every row the refused document published. And the keep
 * contract (`selectCliModels`) only holds WITHIN one document — the user's
 * selected ids are re-added only when the SAME document still publishes them.
 * The roster was then filtered by the user's own selection, so a rate limit
 * could leave the picker with one row and the profile with seven, and the
 * difference was reported in a log line nobody reads.
 *
 * THE THREE THINGS THIS FILE PINS.
 *
 *   1. A FALLBACK READ SAYS SO. The answer carries which document was refused
 *      and what the upstream said — so the card can name the fact instead of
 *      the user guessing.
 *   2. A DEGRADED READ DOES NOT SHRINK THE ROSTER. The saved directory fills
 *      the gap, so the picker keeps the models the user is running. A HEALTHY
 *      read still answers alone: it may narrow the list, a partial one may not.
 *   3. THE RECOVERY TIME IS PARSED, NOT INVENTED — and the upstream's body is
 *      redacted before it crosses to the browser.
 */
import { describe, expect, it, vi } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { rosterOfRead } from '../src/catalog-sync.ts'
import { toWebCatalogDegradation } from '../src/status-paths.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { WorkBuddyUpstreamModel } from '../src/upstream.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

/** A credential for one region. */
function credential(domain: string): WorkBuddyCredential {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAtMs: 0,
    domain,
    uid: 'u',
    source: 'desktop',
    filePath: '/tmp/workbuddy-desktop.info',
  }
}

/** One model row, in the shape the upstream's document carries. */
function row(id: string): WorkBuddyUpstreamModel {
  return { id, name: id, contextWindow: 200_000, maxTokens: 8_192 } as WorkBuddyUpstreamModel
}

/** The upstream's own words about a rate limit, measured on a live 429. */
const RATE_LIMIT_BODY = 'usage exceeds frequency limit, but don\'t worry, your usage will reset at 2026-11-23 09:22:26 UTC+8, alternatively, you can switch to the other models to continue using it.'

/**
 * A document answering with the given model ids.
 *
 * `agents` names the `cli` agent, which is what the roster selector keeps.
 */
function documentOf(ids: readonly string[]): string {
  return JSON.stringify({
    code: 0,
    msg: 'OK',
    data: {
      models: ids.map(id => ({ id, name: id, maxInputTokens: 200_000, maxOutputTokens: 8_192 })),
      agents: [{ name: 'cli', models: [...ids] }],
    },
  })
}

describe('a fallback catalog read says which document was refused', () => {
  it('marks the international read degraded when the CLI channel is refused', async () => {
    // The CLI document is the one that publishes `fast-model` and friends, so
    // this is exactly the read whose refusal loses rows.
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          text: async () => JSON.stringify({ code: 6004, msg: RATE_LIMIT_BODY }),
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        text: async () => documentOf(['hy3']),
      } as unknown as Response
    })
    const client = new WorkBuddyUpstreamClient()
    const read = await client.fetchModels(credential('www.workbuddy.ai'))
    expect(read.degraded?.missing).toBe('cli')
    expect(read.degraded?.used).toBe('app')
    // The upstream's OWN words, untruncated: the recovery sentence lives in
    // them, and it is the only place the user learns when the limit lifts.
    expect(read.degraded?.body).toContain('2026-11-23 09:22:26 UTC+8')
    expect(read.models.map(model => model.id)).toEqual(['hy3'])
    vi.unstubAllGlobals()
  })

  it('marks the read degraded when the app channel is refused', async () => {
    // The other direction: the desktop-only rows (`hy4free`, `hy4std`,
    // `max-model`) live in the app document, so refusing it loses THOSE.
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      if (calls === 2) {
        return {
          ok: false,
          status: 502,
          text: async () => JSON.stringify({ code: 50000, msg: 'bad gateway' }),
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        text: async () => documentOf(['fast-model', 'hy3']),
      } as unknown as Response
    })
    const client = new WorkBuddyUpstreamClient()
    const read = await client.fetchModels(credential('www.workbuddy.ai'))
    expect(read.degraded?.missing).toBe('app')
    expect(read.degraded?.used).toBe('cli')
    expect(read.models.map(model => model.id)).toEqual(['fast-model', 'hy3'])
    vi.unstubAllGlobals()
  })

  it('marks the CN read degraded when it falls back to the legacy document', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          text: async () => JSON.stringify({ code: 6004, msg: RATE_LIMIT_BODY }),
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        text: async () => documentOf(['hy4-preview']),
      } as unknown as Response
    })
    const client = new WorkBuddyUpstreamClient()
    const read = await client.fetchModels(credential('www.codebuddy.cn'))
    expect(read.degraded?.missing).toBe('app')
    expect(read.degraded?.used).toBe('legacy')
    vi.unstubAllGlobals()
  })

  it('reports NO degradation when every document answered', async () => {
    // The absence is a fact too: a complete read may narrow the list, so the
    // roster must not be merged with the saved directory behind the user's
    // back. A `degraded` that is always present would quietly disable that.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => documentOf(['fast-model', 'hy3']),
    }) as unknown as Response)
    const client = new WorkBuddyUpstreamClient()
    const read = await client.fetchModels(credential('www.workbuddy.ai'))
    expect(read.degraded).toBeUndefined()
    vi.unstubAllGlobals()
  })
})

describe('a degraded read does not shrink the roster', () => {
  /** The directory the profile carried: seven rows, five of them CLI-only. */
  const SAVED = [
    row('fast-model'),
    row('balanced-model'),
    row('primary-model'),
    row('hy4-preview'),
    row('hy3'),
    row('deepseek-v4.1-flash'),
  ]

  it('keeps the saved rows the refused document published', () => {
    // The heart of issue #288. The degraded answer holds `hy3` only; the
    // saved directory holds the CLI-only rows the refused document published.
    // The roster must carry BOTH, or the user's running model vanishes from
    // the picker while the profile still holds it.
    const read = {
      models: [row('hy3')],
      degraded: { missing: 'cli' as const, used: 'app' as const, body: RATE_LIMIT_BODY },
    }
    const roster = rosterOfRead(SAVED, read)
    expect(roster.map(model => model.id)).toEqual([
      'hy3',
      'fast-model',
      'balanced-model',
      'primary-model',
      'hy4-preview',
      'deepseek-v4.1-flash',
    ])
  })

  it('answers a COMPLETE read with the upstream roster alone', () => {
    // The other half, and the reason the two cases cannot share one rule: a
    // complete read is the upstream's truth about what it offers, and the
    // saved directory is a snapshot of one moment. Merging it back in would
    // keep offering models the upstream has since withdrawn.
    const read = { models: [row('hy3')] }
    const roster = rosterOfRead(SAVED, read)
    expect(roster.map(model => model.id)).toEqual(['hy3'])
  })

  it('keeps the saved rows\' own capabilities while their document is refused', () => {
    // The saved row is all that is left of a model the refused document
    // published — including whether it declares thinking tiers. Carrying it
    // with its capabilities is the best answer available; dropping it is not.
    const saved = [{ ...row('fast-model'), reasoning: { supportedEfforts: ['low', 'high'] } }]
    const read = {
      models: [row('hy3')],
      degraded: { missing: 'cli' as const, used: 'app' as const, body: RATE_LIMIT_BODY },
    }
    const roster = rosterOfRead(saved, read)
    expect(roster.find(model => model.id === 'fast-model')?.reasoning?.supportedEfforts)
      .toEqual(['low', 'high'])
  })
})

describe('the catalog remembers that its roster is partial', () => {
  const degradation = { missing: 'cli' as const, used: 'app' as const, body: RATE_LIMIT_BODY }

  it('carries the degradation of an upstream write', () => {
    const catalog = new WorkBuddyCatalog('global')
    catalog.set([row('hy3')], 'upstream', degradation)
    expect(catalog.degradation()?.missing).toBe('cli')
  })

  it('KEEPS it through a derivation — a roster derived from a partial read is partial', () => {
    // `applySelection` re-derives the catalog on every settings change. If
    // the derivation cleared the flag, the very next toggle would promote a
    // partial answer into a complete one and the notice would vanish.
    const catalog = new WorkBuddyCatalog('global')
    catalog.set([row('hy3')], 'upstream', degradation)
    catalog.set([row('hy3')], 'derived')
    expect(catalog.degradation()?.missing).toBe('cli')
  })

  it('clears it when a COMPLETE upstream write lands', () => {
    const catalog = new WorkBuddyCatalog('global')
    catalog.set([row('hy3')], 'upstream', degradation)
    catalog.set([row('hy3'), row('hy4free')], 'upstream')
    expect(catalog.degradation()).toBeUndefined()
  })
})

describe('the degradation that crosses to the browser', () => {
  it('parses the recovery time out of the upstream\'s own words', () => {
    // The upstream states the time in prose, and this is the only place the
    // user learns it. Both spellings must work: the Chinese gateway says
    // 「将在 … 重置」 and the international one says 「reset at …」.
    const international = toWebCatalogDegradation({
      missing: 'cli', used: 'app', body: RATE_LIMIT_BODY,
    })
    expect(international.resetAtMs).toBe(Date.parse('2026-11-23T01:22:26Z'))
    const chinese = toWebCatalogDegradation({
      missing: 'app',
      used: 'legacy',
      body: '您的使用量已超出频率限制，将在 2026-11-23 09:22:26 UTC+8 重置，您也可以切换其他模型继续使用。',
    })
    expect(chinese.resetAtMs).toBe(Date.parse('2026-11-23T01:22:26Z'))
  })

  it('states NO time when the upstream named none', () => {
    // The honest-absence contract: a missing time is not "now" and not a
    // guess. The card says "the upstream gave no time" by leaving it out.
    const answer = toWebCatalogDegradation({
      missing: 'cli', used: 'app', body: 'workbuddy upstream server (http 502): bad gateway',
    })
    expect(answer.resetAtMs).toBeUndefined()
  })

  it('redacts a token-shaped body before it reaches the screen', () => {
    // A raw upstream string can carry anything; the same rule the pool
    // applies before it touches the disk applies here, because this one goes
    // on screen.
    const answer = toWebCatalogDegradation({
      missing: 'cli',
      used: 'app',
      body: 'workbuddy upstream server (http 500): failed with access_token=eyJhbGciOi.eyJzdWIi.sig',
    })
    expect(answer.reason).not.toContain('eyJhbGciOi')
    expect(answer.reason).toContain('[redacted]')
  })
})
