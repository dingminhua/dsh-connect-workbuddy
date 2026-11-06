// @vitest-environment jsdom
/**
 * The `settings.section` page, rendered with REAL zh strings into
 * /tmp/wb-section-preview.html so its geometry can be MEASURED rather than
 * guessed.
 *
 * Ported from `dsh-connect-trae`'s `tools/section-shot.tsx`, which exists for
 * the same reason this one does: since 5.19.0 this card's primary home is the
 * Settings panel, whose content column is **564px** on a 1400px screen
 * (800px panel − 188px nav rail − 48px padding). Every breakpoint in
 * `styles.ts` measures the VIEWPORT, and the viewport there is 1400px, so none
 * of them fire. The whole card is therefore laid out at a width no browser
 * window on this machine ever has, and the only way to see what that does is to
 * reproduce the shell and measure it.
 *
 * The questions this answers, none of which a jsdom spec can (jsdom does not
 * lay out):
 *
 *  1. how wide is each pool-table cell at 564px, and where does text clip?
 *  2. how tall is one row, and how much of that height is a cell that wrapped?
 *  3. how many pixels sit above the first actionable control?
 *  4. does the table's `@container` narrow form actually fire at this width?
 *
 *   pnpm section:shot
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless=new --hide-scrollbars --window-size=1000,900 \
 *     --screenshot=/tmp/wb-section-shot.png file:///tmp/wb-section-preview.html
 *
 * Read the measurements back (they are also embedded as `<pre id="audit">`):
 *
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless=new --window-size=1000,900 --dump-dom \
 *     file:///tmp/wb-section-preview.html | sed -n 's/.*<pre id="audit">//p'
 *
 * Lives in `tools/` (NOT `tests/`) for the same reason the sibling shots do: it
 * writes a file and needs a real browser to measure anything, so it is a manual
 * tool. `pnpm test` must never collect it — a permanently skipped test makes
 * every run report "1 skipped" and the green result stops meaning "everything
 * ran".
 */
import { describe, it } from 'vitest'
import { writeFileSync } from 'node:fs'

function usageDocument(): Record<string, unknown> {
  const models = [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', creditMultiplier: 0 },
    { id: 'glm-5.2', name: 'GLM-5.2', creditMultiplier: 0.79 },
    { id: 'kimi-k3', name: 'Kimi-K3', creditMultiplier: 1.2 },
  ]
  const accounts = [
    {
      accountId: 'acc-1',
      accountName: '账号A',
      current: true,
      member: true,
      credits: 1620.37,
      expiringSoon: 1200,
      nearestExpiryMs: Date.now() + 4 * 86_400_000,
      checkedInToday: true,
      probe: {
        outcome: 'ok',
        atMs: Date.now() - 3 * 3_600_000,
        source: 'test-batch',
        modelId: 'deepseek-v4.1-flash',
      },
    },
    {
      accountId: 'acc-2',
      accountName: 'LaoDing',
      current: false,
      member: true,
      credits: 834,
      checkedInToday: false,
      probe: {
        outcome: 'rate-limited',
        atMs: Date.now() - 3 * 86_400_000,
        source: 'live-request',
        modelId: 'deepseek-v4.1-flash',
        message: 'the upstream refused this account for 6004 on the current model',
      },
    },
    {
      accountId: 'acc-3',
      accountName: 'trae-ai-03',
      current: false,
      member: false,
      credits: 88.2,
      excludedBy: 'credential-rejected',
      checkedInToday: false,
    },
  ]
  return {
    status: 'signed-in',
    accountId: 'acc-1',
    accountName: '账号A',
    region: 'cn',
    domain: 'www.workbuddy.cn',
    tokenExpiresAtMs: Date.now() + 3_600_000,
    refreshExpiresAtMs: Date.now() + 10 * 86_400_000,
    selectionExplicit: true,
    enabled: true,
    accounts: accounts.map(account => ({ accountId: account.accountId, accountName: account.accountName })),
    models,
    enabledModelIds: models.map(model => model.id),
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 2542.57, expiringSoon: 1200, packages: [] },
    checkin: { checkedIn: false, enabled: true },
    // THE POOL IS PART OF THE SHIPPING LAYOUT: the desktop profile runs with the
    // pool enabled and three members, so the five-track table is what a user
    // actually sees. A fixture without `pool` would measure the one layout this
    // plugin is least likely to be in — the same mistake the sibling Trae shot
    // made, and the reason its 420px-of-fixed-tracks defect stayed invisible.
    pool: {
      enabled: true,
      checkinSupported: true,
      targetModelId: 'deepseek-v4.1-flash',
      targetModelSource: 'preferred',
      probeInputTokens: 0,
      memberAccountIds: ['acc-1', 'acc-2'],
      effectiveMemberAccountIds: ['acc-1', 'acc-2'],
      orderAccountIds: ['acc-1', 'acc-2'],
      accounts,
    },
  }
}

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
  --dsw-alias-bg-mask-1:rgba(15,17,21,.32);
  --dsw-mask-blur:blur(2px);
  --dsw-elevation-prominent:0 8px 24px rgba(15,17,21,.12);
}
html,body{margin:0;background:#eceef1;font-family:-apple-system,"PingFang SC",system-ui,sans-serif;color:#0f1115}
/* THE REAL SHELL, copied from ui-settings-general's own stylesheet rather than
   approximated: the panel is 800x800, a two-column grid of 188px | 1fr, and the
   SECTION lands in .options — a scrolling column with 0 24px 24px padding. So
   the width this plugin actually gets is 800 - 188 - 48 = 564px. */
.dialog{box-sizing:border-box;width:800px;height:800px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;
  display:grid;grid-template:"title header" "nav options" minmax(0,1fr)/188px minmax(0,1fr)}
.dialog-title{grid-area:title;padding:22px 12px 8px 24px;font-size:16px;font-weight:500;line-height:24px;color:#0f1115}
.dialog-header{grid-area:header;height:54px;padding:20px 14px 8px 10px;display:flex;justify-content:flex-end;align-items:flex-start;font-size:13px;color:#8b9099}
.dialog-nav{grid-area:nav;display:flex;flex-direction:column;gap:4px;min-height:0;padding:10px 12px 0;overflow-y:auto}
.dialog-nav i{display:block;height:40px;border-radius:8px;padding:9px 16px 9px 12px;font-style:normal;font-size:14px;line-height:22px;color:#0f1115}
.dialog-nav i.on{background:rgba(15,17,21,.06)}
.dialog-body{grid-area:options;min-width:0;min-height:0;padding:0 24px 24px;overflow-y:auto}
`

/** The in-page audit: geometry that has to be MEASURED rather than eyeballed. */
const AUDIT = `
<script>
addEventListener('load', () => {
  const out = {}
  const box = (el) => { const r = el.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) } }
  const cs = (el, prop) => getComputedStyle(el).getPropertyValue(prop).trim()
  const part = (sel, key) => { const el = document.querySelector(sel); if (el) out[key] = { ...box(el), scrollH: el.scrollHeight } }
  const dialog = document.querySelector('.dialog')
  out.dialog = dialog ? box(dialog) : null
  const column = document.querySelector('.dialog-body')
  out.column = column ? { ...box(column), scrollH: column.scrollHeight, clientH: column.clientHeight, overflowY: cs(column,'overflow-y') } : null
  part('.dsm-workbuddy-settings', 'section')
  part('.dsm-workbuddy-settings-head', 'head')
  part('.dsm-workbuddy-tabs', 'regionChips')
  part('.dsm-workbuddy-panels', 'sectionStrip')
  part('.dsm-workbuddy-pool-table', 'poolTable')
  part('.dsm-workbuddy-pool-members', 'poolMembers')
  /* THE POOL TABLE'S GRID AND ITS CELLS.
   *
   * containerType says whether the @container breakpoints can fire at all;
   * tracks is the resolved track list, which is where a fixed track's cost
   * shows up as an absolute pixel number; and the per-cell widths are the thing
   * the user actually experiences — a 76px account column renders 「用户75」. */
  const row = document.querySelector('.dsm-workbuddy-pool-row:not(.dsm-workbuddy-pool-row-head)')
  if (row) {
    out.poolRow = { ...box(row), display: cs(row,'display'), tracks: cs(row,'grid-template-columns'), flexWrap: cs(row,'flex-wrap') }
    out.poolCells = Array.from(row.children).map(el => ({
      cls: String(el.className).split(' ')[0],
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 44),
      ...box(el),
      scrollW: el.scrollWidth,
      lines: Math.round(el.getBoundingClientRect().height / parseFloat(cs(el,'line-height') || '17')),
    }))
  }
  const table = document.querySelector('.dsm-workbuddy-pool-table')
  out.tableContainerType = table ? cs(table,'container-type') : null
  out.tableWidth = table ? Math.round(table.getBoundingClientRect().width) : null
  out.headCells = Array.from(document.querySelectorAll('.dsm-workbuddy-pool-row-head > *')).map(el => ({
    text: (el.textContent || '').trim().slice(0, 20), ...box(el),
  }))
  /* WHERE THE ACCOUNT NAME ACTUALLY STARTS.
   *
   * The header says 「账号」 and the column's first pixel of TEXT is the name —
   * but the cell begins with a checkbox, so the two are not the same x. A header
   * flush to the cell edge sits ~34px left of the very thing it labels, which
   * reads as a header that belongs to the margin. Measured rather than reasoned:
   * dsh-connect-trae fixed exactly this with a padding-inline-start on its
   * account header cell, and the number below is what that has to match. */
  const nameEl = document.querySelector('.dsm-workbuddy-pool-account-name b')
  const headAccount = document.querySelector('.dsm-workbuddy-pool-row-head > *')
  out.accountNameLeft = nameEl ? Math.round(nameEl.getBoundingClientRect().left) : null
  out.accountHeaderLeft = headAccount ? Math.round(headAccount.getBoundingClientRect().left) : null
  /* The header's TEXT left edge, via a Range: the cell's own box is unchanged by
     its padding, so measuring the box would report the fix as having done
     nothing. A Range measures the ink. */
  const headerTextLeft = (() => {
    if (!headAccount || !headAccount.firstChild) return null
    const range = document.createRange()
    range.selectNodeContents(headAccount)
    const rect = range.getBoundingClientRect()
    return rect.width === 0 ? null : Math.round(rect.left)
  })()
  out.accountHeaderTextLeft = headerTextLeft
  out.accountHeaderOffset = out.accountNameLeft === null || headerTextLeft === null
    ? null
    : out.accountNameLeft - headerTextLeft
  out.rows = Array.from(document.querySelectorAll('.dsm-workbuddy-pool-row')).map(el => ({
    head: el.classList.contains('dsm-workbuddy-pool-row-head'), ...box(el),
  }))
  /* Every element whose content is wider than its box: this is the measured
     definition of "clipped", and it is what a screenshot cannot tell you. */
  out.overflowing = Array.from(document.querySelectorAll('.dsm-workbuddy-pool-table *')).filter(el => {
    const style = getComputedStyle(el)
    if (style.overflowX === 'visible' && style.textOverflow !== 'ellipsis') return false
    return el.scrollWidth > el.clientWidth + 1
  }).map(el => ({ cls: String(el.className).slice(0, 50), text: (el.textContent || '').trim().slice(0, 30), scrollW: el.scrollWidth, clientW: el.clientWidth }))
  /* The first control the reader can actually press, found by RECT rather than
     by selector: the mode bar's switch is an <input> wrapped in a label.sw,
     38x22, and is the first thing on the page anyone would click. */
  const firstControl = Array.from(document.querySelectorAll('.dsm-workbuddy-settings button, .dsm-workbuddy-settings input'))
    .find(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
  out.firstControl = firstControl ? { ...box(firstControl), cls: String(firstControl.className).slice(0,40) } : null
  /* Vertical spend ABOVE the first control: page head + region chips + the two
     hint paragraphs + the section strip. This is the number Trae cut from 351 to
     287 in the same migration, and it is pure chrome — nothing actionable. */
  out.chromeAboveFirstControl = out.firstControl === null || out.section === null
    ? null
    : out.firstControl.t - out.section.t
  out.ownScrollers = Array.from(document.querySelectorAll('.dsm-workbuddy-settings *')).filter(el => {
    const style = getComputedStyle(el)
    return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1
  }).map(el => ({ cls: String(el.className).slice(0, 60), ...box(el) }))
  /* SCROLL LAST, so the measurements above are unaffected. The dialog is a
     fixed 800px box with overflow:hidden, so anything below that is not merely
     off-screen — it is CLIPPED, and a --screenshot of the page cannot show the
     pool table at all. The shell's own column scrolls, so reproduce that: this
     is what the reader sees after scrolling down. Harmless for --dump-dom. */
  if (column) {
    const table = document.querySelector('.dsm-workbuddy-pool-members')
    if (table) column.scrollTop = Math.max(0, table.getBoundingClientRect().top - column.getBoundingClientRect().top - 8)
  }
  const pre = document.createElement('pre')
  pre.id = 'audit'
  pre.textContent = 'AUDIT' + JSON.stringify(out, null, 1)
  document.body.appendChild(pre)
})
</script>`

describe('section shot', () => {
  it('writes the html', async () => {
    const React = await import('react')
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
        cn: { enabled: true, pool: { enabled: true, targetModelId: 'deepseek-v4.1-flash', memberAccountIds: ['acc-1', 'acc-2'], orderAccountIds: ['acc-1', 'acc-2'], probeInputTokens: 0 } },
        global: { enabled: false },
      },
    }
    const scope = {
      getState: () => ({ status: 'ready', value: settings, writable: true }),
      getSnapshot: () => ({ status: 'ready', value: settings, writable: true }),
      subscribe: () => () => {},
      set: async (field: string, next: unknown) => { settings[field] = next; return true },
    }

    stubFetch(url => ({ body: url.includes('detail=fast') ? usageDocument() : usageDocument() }))
    const m = await mount(WorkBuddyCard, { t: translate, settingsScope: scope, surface: 'settings' })
    await m.settle()

    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${TOKENS}\n${WORKBUDDY_CARD_CSS.replace(/<\/style/gi, '<\\/style')}</style></head><body><div class="dialog"><div class="dialog-title">设置</div><div class="dialog-header">✕</div><div class="dialog-nav"><i class="on">账号</i><i>通用</i><i>模型</i><i>插件</i><i>dsh-connect-workbuddy</i></div><div class="dialog-body">${m.container.innerHTML}</div></div></body></html>`
    writeFileSync('/tmp/wb-section-preview.html', html.replace('</body>', `${AUDIT}</body>`))

    /* THE WIDE FORM, from the same render: one CSS serves three surfaces, and
     * the narrow rules above are `@container`-scoped, so the wide table must be
     * unchanged by them. Measured rather than assumed — a container query that
     * accidentally fires at 1120px would silently restyle the plugin page too. */
    const wideHtml = `<!doctype html><html><head><meta charset="utf-8"><style>${TOKENS}\n${WORKBUDDY_CARD_CSS.replace(/<\/style/gi, '<\\/style')}</style></head><body style="background:#fff"><div style="max-width:1120px;margin:0 auto;padding:24px 28px 48px">${m.container.innerHTML}</div></body></html>`
    writeFileSync('/tmp/wb-wide-preview.html', wideHtml.replace('</body>', `${AUDIT}</body>`))
    void React
  })
})
