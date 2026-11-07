/** 同系列的公共布局规则。两个桥接插件同步维护此文件，功能专属样式留在 styles.ts。 */
export function seriesLayoutCss(plugin: 'trae' | 'workbuddy'): string {
  const p = `.dsm-${plugin}`
  const u = `${p}-usage`
  const members = plugin === 'trae' ? `${p}-pool-card` : `${p}-pool-members`
  const memberHead = plugin === 'trae' ? `${p}-pool-card-head` : `${p}-pool-members-head`
  const memberTitle = plugin === 'trae' ? `${p}-pool-card-title` : `${p}-pool-members-title`
  const memberActions = plugin === 'trae' ? `${p}-pool-card-tools` : `${p}-pool-members-actions`
  const saveBar = plugin === 'trae' ? `${p}-pool-save-row` : `${p}-pool-save-bar`
  const current = plugin === 'trae' ? `${p}-pool-current` : `${p}-pool-current-badge`
  return `
${p}-page{font-family:inherit;--dsm-series-sticky-top:-28px}
${p}-page${p}-page{height:calc(100% - 16px);margin-bottom:16px;padding:28px clamp(24px,4vw,48px) 48px;gap:20px}
${u} ${p}-pool-auto-checkin-status{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#777)}
${p}-page-desc{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,#999)}
${u} ${p}-pool-auto-checkin{display:flex;flex-direction:column;gap:6px;margin-top:8px}
${p}-page>*{width:100%;max-width:860px;min-width:0}
${u}{gap:16px;font-size:13px;line-height:1.5;min-width:0}
${u} .dsm-btn{box-sizing:border-box;font:inherit;font-size:13px;line-height:20px;padding:5px 14px;border-radius:8px;min-height:32px}
${u} .dsm-btn-outline{background:transparent;border-color:var(--dsw-alias-border-l2,#777);color:var(--dsw-alias-label-secondary,#999)}
${u} ${p}-tabs{display:flex;gap:8px}
${u} ${p}-tab-cell{flex:1;min-width:0;padding:8px 12px;border-radius:10px}
${u} ${p}-panels{position:sticky;top:var(--dsm-series-sticky-top,0px);z-index:2;display:flex;gap:2px;margin:0;padding:0;border-bottom:1px solid var(--dsw-alias-border-l1,#777);background:var(--dsw-alias-bg-layer-2,#24262c)}
/* 吸顶背景覆盖卡片两侧内边距，顶部偏移抵消滚动容器的顶部内边距。 */
${p}-page-body ${u} ${p}-panels{margin-inline:0;padding:0 0 8px;border:0;border-bottom:1px solid var(--dsw-alias-border-l2,#777);border-radius:0;background:var(--dsw-alias-bg-layer-3,#202126)}
${p}-page[data-tabs-stuck="true"] ${p}-panels{margin-inline:-20px;padding-inline:20px;border-top:1px solid var(--dsw-alias-border-l2,#777);box-shadow:0 3px 6px rgba(0,0,0,.06)}
${u} ${p}-panel-tab{font-size:13px;font-weight:600;line-height:20px;padding:7px 11px}
${u} ${p}-panel{margin-top:0;min-width:0}
${u} ${p}-models-summary,${u} ${p}-panel-note{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
${u} ${p}-free-quota-warn{font-weight:600}
/* 说明段落的间距由容器统一控制，避免与卡片的纵向 gap 叠加。 */
${u} ${p}-region-summary{display:flex;flex-direction:column;gap:2px}
${u} ${p}-region-summary ${p}-models-summary{margin:0}
/* 说明与页签之间保留 8px，抵消外层 16px 间隔中多出的部分。 */
${u} ${p}-region-summary+${p}-panels{margin-top:-8px}
/* 页签底边已经分隔账号区，不在账号池顶部重复画线。 */
${u} #dsm-${plugin}-panel-accounts ${p}-pool{border-top:0;padding-top:0}

${u} ${p}-pool{display:flex;flex-direction:column;gap:12px;margin:0;padding:14px 0 0;border-top:1px solid var(--dsw-alias-border-l2,#777)}
${u} ${p}-pool-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
${u} ${p}-pool-title{margin:0;font-size:13px;font-weight:600;line-height:18px}
${u} ${current}{margin-left:auto;max-width:100%;overflow-wrap:anywhere;white-space:normal;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#777);font-size:11px;font-weight:500;line-height:16px;background:var(--dsw-alias-bg-layer-2,#24262c);color:var(--dsw-alias-label-secondary,#999)}
${u} ${p}-pool-settings${p}-pool-modebar{padding:12px 14px;gap:8px;border:1px solid var(--dsw-alias-border-l2,#777);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#cf795b) 5%,var(--dsw-alias-bg-layer-2,#24262c))}
${u} ${p}-pool-modebar-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:20px}
${u} ${p}-pool-modebar-label{font-size:13px;font-weight:600;line-height:20px}
${u} ${p}-pool-modebar-state{padding:1px 9px;font-size:12px;line-height:18px;border-radius:999px;color:var(--dsw-alias-label-secondary,#999);border:1px solid var(--dsw-alias-border-l2,#777);background:var(--dsw-alias-bg-layer-2,#24262c)}
${u} ${p}-pool-note,${u} ${p}-pool-modebar ${p}-pool-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
${u} ${members}{display:flex;flex-direction:column;gap:0;min-width:0;border:1px solid var(--dsw-alias-border-l2,#777);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#24262c);overflow:hidden}
${u} ${memberHead}{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:14px 14px 12px}
${u} ${memberTitle}{margin:0;font-size:13px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary,#eee)}
${u} ${memberHead} ${p}-pool-note{margin-top:4px}
${u} ${memberActions}{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
${u} ${memberActions} .dsm-btn{padding:5px 14px;font-size:13px;line-height:20px}
${u} ${p}-pool-count,${u} ${memberActions} ${p}-pool-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
${u} ${members} ${p}-pool-actions{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:0 14px 12px}
${u} ${p}-pool-actions-end{margin-left:auto}
${u} ${members} ${p}-pool-action-note{margin:0;padding:0 14px 12px;font-size:12px;line-height:18px}
${u} ${members} ${p}-pool-table{border:0;border-top:1px solid var(--dsw-alias-border-l1,#777);border-radius:0}
${u} ${p}-pool-row{padding:10px 14px;align-items:start;font-size:13px;line-height:18px}
${u} ${p}-pool-row-head{padding:8px 14px;font-size:11px;line-height:16px;align-items:center}
${u} ${p}-pool-row-current{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#cf795b) 5%,var(--dsw-alias-bg-layer-2,#24262c));box-shadow:inset 3px 0 0 var(--dsw-alias-brand-primary,#cf795b)}
${u} ${p}-pool-row-actions .dsm-btn{min-height:26px;padding:2px 10px;font-size:12px;line-height:20px}
${u} ${p}-pool-settings-wrap{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2,#777);padding-top:14px}
${u} ${p}-pool-settings{border-radius:12px;gap:0}
${u} ${p}-pool-settings-wrap :is(h3,h4){margin:0;font-size:13px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary,#eee)}
${u} ${p}-pool-set-ctl select{box-sizing:border-box;width:240px;min-width:0;max-width:100%}
${u} ${p}-pool-set{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 14px}
${u} ${p}-pool-set-copy{flex:1;min-width:0;gap:3px}
${u} ${p}-pool-set-copy b{font-size:13px;font-weight:500;line-height:18px}
${u} ${p}-pool-set-copy span{font-size:12px;line-height:18px}
${u} ${p}-models-title{font-size:13px;line-height:18px;font-weight:600}
${u} ${p}-model-list{border-radius:12px}
${u} ${p}-model{padding:12px 14px;gap:8px}
${u} ${p}-model-name{font-size:13px;line-height:20px}
${u} ${p}-model-actions,${u} ${p}-pool-save-row{gap:12px;padding-top:12px}
/* 保存栏以整个账号池为粘附范围，避免被更多设置的短父级截住。 */
${u} ${p}-pool-settings-wrap{display:contents}
${u} ${saveBar}{position:sticky;bottom:0;z-index:2;isolation:isolate;padding-bottom:12px;background:var(--dsw-alias-bg-layer-3,#202126)}
/* 滚动容器底部的内边距也属于可见区域，负偏移让背景覆盖到视口底边。 */
${p}-page ${saveBar}{bottom:-48px}
${p}-page ${saveBar}[data-save-stuck="true"]{margin-inline:-20px;padding-inline:20px;border-top:1px solid var(--dsw-alias-border-l2,#777);border-bottom:1px solid var(--dsw-alias-border-l2,#777);border-radius:0;box-shadow:0 -3px 6px rgba(0,0,0,.06)}

${u} #dsm-${plugin}-panel-capabilities:not([hidden]){display:flex;flex-direction:column;gap:14px}
${u} ${p}-prefs{gap:14px;padding:0}
${u} ${p}-pref{font-size:13px;line-height:18px;gap:10px}
${u} ${p}-pref-hint{font-size:12px;line-height:18px}
${u} ${p}-draw-image{margin:0;gap:10px;font-size:13px;line-height:18px}
${u} ${p}-draw-image>span{display:flex;flex-direction:column;gap:3px}
${u} ${p}-draw-image-hint{font-size:12px;line-height:18px}
${u} ${p}-pool-table{container-type:inline-size}
${u} ${p}-pool-current-tag{border:1px solid var(--dsw-alias-border-l2,#777);background:var(--dsw-alias-bg-layer-2,#24262c);color:var(--dsw-alias-label-secondary,#999)}
/* The ≤700px RE-GRID OF THE POOL ROW IS DELIBERATELY ABSENT.
 *
 * The shared series layout used to switch the row to display:flex + flex-wrap:wrap,
 * hide the header and give the actions their own full-width line here. That is the
 * stacked form workbuddy REMOVED: the row is three lines at every width (identity +
 * credits / verdict + timestamp + check-in + buttons / provenance), and its narrow
 * concession is one detail — dropping the absolute timestamp where it cannot sit
 * beside the verdict — not a second layout.
 *
 * Copied over, those four rules cost the row its whole shape: measured in headless
 * Chrome at the 564px Settings column, the row went from 80px to 118px, the header
 * disappeared, and the buttons fell onto a line of their own. The two-class selectors
 * below would have outranked the row's own single-class rule, so nothing warned.
 *
 * The series layout keeps everything that is genuinely shared — sticky tabs, the
 * save bar, the paddings and control metrics — and leaves each plugin row to
 * itself. trae still ships its own stacked form in its own stylesheet. */
/* 自动签到、设备参数和 SDK 是功能差异；沿用公共间距，不移除控件。 */
${u} ${p}-device-mode{margin:0;padding:0 14px 12px}
${u} ${p}-pool .sw{width:36px;height:20px}
${u} ${p}-pool .sw-track::after{top:2px;left:2px;width:16px;height:16px;background:var(--dsw-alias-bg-layer-3,#fff)}
${u} ${p}-pool .sw input:checked+.sw-track::after{transform:translateX(16px)}
@media(max-width:600px){
 ${p}-page${p}-page{padding:20px 16px 32px;--dsm-series-sticky-top:-20px}
 ${p}-page ${saveBar}{bottom:-32px}
 ${u} ${memberHead}{align-items:flex-start}
 ${u} ${memberActions}{flex-wrap:wrap}
 ${u} ${p}-pool-set{flex-wrap:wrap}
 ${u} ${p}-pool-set-ctl{max-width:100%;flex-wrap:wrap}
 ${u} ${p}-pool-set-ctl select{min-width:0;max-width:100%}
}
`
}

/** 根据页签与保存栏的实际吸附位置显示边界。 */
export function updateStickyTabs(page: HTMLElement): void {
  const tabs = page.querySelector<HTMLElement>('[role="tablist"][class$="-panels"]')
  const stuck = tabs !== null && page.scrollTop > 0 && tabs.getBoundingClientRect().top <= page.getBoundingClientRect().top + 1
  page.dataset.tabsStuck = String(stuck)
  const viewportBottom = page.getBoundingClientRect().bottom
  for (const bar of Array.from(page.querySelectorAll<HTMLElement>('[class$="-pool-save-row"],[class$="-pool-save-bar"]'))) {
    const visible = bar.getClientRects().length > 0
    // 保存栏的负 bottom 用于覆盖内边距，判断吸附时需要计入这一偏移。
    const bottom = Number.parseFloat(getComputedStyle(bar).bottom) || 0
    bar.dataset.saveStuck = String(visible && Math.abs(bar.getBoundingClientRect().bottom + bottom - viewportBottom) <= 1)
  }
}
