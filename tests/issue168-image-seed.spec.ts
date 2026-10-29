import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as WorkBuddy from '../src/index.ts'

/**
 * A newly-added multimodal model must be ADVERTISED as accepting images, even
 * before the user touches its checkbox (issue #168).
 *
 * ## The report
 *
 * 「使用多模态模型（比如 dsv4.1flash）发送图片，显示当前模型不支持图片」 — with
 * `deepseek-v4.1-flash` ticked in the card. The message is the HOST's, not the
 * plugin's:
 *
 *     Model "…" does not support image input.   (MODEL_DOES_NOT_SUPPORT_IMAGES)
 *
 * raised from `session/attachment-invalid` when
 * `resolveModelInfo(...).inputModalities` does not contain `'image'`. So the
 * question is only what the plugin ADVERTISED for that model.
 *
 * ## Why it happened
 *
 * `multimodal` is stamped by `withImageSelection` from the saved
 * `imageModelIds` array, and `workBuddyModelInput` turns that into
 * `['text']` / `['text','image']`. The array has two writers with different
 * meanings — the user ticking a box (a decision) and a catalog refresh
 * deriving the vendor-verified defaults (a snapshot of that day's roster) —
 * and nothing in it distinguished them. A region refreshed BEFORE a model
 * appeared therefore shipped an array without it, and its absence was read as
 * "the user said no": the model advertised `['text']` while
 * `imageDefaultFor` classified it verified-multimodal.
 *
 * The measured case on the reporter's own profile: `imageModelIds` for cn held
 * exactly `deepseek-v4.1-flash, glm-5.3-flash, kimi-k3-1` with no
 * `imageSelectionExplicit`, while the roster had since gained
 * `minimax-m3`, `kimi-k2.6`, `kimi-k2.8-preview` and
 * `hy3-x` — none of them markable, all of them stuck at `['text']`.
 *
 * ## What is pinned
 *
 * The ADVERTISED modality, read through `ctx.llm.resolveModelInfo` — the same
 * surface the host's own attachment admission reads. A unit test of
 * `effectiveImageIds` would pass while the stamping sites still passed the raw
 * array, which is precisely the shape that shipped.
 *
 * The other half of the fix is the flag: once the user has SAVED a selection,
 * unticking a verified-multimodal model must stick. A seed that always wins
 * would be a worse bug than the one being fixed.
 */

class MemorySettings extends Service {
  constructor(ctx: Context) { super(ctx, 'settings') }
  configure() { return () => {} }
  describe() {
    return [{ ns: WorkBuddy.WORKBUDDY_SETTINGS_NS, autoGenerate: true, revision: 0, applies: 'live', value: liveConfig }]
  }
  async update(ns: string, patch: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(patch)) {
      liveConfig[key] = structuredClone(value)
    }
    ;(context as unknown as { emit(name: string): void })?.emit('loader/volatile-update')
  }
}

let liveConfig: Record<string, unknown> = {}
let context: Context | undefined
afterEach(async () => { await context?.fiber.dispose(); context = undefined; liveConfig = {} })

async function cnAuthFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wb-168-'))
  const dir = join(root, 'auth')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha', enterpriseId: '' },
    auth: {
      accessToken: 'token-alpha', refreshToken: 'refresh-alpha', tokenType: 'Bearer',
      domain: 'www.codebuddy.cn', expiresAt: Date.now() + 86_400_000,
      refreshExpiresAt: Date.now() + 7 * 86_400_000,
    },
  }), 'utf8')
  return join(dir, 'workbuddy-desktop.info')
}

/**
 * The roster: one model the user had ticked (`deepseek-v4.1-flash`), and two
 * the roster gained afterwards. Both newcomers are ids the vendor table
 * classifies as verified-multimodal, so the ONLY thing standing between them
 * and a working image attachment is whether their absence from the stored
 * array is read as a decision.
 *
 * `hy3-x` is deliberately included as the CONTROL: the table does not know it,
 * so it must stay `unknown` → `['text']`. A fix that simply advertised `image`
 * for everything would pass the first two assertions and fail this one.
 */
const CATALOG = [
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'minimax-m3', name: 'MiniMax M3', contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'hy3-x', name: 'Hy3 X', contextWindow: 200_000, maxTokens: 32_000 },
]

async function mount(regionState: Record<string, unknown> = {}): Promise<Context> {
  const authFile = await cnAuthFile()
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemorySettings)
  liveConfig = {
    authFile,
    regions: { cn: { enabled: true, lastCatalog: CATALOG, enabledModelIds: [], ...regionState } },
  }
  WorkBuddy.apply(ctx, liveConfig as WorkBuddy.Config)
  return ctx
}

/** The input modalities DSH would advertise for one model, or `undefined`. */
async function modalitiesOf(ctx: Context, modelId: string): Promise<string[] | undefined> {
  let modalities: string[] | undefined
  await expect.poll(async () => {
    try {
      const resolved = await ctx.llm.resolveModelInfo('workbuddy', modelId)
      modalities = resolved.inputModalities === undefined ? undefined : [...resolved.inputModalities]
      return true
    } catch {
      return false
    }
  }).toBe(true)
  return modalities
}

describe('#168: a verified-multimodal model added after the last refresh advertises images', () => {
  it('advertises image input for a model the stale saved array never contained', async () => {
    // The reporter's exact shape: a ticked set from an older roster, no flag.
    const ctx = await mount({ imageModelIds: ['deepseek-v4.1-flash'] })
    // The model the user HAD ticked keeps working (the baseline; never broken).
    expect(await modalitiesOf(ctx, 'deepseek-v4.1-flash')).toContain('image')
    // And the newcomer is no longer refused by the host's attachment gate.
    expect(await modalitiesOf(ctx, 'minimax-m3')).toContain('image')
    expect(await modalitiesOf(ctx, 'kimi-k2.6')).toContain('image')
  })

  it('does NOT guess for an id the vendor table does not classify', async () => {
    // The control. This is the line that keeps the fix from becoming "advertise
    // images for the whole roster", which is the mistake `docs/DESIGN.md`
    // records the project making once already.
    const ctx = await mount({ imageModelIds: ['deepseek-v4.1-flash'] })
    expect(await modalitiesOf(ctx, 'hy3-x')).toEqual(['text'])
  })

  it('honours a SAVED selection, including an explicit untick', async () => {
    // `imageSelectionExplicit` is what separates "seeded" from "decided". A user
    // who unticks a verified-multimodal model has made a judgement (they may
    // know this account/region refuses images for it), and re-seeding would
    // silently undo it — a worse defect than the one fixed above.
    const ctx = await mount({
      imageSelectionExplicit: true,
      imageModelIds: ['harness-only'],
    })
    expect(await modalitiesOf(ctx, 'deepseek-v4.1-flash')).toEqual(['text'])
    expect(await modalitiesOf(ctx, 'minimax-m3')).toEqual(['text'])
  })

  it('still serves an explicitly ticked model the table knows as text', async () => {
    // The reverse direction: an explicit tick is honoured even where the vendor
    // table disagrees. This is what "the user can always tick a box by hand"
    // means, and it shows the flag does not merely re-enable the table.
    const ctx = await mount({
      imageSelectionExplicit: true,
      imageModelIds: ['hy3-x'],
    })
    expect(await modalitiesOf(ctx, 'hy3-x')).toContain('image')
    // An unticked verified-multimodal model stays text under the same flag.
    expect(await modalitiesOf(ctx, 'deepseek-v4.1-flash')).toEqual(['text'])
  })
})
