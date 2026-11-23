/**
 * ISSUE #289 — DSH 0.2.3 made images fail with
 * `Image request maxImageBytes must be a positive integer. (INVALID_ATTACHMENT_REF)`.
 *
 * THE REPORT. From `@deepseek-ai/dsh-llm-pi-ai@0.2.3` the RESOLVED profile
 * gained a required `requestImageBudgetCount` and the per-image cap was renamed
 * (`requestImageMaxBytes` → `maxImageBytes` on the resolved profile). This
 * route hand-builds its resolved profile — it never goes through the host's
 * `resolveProfiles()` — so neither default is filled in for it. The missing
 * divisor made `resolveImageRequestBudget()` compute
 * `maxRequestImageBytes / undefined / 4` → `NaN`, which the attachment layer
 * refused before the image ever reached the model. Only image messages failed;
 * text was fine, which is why it looked like an attachment bug rather than a
 * profile-shape bug.
 *
 * VERIFIED AGAINST THE ACTUAL 0.2.3 PACKAGE (not taken on faith):
 *
 *   `src/image-policy.ts`:
 *     allocated = floor(maxRequestImageBytes / requestImageBudgetCount / 4) * 3
 *     maxImageBytes = min(allocated, profile.maxImageBytes ?? catalogBytes ?? 1MiB)
 *
 *   `src/config.ts` `resolveProfiles()`:
 *     resolved carries `requestImageBudgetCount` (required),
 *     config `requestImageMaxBytes` is mapped to resolved `maxImageBytes`.
 *
 * So the fix must state BOTH spellings of the cap (0.2.2 reads one, 0.2.3 the
 * other) AND the divisor, and the divisor must keep the equal share ABOVE 1 MiB
 * so the explicit cap still decides the exact byte limit.
 *
 * THE TESTS BELOW actually build the adapter's profile and reproduce the
 * 0.2.3 division on it — a missing field yields NaN and goes red, which is the
 * whole defect. They also pin the 0.2.2 field, because the plugin's peer range
 * spans both lines and an "upgrade" that breaks the old host is not a fix.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'

// Same stub the adapter's own spec uses: keep the wiring out of the test.
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({
    stream: () => emptyStream(),
    streamSimple: () => emptyStream(),
  }),
}))
function emptyStream(): AsyncIterable<never> {
  return { [Symbol.asyncIterator]: async function* () { /* no events */ } }
}

/** The resolved profile this route publishes, read off the real adapter. */
async function routeProfile(): Promise<Record<string, unknown>> {
  const { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } = await import('../src/adapter.ts')
  const { WorkBuddyCatalog } = await import('../src/catalog.ts')
  const { adapter } = createWorkBuddyAdapter({
    shim: { baseUrl: () => 'http://127.0.0.1:1', token: async () => 'secret' } as never,
    store: {} as never,
    catalog: new WorkBuddyCatalog(),
  })
  const profile = (adapter as unknown as {
    config: { profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile> }
  }).config.profiles().get(WORKBUDDY_PROVIDER)
  if (profile === undefined) throw new Error('the workbuddy route published no profile')
  return profile as unknown as Record<string, unknown>
}

/**
 * The exact 0.2.3 budget resolution, quoted from the host's image-policy.ts.
 * The `catalogBytes` branch is the model's own resize budget; a model with no
 * resize metadata leaves the explicit per-image cap in charge.
 */
function resolveImageMaxBytes(
  profile: Record<string, unknown>,
  catalogBytes?: number,
): number {
  const total = profile['maxRequestImageBytes'] as number
  const count = profile['requestImageBudgetCount'] as number
  const allocated = Math.floor(total / count / 4) * 3
  return Math.min(
    allocated,
    (profile['maxImageBytes'] as number | undefined) ?? catalogBytes ?? 1_048_576,
  )
}

describe('the resolved profile carries every image budget 0.2.3 requires', () => {
  it('states requestImageBudgetCount as a positive integer', async () => {
    const profile = await routeProfile()
    const count = profile['requestImageBudgetCount']
    expect(Number.isSafeInteger(count)).toBe(true)
    expect(count as number).toBeGreaterThan(0)
  })

  it('states BOTH spellings of the per-image cap', async () => {
    // 0.2.2 reads `requestImageMaxBytes`; 0.2.3 reads `maxImageBytes`. The
    // route hand-builds the resolved profile on both, so it must name both.
    const profile = await routeProfile()
    expect(profile['requestImageMaxBytes']).toBe(1_048_576)
    expect(profile['maxImageBytes']).toBe(1_048_576)
  })

  it('resolves to a POSITIVE 1 MiB cap under the real 0.2.3 formula', async () => {
    // THE REGRESSION. Without the divisor this is NaN — the exact value the
    // old profile produced and the attachment layer rejected as
    // INVALID_ATTACHMENT_REF. Asserted by VALUE, not by "is defined": a
    // nonsense divisor that yields a tiny budget must also go red.
    const profile = await routeProfile()
    expect(resolveImageMaxBytes(profile)).toBe(1_048_576)
  })

  it('keeps the equal share ABOVE the cap, so the divisor never silently narrows it', async () => {
    // 14 is deliberate: floor(20971520 / 14 / 4) * 3 = 1_123_473 > 1 MiB.
    // 15 would yield 1_048_575 — ONE BYTE SHORT of the cap — and would turn
    // the pinned cap into a slightly smaller, invisible one. This assertion
    // is what stops someone "tidying" the divisor to the host default of 20.
    const profile = await routeProfile()
    const total = profile['maxRequestImageBytes'] as number
    const count = profile['requestImageBudgetCount'] as number
    const share = Math.floor(total / count / 4) * 3
    expect(share).toBeGreaterThan(1_048_576)
    expect(share).toBe(1_123_473)
  })

  it('still carries the 0.2.2 fields the older host reads', async () => {
    // The peer range spans 0.1.7 → 0.2.2 → 0.2.3. Adding the new fields must
    // not remove the old ones: 0.2.2 reads `requestImageMaxBytes` directly
    // from this profile and would fall back to its own 1 MiB default only by
    // accident — pinning it keeps the route's byte-identical behaviour.
    const profile = await routeProfile()
    expect(profile['maxRequestImageBytes']).toBe(20_971_520)
    expect(profile['requestImagePixelBudget']).toBe(4_194_304)
    expect(profile['maxRequestImages']).toBe(1_000_000)
    expect(profile['imageOffloadCountQuantum']).toBe(1_000_000)
  })
})
