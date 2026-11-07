// @vitest-environment jsdom
/**
 * Claiming the host's `conversation.input.model.label` cell without colliding —
 * and without coordinating with other plugins.
 *
 * WHY THIS FILE EXISTS. `0.2.1-rc.2` added an official contributor to the very
 * cell this plugin draws its load badge in:
 * `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017`, a client plugin in the
 * web-app bundle that registers the `single` slot at the default priority `0`.
 * This plugin registered at `0` too, and a `single` slot refuses a second claim
 * on one priority — so on 0.2.1-rc.3 the registration THREW and the WorkBuddy
 * badge silently vanished from the picker. The app's own crash log recorded it:
 *
 *     single slot "conversation.input.model.label" already has a
 *     registration at priority 0 (registered by Kb)
 *     [dsh-connect-workbuddy] model label slot failed to register …
 *
 * Nothing surfaced it because the failure is a `console.error` inside a
 * try/catch whose whole point is to keep the host usable — the page looked fine.
 *
 * Two classes of property are pinned here, and the second one is a POLICY, not
 * a workaround:
 *
 * 1. Coexistence — the registration succeeds beside the host's entry, and this
 *    plugin's own rows still get a badge.
 * 2. No inter-plugin coordination — this plugin never reads the slot ledger and
 *    never renders another plugin's component. A foreign row gets the plain
 *    catalog name, which is the slot's documented minimum, even when another
 *    contributor is sitting right there and could have been asked to render it.
 *    See `docs/DESIGN.md` §六 "不做插件联动".
 *
 * The tests run the REAL `SlotCore` from `@deepseek-ai/dsh-client-ui-slots`
 * (installed at 0.1.7-rc.1, whose collision message is byte-identical to
 * rc.3's), so the same-priority rejection under test is genuine, not a stub.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { MODEL_LABEL_PRIORITY, resetBusyLevelCache, WorkBuddyModelLabel } from '../src/client/WorkBuddyModelLabel.tsx'
import { mount } from './pool-render-helpers.tsx'

const SLOT = 'conversation.input.model.label'

afterEach(() => {
  vi.unstubAllGlobals()
  resetBusyLevelCache()
})

/** A minimal usage body: signed in, one model, one load level. */
function usage(): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'cn-1', accountName: 'cn One' }],
    models: [{ id: 'model-a', name: 'Model A' }],
    enabledModelIds: ['model-a'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 20, expiringSoon: 0, packages: [] },
    busyLevels: { 'model-a': 'congested' },
  }
}

/**
 * Somewhere a plugin goes to claim a cell.
 *
 * `SlotCore` is keyed by a `SlotMap` that each plugin package augments, so from
 * this repo's type position the label key is not declared and the generic
 * `register` resolves `name` to `never`. The runtime behaviour — the entire
 * subject of this file — does not care: the key is a plain string. This facade
 * keeps the REAL `SlotCore` underneath and narrows only the typing.
 */
interface ClaimableSlot {
  register(options: { name: string, priority?: number, locale?: string }, component: unknown): () => void
  entries(key: string): readonly {
    component: unknown
    options: { priority?: number }
    locale?: string
  }[]
  entriesOfSlot(key: string): readonly { component: unknown }[]
}

/**
 * The host's own badge, copied from the published plugin so the test exercises
 * the real shape: it declares `locale`, reads `t('badge.label')`, and returns a
 * plain STRING for rows it does not recognise.
 */
function Host1017Label(props: {
  provider: { id: string, name: string }
  model: { id: string, name: string }
  t?: (key: string) => string
}): string {
  const { provider, model, t } = props
  const isFlash = (provider.id === 'deepseek-account' || provider.id === 'deepseek-official')
    && model.id === 'deepseek-flash'
  if (!isFlash) return model.name
  return `${model.name} [${t?.('badge.label') ?? ''}]`
}

/** A single-cell slot declared like the host's, so `SlotCore` enforces the rule. */
function core(): ClaimableSlot {
  const slotCore = new SlotCore()
  // Declare the cell first: `root` carries it as a CHILD table, which is a
  // declaration, not a claim, so no priority applies here.
  ;(slotCore as unknown as {
    register(options: { name: string, children: Record<string, { kind: string, scope: string }> }, component: unknown): void
  }).register({ name: 'root', children: { [SLOT]: { kind: 'single', scope: 'session' } } }, () => null)
  return slotCore as unknown as ClaimableSlot
}

/** The props the picker hands to whatever wins the cell. */
function row(providerId: string, model: { id: string, name: string, badge?: { text: string | Record<string, string>, tone: 'neutral' | 'info' | 'success' | 'warning' } }): {
  provider: { id: string, name: string }
  model: { id: string, name: string, badge?: { text: string | Record<string, string>, tone: 'neutral' | 'info' | 'success' | 'warning' } }
  placement: 'trigger' | 'menu'
  selected: false
} {
  return {
    provider: { id: providerId, name: providerId },
    model,
    placement: 'menu',
    selected: false,
  }
}

/**
 * The component that actually renders the cell, failing loudly if the slot
 * resolved to nothing — a silently empty cell is the exact defect under test.
 */
function winnerOf(slotCore: ClaimableSlot): (props: unknown) => unknown {
  const cell = slotCore.entriesOfSlot(SLOT)[0]
  if (cell === undefined) throw new Error('the model-label cell resolved to no winner')
  return cell.component as (props: unknown) => unknown
}

describe('claiming the model-label cell beside the host\'s own contributor', () => {
  it('registers instead of throwing when the host already holds priority 0', () => {
    // This is the rc.2+ world: the host's badge is already at the default 0.
    const slotCore = core()
    slotCore.register({ name: SLOT, locale: 'deepseek-model-label-1017' }, Host1017Label)

    // THE REGRESSION: at priority 0 this call threw, and the plugin's catch-all
    // turned a lost badge into a console line nobody reads.
    expect(() => slotCore.register({ name: SLOT, priority: MODEL_LABEL_PRIORITY }, WorkBuddyModelLabel))
      .not.toThrow()

    // Both contributions are on the ledger — nothing was displaced — and the
    // cell still resolves to exactly one winner.
    expect(slotCore.entries(SLOT)).toHaveLength(2)
    expect(slotCore.entriesOfSlot(SLOT)).toHaveLength(1)
  })

  it('WINS the cell against every contributor that competes for it', () => {
    // WAS "picks a priority that collides with neither the host nor qoder", and
    // that assertion is why the real defect survived several rounds: "distinct"
    // was mistaken for "sufficient". `-0.5` was distinct from `0` and from `-1`,
    // passed this test, and still LOST — because the cell renders its LOWEST
    // priority, and qoder registers at `-1`.
    //
    // Losing is silent: the winner renders, the loser is simply not called. So
    // the only assertion worth making is that this plugin ENDS UP the winner.
    const slotCore = core()
    slotCore.register({ name: SLOT, priority: 0 }, Host1017Label)
    // A plausible future contributor that undercuts anything in single digits.
    slotCore.register({ name: SLOT, priority: -10 }, () => 'brand')
    // The REAL current competitors, with the values they actually ship as of
    // 2026-11. These are not hypotheticals: qoder and trae both lowered their
    // priority in response to ours, and both cite this plugin's shipped value in
    // their source comments. Pinning the shipped numbers is what makes this test
    // fail the day a fourth connector steps under us, instead of quietly losing
    // the cell again.
    slotCore.register({ name: SLOT, priority: -101 }, () => 'qoder')
    slotCore.register({ name: SLOT, priority: -102 }, () => 'trae')

    expect(() => slotCore.register({ name: SLOT, priority: MODEL_LABEL_PRIORITY }, WorkBuddyModelLabel))
      .not.toThrow()

    // The claim itself: ours sorts first, so ours is what the picker renders.
    const order = slotCore.entries(SLOT).map(entry => entry.options.priority ?? 0)
    expect(order[0], `entries=${order.join(',')}`).toBe(MODEL_LABEL_PRIORITY)
    expect(winnerOf(slotCore)).toBe(WorkBuddyModelLabel)
  })

  it('still decorates a WorkBuddy row', () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => usage(),
    }))
    const slotCore = core()
    slotCore.register({ name: SLOT, locale: 'deepseek-model-label-1017' }, Host1017Label)
    slotCore.register({ name: SLOT, priority: MODEL_LABEL_PRIORITY }, WorkBuddyModelLabel)

    const winner = winnerOf(slotCore) as typeof WorkBuddyModelLabel
    const markup = renderToStaticMarkup(winner(row('workbuddy', { id: 'model-a', name: 'Model A' })))
    expect(markup).toContain('Model A')
    expect(markup).toContain('dsm-workbuddy-model-label')
  })
})

/**
 * The project invariant: this plugin does not coordinate with other plugins.
 *
 * These are not stylistic preferences. Rendering another plugin's component
 * means standing in for the renderer that would have synthesized its props —
 * notably its `t` seat, which is derived from that entry's `locale` declaration.
 * Doing that wrong threw, and doing it right meant reading the ledger and
 * chaining through another plugin's own delegation, which was measured to
 * recurse (`RangeError: Maximum call stack size exceeded`) when qoder handed a
 * row back. The trade-off is accepted and documented instead.
 */
describe('no inter-plugin coordination (project invariant)', () => {
  it('renders the plain catalog name for a foreign row that carries no badge', () => {
    // `model.name` is the slot's documented minimum for an entry that declines
    // to decorate, and a model whose provider published no badge is exactly
    // that case. Note it renders SOMETHING (<span>), which is why the old
    // comment's "renders nothing at all" was wrong: occupancy comes from
    // registration, not from output, so even `null` would not have freed the
    // cell.
    const slotCore = core()
    slotCore.register({ name: SLOT, locale: 'deepseek-model-label-1017' }, Host1017Label)
    slotCore.register({ name: SLOT, priority: MODEL_LABEL_PRIORITY }, WorkBuddyModelLabel)

    const winner = winnerOf(slotCore) as typeof WorkBuddyModelLabel
    const markup = renderToStaticMarkup(winner(row('deepseek-official', {
      id: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
    })))
    expect(markup).toBe('<span>DeepSeek-V4.1-Flash</span>')
    // Specifically: no attempt to hand the row to the host's contributor.
    expect(markup).not.toContain('1017')
  })

  /**
   * The half that makes sibling chips survive (issue #138's real fix).
   *
   * A sibling plugin publishes its badge in ITS `adapter.listModels()`; the host
   * carries it in the catalog and spreads it into these props. Because the cell
   * is `single`, the host's own badge fallback never runs while this plugin
   * holds it — so this component MUST draw the chip or it is drawn nowhere. The
   * data is host catalog data, not another plugin's component, which is what
   * keeps this out of the coordination `docs/DESIGN.md` §零 rules out.
   */
  it('reproduces a foreign model\'s own catalog badge', () => {
    const slotCore = core()
    slotCore.register({ name: SLOT, priority: MODEL_LABEL_PRIORITY }, WorkBuddyModelLabel)

    const winner = winnerOf(slotCore) as typeof WorkBuddyModelLabel
    const markup = renderToStaticMarkup(winner(row('deepseek-official', {
      id: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
      badge: { text: '限时免费', tone: 'success' },
    })))
    expect(markup).toContain('限时免费')
    expect(markup).toContain('DeepSeek-V4.1-Flash')
    expect(markup).toContain('dsm-workbuddy-model-label-host-badge')
    // Menu rows put the chip AFTER the name, exactly like the host's fallback.
    expect(markup.indexOf('DeepSeek-V4.1-Flash')).toBeLessThan(markup.indexOf('限时免费'))
  })

  it('wraps a foreign badge in the same flex row this plugin uses for its own', () => {
    // The vertical POSITION of the chip is a layout fact, not a text fact: a
    // bare `<span>{chip} {name}</span>` aligns the pill on the text baseline,
    // and because the pill is itself `inline-flex` its baseline comes from its
    // inner text, so it rides visibly higher than on a flex row. WorkBuddy's
    // own rows use `.dsm-workbuddy-model-label` (inline-flex + align-items
    // center), and the host's own fallback uses the equivalent `.badgedName`.
    // Both branches must therefore share ONE alignment model — this test pins
    // the wrapper, because the order-only assertions above cannot see it.
    const slotCore = core()
    slotCore.register({ name: SLOT, priority: MODEL_LABEL_PRIORITY }, WorkBuddyModelLabel)
    const winner = winnerOf(slotCore) as typeof WorkBuddyModelLabel

    for (const placement of ['trigger', 'menu', 'option'] as const) {
      const markup = renderToStaticMarkup(winner({
        ...row('deepseek-official', {
          id: 'deepseek-flash',
          name: 'DeepSeek-V4.1-Flash',
          badge: { text: '夜间折扣', tone: 'info' },
        }),
        placement,
      }))
      // The chip must sit INSIDE the flex wrapper, not beside it.
      expect(markup).toMatch(/^<span class="dsm-workbuddy-model-label dsm-workbuddy-model-label-host-row">.*<\/span>$/)
      // And the chip and the name are separate children, never one text node
      // joined by a space (which is what baseline alignment looked like).
      expect(markup).toContain('dsm-workbuddy-model-label-host-badge')
    }
  })

  it('draws the badge on the SAME side of the name on own rows and foreign rows', async () => {
    // The defect this pins: each branch had its own ordering code, so one open
    // menu showed "chip name" for another provider's model and "name chip" for
    // this plugin's own. A user cannot learn a rule that changes per row, and it
    // reads as a rendering bug. Asserting the two branches against EACH OTHER —
    // rather than each against a hard-coded expected string — is what makes a
    // future divergence fail here instead of in a screenshot.
    //
    // The own row fetches its snapshot in an effect, so this one is MOUNTED, not
    // statically rendered: under `renderToStaticMarkup` effects never run and the
    // own row would have no chip to compare.
    const slotCore = core()
    slotCore.register({ name: SLOT, priority: MODEL_LABEL_PRIORITY }, WorkBuddyModelLabel)
    const winner = winnerOf(slotCore) as typeof WorkBuddyModelLabel

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ...usage(),
        models: [{
          id: 'model-a',
          name: 'Model A',
          promos: [{
            id: 'night-discount',
            source: 'promotion',
            modelIds: ['model-a'],
            badge: { label: '夜间折扣', shortLabel: '夜间', color: '#009273' },
            schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '00:00', end: '24:00' }] },
            priority: 5,
          }],
        }],
      }),
    }))

    // `placement: 'menu'` makes the own row COMPACT, so its chip uses the
    // upstream's short wording ("夜间") rather than the full label ("夜间折扣").
    // The comparison below therefore keys on a token both wordings contain.
    const ownView = await mount(winner, row('workbuddy', { id: 'model-a', name: 'Model A' }))
    await ownView.settle()
    const own = ownView.html()
    await ownView.unmount()

    const foreign = renderToStaticMarkup(winner(row('deepseek-official', {
      id: 'model-b',
      name: 'Model B',
      badge: { text: '夜间', tone: 'info' },
    })))

    for (const [label, markup] of [['own', own], ['foreign', foreign]] as const) {
      const nameAt = markup.indexOf('Model ')
      const chipAt = markup.indexOf('夜间')
      // Both must exist; a missing chip would make the comparison meaningless.
      expect(nameAt, `${label} row has no name`).toBeGreaterThanOrEqual(0)
      expect(chipAt, `${label} row has no chip`).toBeGreaterThanOrEqual(0)
      expect(nameAt, `${label} row draws the chip before the name`).toBeLessThan(chipAt)
    }
  })

  it('puts the badge AFTER the name on every placement, including the trigger', () => {
    // This deliberately DIFFERS from the host's own fallback, which moves the
    // badge before the name on the trigger. Following the host produced two
    // orders in one open menu — "chip name" for other providers' rows and
    // "name chip" for this plugin's own — because this plugin's own rows never
    // swapped. One order for every row is the rule now; see
    // `docs/MODEL-LABEL-SPEC.md`.
    const slotCore = core()
    slotCore.register({ name: SLOT, priority: MODEL_LABEL_PRIORITY }, WorkBuddyModelLabel)

    const winner = winnerOf(slotCore) as typeof WorkBuddyModelLabel
    const props = row('deepseek-official', {
      id: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
      badge: { text: '夜间折扣', tone: 'info' },
    })
    for (const placement of ['trigger', 'menu', 'option'] as const) {
      const markup = renderToStaticMarkup(winner({ ...props, placement }))
      expect(markup.indexOf('DeepSeek-V4.1-Flash')).toBeLessThan(markup.indexOf('夜间折扣'))
    }
  })

  it('resolves a translated badge in the reader\'s language, falling back to en', () => {
    const slotCore = core()
    slotCore.register({ name: SLOT, priority: MODEL_LABEL_PRIORITY }, WorkBuddyModelLabel)
    const winner = winnerOf(slotCore) as typeof WorkBuddyModelLabel
    const badge = { text: { en: 'Free', zh: '限时免费' }, tone: 'success' as const }

    vi.stubGlobal('navigator', { language: 'zh-CN' })
    expect(renderToStaticMarkup(winner(row('deepseek-official', { id: 'm', name: 'M', badge }))))
      .toContain('限时免费')

    // A language with no entry falls back to the required English one.
    vi.stubGlobal('navigator', { language: 'fr' })
    expect(renderToStaticMarkup(winner(row('deepseek-official', { id: 'm', name: 'M', badge }))))
      .toContain('Free')
  })

  it('survives a navigator that exists but carries no language', () => {
    // `navigator.language` is not guaranteed even when `navigator` is defined:
    // embedded webviews and stubbed environments both yield `undefined`, and the
    // badge resolver lower-cases it. An exception here would retire this
    // component and cost EVERY row its decoration, which is the one outcome the
    // foreign-row branch must never produce.
    const slotCore = core()
    slotCore.register({ name: SLOT, priority: MODEL_LABEL_PRIORITY }, WorkBuddyModelLabel)
    const winner = winnerOf(slotCore) as typeof WorkBuddyModelLabel
    const badge = { text: { en: 'Free', zh: '限时免费' }, tone: 'success' as const }

    vi.stubGlobal('navigator', {})
    expect(() => renderToStaticMarkup(
      winner(row('deepseek-official', { id: 'm', name: 'M', badge })),
    )).not.toThrow()
    // With no language to match, the required English text is still drawn.
    expect(renderToStaticMarkup(winner(row('deepseek-official', { id: 'm', name: 'M', badge }))))
      .toContain('Free')
  })

  it('falls back to neutral colours for a tone it does not own', () => {
    // A bare index into the tone table walks the prototype chain, so
    // `tone: 'constructor'` returns a FUNCTION that `??` accepts — the chip
    // then renders with no colour at all. The host does not validate `tone`,
    // so these values can genuinely arrive from another adapter.
    const slotCore = core()
    slotCore.register({ name: SLOT, priority: MODEL_LABEL_PRIORITY }, WorkBuddyModelLabel)
    const winner = winnerOf(slotCore) as typeof WorkBuddyModelLabel

    for (const tone of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const markup = renderToStaticMarkup(winner(row('deepseek-official', {
        id: 'm',
        name: 'Model M',
        badge: { text: 'X', tone } as never,
      })))
      expect(markup).toContain('color:var(--dsw-alias-label-secondary)')
    }
  })

  it('draws no chip rather than an empty one when the badge says nothing readable', () => {
    // A blank chip is a decoration that says nothing; the bare name is honest.
    // This is stricter than the host's own resolver, which returns an empty
    // string verbatim — see `docs/MODEL-LABEL-SPEC.md`.
    const slotCore = core()
    slotCore.register({ name: SLOT, priority: MODEL_LABEL_PRIORITY }, WorkBuddyModelLabel)
    const winner = winnerOf(slotCore) as typeof WorkBuddyModelLabel

    for (const text of ['', '   ', { en: '' }, { zh: '有译文但没有 en' }] as const) {
      const markup = renderToStaticMarkup(winner(row('deepseek-official', {
        id: 'm',
        name: 'Model M',
        badge: { text, tone: 'info' },
      })))
      expect(markup).toBe('<span>Model M</span>')
    }
  })

  it('does not throw on a badge shape it has never seen', () => {
    // An exception here retires this WHOLE component from the cell (the host's
    // `entriesOfSlot` skips abdicated entries and the next registrant takes
    // over), so a malformed sibling badge must never cost us every row.
    const slotCore = core()
    slotCore.register({ name: SLOT, priority: MODEL_LABEL_PRIORITY }, WorkBuddyModelLabel)
    const winner = winnerOf(slotCore) as typeof WorkBuddyModelLabel

    for (const badge of [
      { text: null, tone: 'info' },
      { text: 42, tone: 'info' },
      { text: { en: 'x' }, tone: 'chartreuse' },
      { tone: 'info' },
      // The badge ITSELF being null, and not an object at all. The host's 0.2.2
      // normalization already filters these out, so this cannot arrive from a
      // well-behaved host today — but an exception here retires the component
      // and costs EVERY row, so the component must not depend on the host's
      // current filtering to stay alive.
      null,
      undefined,
      'oops',
      42,
      ['a'],
    ]) {
      expect(() => renderToStaticMarkup(winner(row('deepseek-official', {
        id: 'm',
        name: 'Model M',
        badge: badge as never,
      })))).not.toThrow()
    }
  })

  it('does not read the slot ledger or call another plugin\'s component', () => {
    // A structural guard, because the behaviour above would also hold if the
    // forwarding simply happened to fail. Reading `slots.entries(...)` at all is
    // the thing this project refuses to do in its own label path.
    const source = readFileSync(join(process.cwd(), 'src/client/WorkBuddyModelLabel.tsx'), 'utf8')
    expect(source).not.toMatch(/\.entries\s*\(/)
    expect(source).not.toMatch(/createElement\s*\(\s*[A-Z]/)
    expect(source).not.toMatch(/locale\s*\.\s*bind/)
  })

  it('declares only its own priority, never another plugin\'s', () => {
    // The registration is self-contained: a name and our own constant. No
    // probing, no negotiation, nothing that would break if another contributor
    // changed its mind about priorities.
    const source = readFileSync(join(process.cwd(), 'src/client/index.tsx'), 'utf8')
    const registration = /register\(\s*\{\s*name: 'conversation\.input\.model\.label',\s*priority: MODEL_LABEL_PRIORITY\s*\}/.exec(source)
    expect(registration).not.toBeNull()
    // And nothing in the label path enumerates other registrants.
    expect(source).not.toMatch(/slots\.entries\s*\(/)
  })
})
