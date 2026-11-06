// @vitest-environment jsdom
/**
 * The CAPABILITIES section, measured rather than eyeballed.
 *
 * Why this exists beside `section-shot.tsx`: that tool answers "does the page
 * fit in the 564px Settings column", which is a question about the whole
 * section. This one answers the questions the capabilities panel raises on its
 * own, and they are all things a screenshot cannot settle:
 *
 *   1. Do the six groups agree on their LEFT edge? The section mixes a bordered
 *      card (the CN gateway, added in 5.20.0) with five groups of plain
 *      checkbox rows, and a card that insets itself differently from the rows
 *      beside it reads as a different column.
 *   2. Do they agree on the VERTICAL rhythm? `.dsm-workbuddy-prefs` gap,
 *      `.dsm-workbuddy-pref` line spacing, and the paddings around the card are
 *      three independent numbers that must not accidentally disagree.
 *   3. Is the checkbox optically aligned with the first line of its own label?
 *      A 15px box beside an 18px line box needs a nudge, and the nudge is
 *      per-class — five classes carry a checkbox in this card.
 *   4. How much height does the section spend before the first CONTROL, and how
 *      much of that is prose? The page is read top-down and the controls are
 *      what it exists for.
 *   5. Does anything overflow its box at this width (a long hint sentence, the
 *      gateway input, a label with a long model id in it)?
 *
 *   pnpm section:shot
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless=new --hide-scrollbars --window-size=1000,1400 \
 *     --screenshot=/tmp/wb-caps-shot.png file:///tmp/wb-caps-preview.html
 *
 * The measurements are printed at the bottom of the page as
 * `<pre id="audit">`; read them back with --dump-dom.
 *
 * The preview isolates the capabilities panel (the other panels are hidden) so
 * the section's own rhythm can be measured without the account table's height
 * pushing it off-screen. Hiding siblings does not change the panel's own layout:
 * it is a flex child of one column, not positioned against them.
 */
import { describe, it } from 'vitest'
import { writeFileSync } from 'node:fs'

function usageDocument(): Record<string, unknown> {
  // Real windows, because the context-budget select's OPTIONS are derived from
  // them: a fixture without `nativeContextWindow` renders the control with a
  // single "unknown" option, which shows the widget's shape but not its content.
  // Three different windows on purpose — one at the only-tier case, one that
  // offers 200K + native, one that offers all three.
  const models = [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', creditMultiplier: 0, nativeContextWindow: 1_000_000 },
    { id: 'glm-5.2', name: 'GLM-5.2', creditMultiplier: 0.79, nativeContextWindow: 500_000 },
    { id: 'hy3', name: 'Hunyuan3', creditMultiplier: 0.4, nativeContextWindow: 192_000 },
  ]
  return {
    status: 'signed-in',
    accountId: 'acc-1',
    accountName: '用户7520607992',
    region: 'cn',
    domain: 'www.workbuddy.cn',
    tokenExpiresAtMs: Date.now() + 3_600_000,
    refreshExpiresAtMs: Date.now() + 10 * 86_400_000,
    selectionExplicit: true,
    enabled: true,
    accounts: [{ accountId: 'acc-1', accountName: '用户7520607992' }],
    models,
    enabledModelIds: models.map(model => model.id),
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 2542.57, expiringSoon: 0, packages: [] },
    checkin: { checkedIn: false, enabled: true },
  }
}

/**
 * Which tab to render.
 *
 * The tool started as "capabilities", and the panel under review changes faster
 * than the file name does: the model list needed the same fixture (real 564px
 * column, real tokens, real typography) to judge a control that had just changed
 * shape. Keeping one fixture with a switchable tab is what stops the next review
 * from growing a third near-identical copy of this file.
 */
const PANEL = process.env['WB_SHOT_PANEL'] ?? 'capabilities'

const TOKENS = `
:root{
  --dsw-alias-label-primary:#0f1115;
  --dsw-alias-label-secondary:#4b5058;
  --dsw-alias-label-tertiary:#8b9099;
  --dsw-alias-label-dimmed:#b0b5bd;
  --dsw-alias-border-l1:rgba(15,17,21,.08);
  --dsw-alias-border-l2:rgba(15,17,21,.16);
  --dsw-alias-bg-base:#f0f1f3;
  --dsw-alias-bg-layer-1:#ffffff;
  --dsw-alias-bg-layer-2:#ffffff;
  --dsw-alias-bg-layer-3:#f6f7f9;
  --dsw-alias-brand-primary:#1b1c1e;
  --dsw-alias-interactive-bg-hover:rgba(15,17,21,.05);
  --dsw-alias-state-success-primary:#15803d;
  --dsw-alias-state-warn-primary:#b45309;
  --dsw-alias-state-error-primary:#b91c1c;
}
html,body{margin:0;background:#eceef1;font-family:-apple-system,"PingFang SC",system-ui,sans-serif;color:#0f1115}
/* The real Settings shell: 800px panel, 188px nav rail, .options column with
   0 24px 24px padding, so this plugin gets 564px. Same numbers as
   section-shot.tsx — a different fixture would measure a width no user has. */
.dialog{box-sizing:border-box;width:800px;height:1400px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;
  display:grid;grid-template:"title header" "nav options" minmax(0,1fr)/188px minmax(0,1fr)}
.dialog-title{grid-area:title;padding:22px 12px 8px 24px;font-size:16px;font-weight:500;line-height:24px}
.dialog-header{grid-area:header;height:54px;padding:20px 14px 8px 10px;text-align:right;font-size:13px;color:#8b9099}
.dialog-nav{grid-area:nav;display:flex;flex-direction:column;gap:4px;padding:10px 12px 0}
.dialog-nav i{display:block;height:40px;border-radius:8px;padding:9px 16px 9px 12px;font-style:normal;font-size:14px;line-height:22px}
.dialog-nav i.on{background:rgba(15,17,21,.06)}
.dialog-body{grid-area:options;min-width:0;min-height:0;padding:0 24px 24px;overflow-y:auto}
`

const AUDIT = `
<script>
window.__WB_PANEL__ = '${PANEL}'
addEventListener('load', () => {
  const out = {}
  const r = el => el.getBoundingClientRect()
  const box = el => { const b = r(el); return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) } }
  const cs = (el, p) => getComputedStyle(el).getPropertyValue(p).trim()
  const panel = document.querySelector('#dsm-workbuddy-panel-' + (window.__WB_PANEL__ || 'capabilities'))
  out.panel = panel ? box(panel) : null

  /* (1) THE LEFT EDGE of everything that is a "group" in this panel.
     A bordered card that insets itself differently from the plain rows beside it
     reads as a separate column; this is the number that decides whether it does. */
  const groups = []
  for (const el of panel ? panel.children : []) {
    groups.push({ cls: el.className || el.tagName.toLowerCase(), ...box(el), padL: cs(el,'padding-left'), border: cs(el,'border-top-width') + ' ' + cs(el,'border-left-width') })
  }
  out.groups = groups

  /* (2) THE VERTICAL RHYTHM: the gap between every pair of siblings, which is
     where an accidental 14 vs 16 disagreement shows up. */
  out.gaps = []
  for (let i = 1; i < (panel ? panel.children.length : 0); i += 1) {
    const prev = panel.children[i - 1], cur = panel.children[i]
    out.gaps.push({ from: prev.className || prev.tagName, to: cur.className || cur.tagName, gap: Math.round(r(cur).top - r(prev).bottom) })
  }

  /* (3) CHECKBOX ALIGNMENT: the box against the first line of its own label.
     Reported as the delta between the box's optical centre and the centre of the
     label's first line; anything beyond ~1.5px reads as "floating". */
  out.checks = Array.from(panel ? panel.querySelectorAll('input[type=checkbox]') : []).map(input => {
    const label = input.closest('label')
    const text = label ? label.querySelector('.dsm-workbuddy-pref-label') : null
    const ib = r(input), tb = text ? r(text) : null
    return {
      cls: input.className,
      top: Math.round(ib.top), size: Math.round(ib.width),
      labelTop: tb ? Math.round(tb.top) : null,
      /* Positive = the box starts ABOVE the label's first line. */
      offset: tb ? Math.round(tb.top - ib.top) : null,
      marginTop: cs(input, 'margin-top'),
    }
  })

  /* (4) HEIGHT SPENT BEFORE THE FIRST CONTROL. */
  const firstControl = Array.from(panel ? panel.querySelectorAll('input,button') : [])
    .find(el => { const b = r(el); return b.width > 0 && b.height > 0 })
  out.firstControl = firstControl ? { ...box(firstControl), cls: String(firstControl.className).slice(0, 40) } : null
  out.chromeAboveControl = firstControl && panel ? Math.round(r(firstControl).top - r(panel).top) : null

  /* (5) OVERFLOW at this width: content wider than its own box. */
  out.overflowing = (panel ? Array.from(panel.querySelectorAll('*')) : []).filter(el => {
    const s = getComputedStyle(el)
    if (s.overflowX === 'visible' && s.textOverflow !== 'ellipsis') return false
    return el.scrollWidth > el.clientWidth + 1
  }).map(el => ({ cls: String(el.className).slice(0, 46), text: (el.textContent || '').trim().slice(0, 40), scrollW: el.scrollWidth, clientW: el.clientWidth }))

  /* Inputs and their boxes: the gateway field is the only text input here, and
     its width is the one dimension the user actually notices. */
  out.inputs = Array.from(panel ? panel.querySelectorAll('.dsm-workbuddy-cnbase-input') : []).map(el => ({ ...box(el), font: cs(el,'font-size') }))

  /* Every distinct vertical gap between consecutive BLOCKS inside each group,
     so "the card is roomier than the rows" is a number rather than an opinion. */
  out.groupInner = Array.from(panel ? panel.querySelectorAll('.dsm-workbuddy-prefs, .dsm-workbuddy-cnbase') : []).map(g => ({
    cls: String(g.className).slice(0, 40),
    gap: cs(g, 'gap'), padTop: cs(g, 'padding-top'), count: g.children.length,
    box: box(g),
  }))

  const pre = document.createElement('pre')
  pre.id = 'audit'
  pre.textContent = 'AUDIT' + JSON.stringify(out, null, 1)
  document.body.appendChild(pre)
})
</script>`

describe('section shot', () => {
  it('writes the html', async () => {
    const { mount, stubFetch, t } = await import('../tests/pool-render-helpers.tsx')
    const { WorkBuddyCard } = await import('../src/client/WorkBuddyCard.tsx')
    const { WORKBUDDY_CARD_CSS } = await import('../src/client/styles.ts')
    const { zh } = await import('../src/client/locales.ts')

    const translate = ((key: string, params?: Record<string, unknown>) => {
      const raw = (zh as Record<string, string>)[key] ?? key
      if (params === undefined) return raw
      return raw.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))
    }) as never

    const settings: Record<string, unknown> = {
      regions: {
        cn: { enabled: true, cnBase: '', showCreditsInMainUi: true, creditPosition: 'composer' },
        global: { enabled: false },
      },
    }
    const scope = {
      getState: () => ({ status: 'ready', value: settings, writable: true }),
      getSnapshot: () => ({ status: 'ready', value: settings, writable: true }),
      subscribe: () => () => {},
      set: async (field: string, next: unknown) => { settings[field] = next; return true },
    }

    // A STATIC innerHTML DUMP LOSES A <select>'s SELECTION.
    //
    // `selectedIndex`/`value` are DOM properties, not attributes, so the dump
    // emits every <option> without `selected` and the preview opens on the first
    // tier — the 1M model looked like it had picked 200K, which reads as a
    // correctness bug in the widget and is entirely an artefact of the dump.
    // Re-stamp the current selection onto the markup before serialising. The
    // widget's real behaviour is asserted in jsdom (see
    // tests/issue215-context-budget-radio.spec.tsx), not here.
    stubFetch(() => ({ body: usageDocument() }))
    const m = await mount(WorkBuddyCard, { t: translate, settingsScope: scope, surface: 'settings' })
    await m.settle()

    /* Show ONLY the capabilities panel. The tab click is what a user performs;
       hiding the two heavier panels keeps the section's rhythm measurable in one
       screenful without changing its own layout (all three are flex children of
       the same column, none is positioned against another). */
    const tab = m.container.querySelector(`#dsm-workbuddy-tab-${PANEL}`)
    if (tab === null) throw new Error(`no tab for panel ${PANEL}`)
    ;(tab as HTMLElement).click()
    await m.settle()

    const ISOLATE = `
<style>
.dsm-workbuddy-page-head,.dsm-workbuddy-tabs,.dsm-workbuddy-tab-hint,.dsm-workbuddy-free-quota-warn{display:none!important}
${['accounts', 'models', 'capabilities', 'diag', 'sdk'].filter(id => id !== PANEL).map(id => `#dsm-workbuddy-panel-${id}`).join(',')}{display:none!important}
/* NOT display:block!important — the panel's own display IS the thing under
   measurement (it is a flex column in 5.20.0). Forcing block here once hid the
   panel's real gap and made the audit report 0 for every block pair. */
#dsm-workbuddy-panel-${PANEL}:not([hidden]){outline:1px dashed rgba(15,17,21,.22);outline-offset:8px}
</style>`

    const dump = m.container.cloneNode(true) as HTMLElement
    // Carry the live selection into the markup (see the note above `stubFetch`).
    for (const [index, select] of Array.from(m.container.querySelectorAll('select')).entries()) {
      const copy = dump.querySelectorAll('select')[index]
      if (copy === undefined) continue
      for (const option of Array.from(copy.options)) option.removeAttribute('selected')
      const chosen = copy.options[select.selectedIndex]
      if (chosen !== undefined) chosen.setAttribute('selected', '')
    }
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${TOKENS}\n${WORKBUDDY_CARD_CSS.replace(/<\/style/gi, '<\\/style')}</style>${ISOLATE}</head><body><div class="dialog"><div class="dialog-title">设置</div><div class="dialog-header">✕</div><div class="dialog-nav"><i>账号</i><i>通用</i><i>模型</i><i class="on">dsh-connect-workbuddy</i></div><div class="dialog-body">${dump.innerHTML}</div></div></body></html>`
    writeFileSync(`/tmp/wb-${PANEL}-preview.html`, html.replace('</body>', `${AUDIT}</body>`))
  })
})
