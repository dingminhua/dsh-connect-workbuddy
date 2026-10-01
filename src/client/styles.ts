/**
 * Client styles for the WorkBuddy plugin card.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 整套 `dsm-*` 卡片样式系统（卡片外壳、按钮原语、`--dsw-alias-*`
 *     主题变量与十六进制回退值）逐字沿用自该项目，其又复制自
 *     dingminhua/dsh-subagent-default-model（MIT）的 SETTINGS_CSS。
 *     沿用目的是让两个插件共享同一套外部表现语言。
 * 改动：类名由 `dsm-trae-*` 改为 `dsm-workbuddy-*`；
 *   移除 trae 特有的 1M 变体样式，新增按套餐聚合的积分行样式；
 *   双 provider 化后新增国内版/国际版 tab 栏样式。
 *
 * @module dsh-connect-workbuddy/client/styles
 */

export const WORKBUDDY_CARD_CSS = `
.dsm-plugin-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dsm-plugin-card:hover{border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-plugin-card-open{background:var(--dsw-alias-bg-layer-2,#25262b);border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-plugin-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dsm-plugin-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-2px}
.dsm-plugin-card-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dsm-plugin-card-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-weight:600;line-height:1.4}
.dsm-plugin-card-description{color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}
/* Pure-CSS caret: the host primitives' chevron icon names differ per DSH line
   (0.1.5 Outline14 vs 0.1.7 OutlineRegular), so no static import can serve
   both. A border caret in the plugin's own CSS is version-proof. */
.dsm-plugin-card-chevron{color:var(--dsw-alias-label-tertiary,#999);flex:none;width:16px;height:16px;position:relative;transition:transform .16s}
.dsm-plugin-card-chevron::before{content:"";display:block;position:absolute;left:4px;top:5px;width:7px;height:7px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(45deg)}
.dsm-plugin-card-chevron-open{transform:rotate(180deg)}
.dsm-plugin-card-body{border-top:1px solid var(--dsw-alias-border-l2,#36373b);margin:0 16px;padding:0 0 8px}
.dsm-plugin-card-icon{width:32px;height:32px;flex:none;border-radius:7px}
.dsm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-btn:disabled{opacity:.4;cursor:default}
.dsm-btn-outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;font-weight:500}
.dsm-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:rgba(255,255,255,.04)}
.dsm-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsm-btn-primary:hover:not(:disabled){opacity:.9}
.dsm-workbuddy-usage{display:flex;flex-direction:column;gap:16px;margin:0;padding:16px 0 4px}
.dsm-workbuddy-tabs{display:flex;gap:6px;padding:4px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#2a2c33)}
.dsm-workbuddy-tab{appearance:none;font:inherit;cursor:pointer;flex:1;border:0;border-radius:7px;padding:7px 10px;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:500;line-height:18px;background:transparent;transition:color .15s,background .15s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsm-workbuddy-tab:hover:not(:disabled):not(.dsm-workbuddy-tab-active){color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-2,#232529);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,#3a3d45)}
.dsm-workbuddy-tab-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:baseline}
.dsm-workbuddy-tab-cell{display:flex;align-items:center;gap:2px;flex:1;min-width:0}
.dsm-workbuddy-tab-switch{display:inline-flex;align-items:center;flex:none;padding:0 8px 0 2px;cursor:pointer}
.dsm-workbuddy-tab-switch input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-workbuddy-tab-switch input:disabled{opacity:.4;cursor:default}
.dsm-workbuddy-tab-off{opacity:.55}
/* Re-detection keeps a copy in the signed-out branch (that branch is where
   "I just signed in over there" applies), so it needs its own placement: the
   pool block's rule cannot reach it. */
.dsm-workbuddy-usage-account-actions{display:flex;gap:8px;margin:10px 0 0}
.dsm-workbuddy-tab-off-notice{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px;margin:0 0 4px;padding:8px 10px;background:var(--dsw-alias-bg-layer-3,#2a2c33);border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px}
.dsm-workbuddy-usage-hint{padding-left:19px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}
.dsm-workbuddy-account-error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px;line-height:18px;white-space:pre-line}
.dsm-workbuddy-usage-select-wrap{position:relative}
.dsm-workbuddy-usage-select{appearance:none;width:100%;font:inherit;padding:10px 34px 10px 12px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-3,#2a2c33);cursor:pointer;transition:border-color .15s,box-shadow .15s}
.dsm-workbuddy-usage-select:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#5686fe);box-shadow:0 0 0 3px rgba(86,134,254,.22)}
.dsm-workbuddy-usage-select:disabled{opacity:.6;cursor:default}
.dsm-workbuddy-usage-select-wrap::after{content:"";position:absolute;top:50%;right:12px;width:7px;height:7px;transform:translateY(-65%) rotate(45deg);border-right:1.6px solid var(--dsw-alias-label-secondary,#c6c9d0);border-bottom:1.6px solid var(--dsw-alias-label-secondary,#c6c9d0);pointer-events:none}
.dsm-workbuddy-usage-text{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary,#b8b8b8)}
.dsm-workbuddy-searched{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-workbuddy-searched>summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#b8b8b8);user-select:none}
.dsm-workbuddy-searched-hint{margin:6px 0 4px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-workbuddy-searched-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.dsm-workbuddy-searched-list li{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsm-workbuddy-searched-list code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#b8b8b8);word-break:break-all}
.dsm-workbuddy-searched-reason{color:var(--dsw-alias-label-tertiary,#999);font-size:11px}
.dsm-workbuddy-searched-reason-encrypted{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-workbuddy-searched-reason-wrong-region{color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-workbuddy-searched-more{margin-top:6px;padding:0;border:0;background:none;color:var(--dsw-alias-brand-primary,#5686fe);font:inherit;font-size:12px;line-height:18px;cursor:pointer;text-align:left}
.dsm-workbuddy-searched-more:hover{text-decoration:underline}
.dsm-workbuddy-usage-error{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-workbuddy-usage-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.dsm-workbuddy-credits-panels{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(150px,.8fr);gap:10px}
.dsm-workbuddy-credit-panel{display:flex;flex-direction:column;min-width:0;gap:7px;padding:14px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-workbuddy-credit-panel-title{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-workbuddy-credit-panel-value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;line-height:21px}
.dsm-workbuddy-credit-panel-meta,.dsm-workbuddy-credit-panel-empty{color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px}
.dsm-workbuddy-credit-monthly-row{position:relative;display:flex;flex-direction:column;gap:3px;margin:-14px -14px 0;padding:11px 14px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:14px 14px 0 0;background:var(--dsw-alias-bg-layer-2,#24262c);overflow:hidden}
.dsm-workbuddy-credit-monthly-row::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;opacity:.9;background:#9ca2aa}
.dsm-workbuddy-credit-monthly-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}
.dsm-workbuddy-credit-monthly-meta{color:var(--dsw-alias-label-tertiary,#999);font-size:11.5px;line-height:17px;font-variant-numeric:tabular-nums}
.dsm-workbuddy-credit-packages{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}
.dsm-workbuddy-credit-packages li{display:flex;align-items:baseline;justify-content:space-between;gap:10px;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px}
.dsm-workbuddy-credit-packages li span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-credit-packages li span:last-child{flex:none;color:var(--dsw-alias-label-tertiary,#999);font-size:11px}
.dsm-workbuddy-credit-soon{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-top:9px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px}
.dsm-workbuddy-credit-soon strong{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-variant-numeric:tabular-nums}
.dsm-workbuddy-credit-panel-total{position:relative;align-items:center;text-align:center;overflow:hidden}
.dsm-workbuddy-credit-panel-total::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;opacity:.9;background:#4d9b6d}
.dsm-workbuddy-credit-total-body{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;width:100%}
.dsm-workbuddy-credit-total-value{color:#3f8d60;font-size:32px;line-height:36px;font-weight:700;letter-spacing:-.5px;white-space:nowrap;font-variant-numeric:tabular-nums}
.dsm-workbuddy-checkin{display:flex;flex-direction:column;align-items:center;width:100%;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
.dsm-workbuddy-checkin-button{width:100%;padding:4px 10px;font-size:12px}
.dsm-workbuddy-checkin-error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:11px;line-height:16px;text-align:center}
@media (max-width:760px){.dsm-workbuddy-credits-panels{grid-template-columns:1fr}.dsm-workbuddy-credit-panel-total{align-items:flex-start;text-align:left}.dsm-workbuddy-credit-total-body{align-items:flex-start}}
.dsm-workbuddy-models{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:14px}
.dsm-workbuddy-models-fold{display:flex;flex-direction:column;gap:10px}
/* The head doubles as the <details> summary. list-style:none plus the marker
   rule removes the NATIVE triangle, because the chevron below is drawn instead;
   without this the header would show two indicators in opposite corners. */
.dsm-workbuddy-models-head{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;list-style:none;user-select:none}
.dsm-workbuddy-models-head::-webkit-details-marker{display:none}
.dsm-workbuddy-models-head::marker{content:""}
.dsm-workbuddy-models-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:3px;border-radius:6px}
.dsm-workbuddy-models-title-row{display:flex;align-items:center;gap:6px;min-width:0}
/* The chevron points RIGHT when collapsed and rotates to DOWN when expanded.
   The rotation keys off the details element's own open attribute, so it needs
   no state and cannot disagree with what the browser actually shows. */
.dsm-workbuddy-models-chevron{display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;color:var(--dsw-alias-label-tertiary,#999);transition:transform .16s}
/* The faint affordance hint, centred in the space between the section title and
   the refresh button. Same faint token as the summary line under the title, so
   it reads as a hint rather than as a second heading. flex:1 is what makes it
   land in the actual middle instead of wherever space-between drops it. */
.dsm-workbuddy-models-fold-hint{flex:1 1 auto;min-width:0;overflow:hidden;text-align:center;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
/* Too narrow to hold title + hint + button on one line: the chevron already
   marks the header as a disclosure, so the words are the part that can go. */
@media (max-width:760px){.dsm-workbuddy-models-fold-hint{display:none}}
.dsm-workbuddy-models-fold[open] .dsm-workbuddy-models-chevron{transform:rotate(90deg)}
.dsm-workbuddy-models-head:hover .dsm-workbuddy-models-chevron{color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-models-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}
/* Unsaved-changes marker. It sits in the HEADER, outside the fold, because the
   save/discard buttons are inside it: without this the user could collapse the
   list and hide their own pending edits with nothing on screen saying so. */
.dsm-workbuddy-models-dirty{margin-left:8px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-state-warn-primary,#f59e0b);color:#1b1d22;font-size:11px;font-weight:600;line-height:16px;vertical-align:1px;white-space:nowrap}
.dsm-workbuddy-models-summary{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-workbuddy-model-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;overflow:hidden}
.dsm-workbuddy-model{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2,#232529);transition:opacity .16s}
.dsm-workbuddy-model-disabled{opacity:.55}
.dsm-workbuddy-model+.dsm-workbuddy-model{border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
.dsm-workbuddy-model-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.dsm-workbuddy-model-enabled{display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer;flex:1}
.dsm-workbuddy-model-enabled input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe);flex:none}
.dsm-workbuddy-model-image{display:inline-flex;align-items:center;gap:5px;flex:none;cursor:pointer;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-workbuddy-model-image input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-workbuddy-model-copy{display:flex;align-items:baseline;gap:8px;min-width:0}
.dsm-workbuddy-model-name{display:inline-flex;align-items:baseline;gap:7px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:500;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-model-name-rate{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-weight:400;line-height:16px;flex:none}
.dsm-workbuddy-model-id{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-model-desc{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}
.dsm-workbuddy-model-details{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.dsm-workbuddy-model-meta{display:flex;align-items:center;gap:7px 12px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
.dsm-workbuddy-model-meta-tag{padding:1px 7px;border-radius:999px;font-size:11px;line-height:15px;background:rgba(174,179,187,.11);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-context-budget{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex:none;margin:0;padding:0;border:0;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-workbuddy-context-budget label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
.dsm-workbuddy-context-budget input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-workbuddy-model-capability-note{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
/* Model probe (test button + result). The result line is its own row under the
   meta line, because a cooldown sentence ("rate limited - the upstream gave no
   time") does not fit next to the context/output chips, and truncating it would
   hide exactly the part the user needs. */
.dsm-workbuddy-models-head-actions{display:flex;align-items:center;gap:8px;flex:none}
.dsm-workbuddy-model-probe{flex:none;padding:3px 10px;font-size:11px;line-height:16px}
.dsm-workbuddy-model-probe-result{margin:0;font-size:12px;line-height:18px;word-break:break-word}
.dsm-workbuddy-model-probe-result-ok{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-model-probe-result-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-workbuddy-model-probe-result-bad{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-workbuddy-model-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px}
.dsm-workbuddy-model-save-error{flex:1;min-width:0;color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px;line-height:16px;text-align:right}
.dsm-workbuddy-model-actions-buttons{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dsm-workbuddy-usage-cheer{display:inline-flex;align-items:center;gap:4px;flex:none;text-decoration:underline;text-underline-offset:2px;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5;transition:color .16s}
.dsm-workbuddy-usage-cheer-star{font-size:12px;line-height:1;display:inline-flex}
.dsm-workbuddy-usage-cheer:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-usage-cheer:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:2px}

/* ---- Account pool ---- */
.dsm-workbuddy-pool{display:flex;flex-direction:column;gap:12px;margin:0;padding:16px 0 4px;border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
.dsm-workbuddy-pool-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsm-workbuddy-pool-current{display:flex;flex-direction:column;align-items:flex-end;gap:4px;max-width:340px;text-align:right}
.dsm-workbuddy-pool-current-badge{padding:2px 10px;border-radius:999px;background:rgba(86,134,254,.16);color:var(--dsw-alias-brand-primary,#5686fe);font-size:12px;font-weight:600;line-height:18px;white-space:nowrap}
.dsm-workbuddy-pool-current-hint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#999)}
/* Sits under the header block, before the batch buttons: account discovery is
   the first step of using the pool, so it reads above the actions it enables. */
.dsm-workbuddy-pool-rescan{display:flex;justify-content:flex-end;margin-top:8px}
.dsm-workbuddy-pool-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-pool-summary{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-workbuddy-pool-badge{flex:none;padding:2px 9px;border-radius:999px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-brand-primary,#5686fe);background:rgba(86,134,254,.12);border:1px solid rgba(86,134,254,.32)}
.dsm-workbuddy-pool-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dsm-workbuddy-pool-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-workbuddy-pool-note{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-workbuddy-pool-warn{margin:0;padding:9px 11px;border-radius:9px;font-size:12px;line-height:17px;color:var(--dsw-alias-state-warn-primary,#f59e0b);background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.3)}
.dsm-workbuddy-pool-error{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary,#ef4444);white-space:pre-line}
.dsm-workbuddy-pool-table{border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-workbuddy-pool-row{display:grid;grid-template-columns:1.6fr 1fr 1.3fr .9fr;gap:10px;align-items:center;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d31);font-size:13px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-pool-row:first-child{border-top:0}
.dsm-workbuddy-pool-row-head{padding:8px 14px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}
.dsm-workbuddy-pool-row-current{background:rgba(86,134,254,.07)}
/* The serving row, made findable at a glance: a left accent bar plus the tint.
   The bar is what distinguishes it in a long table, where a 7%-opacity wash
   alone reads as an alternating-row stripe. */
.dsm-workbuddy-pool-row-current{box-shadow:inset 3px 0 0 var(--dsw-alias-brand-primary,#5686fe)}
.dsm-workbuddy-pool-account{display:flex;align-items:center;gap:8px;min-width:0}
.dsm-workbuddy-pool-account-name{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsm-workbuddy-pool-account-name b{font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-pool-account-name span{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999)}
/* Declared AFTER the blanket span rule so it wins: the badge must not inherit
   the muted 11px tertiary treatment the membership line uses. */
.dsm-workbuddy-pool-account-name .dsm-workbuddy-pool-current-tag{align-self:flex-start;margin-top:2px;padding:1px 6px;border-radius:999px;background:rgba(86,134,254,.16);color:var(--dsw-alias-brand-primary,#5686fe);font-size:11px;font-weight:600;line-height:16px;white-space:nowrap}
.dsm-workbuddy-pool-excluded{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-workbuddy-pool-credits{display:flex;flex-direction:column;gap:1px;min-width:0;font-variant-numeric:tabular-nums}
.dsm-workbuddy-pool-credits b{color:var(--dsw-alias-label-primary,#e6e6e6);font-weight:600}
.dsm-workbuddy-pool-soon{font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-workbuddy-pool-soon-plain{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-workbuddy-pool-probe,.dsm-workbuddy-pool-checkin{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999);min-width:0;overflow-wrap:anywhere}
.dsm-workbuddy-pool-members{display:flex;flex-direction:column;gap:10px}
.dsm-workbuddy-pool-members-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsm-workbuddy-pool-members-title{margin:0 0 3px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-pool-members-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-workbuddy-pool-small-btn{padding:3px 10px;font-size:12px}
.dsm-workbuddy-pool-check{display:inline-flex;align-items:center;flex:none;cursor:pointer}
.dsm-workbuddy-pool-check input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-workbuddy-pool-check input:disabled{cursor:default;opacity:.5}
.dsm-workbuddy-pool-checked{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-pool-unknown{color:var(--dsw-alias-label-dimmed,#9aa0a6)}
.dsm-workbuddy-pool-member{color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-workbuddy-pool-not-member{color:var(--dsw-alias-label-dimmed,#9aa0a6)}
.dsm-workbuddy-pool-settings-wrap{display:flex;flex-direction:column;gap:10px}
.dsm-workbuddy-pool-dirty{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-workbuddy-pool-settings{display:flex;flex-direction:column;gap:1px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-workbuddy-pool-set{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:12px 14px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d31)}
.dsm-workbuddy-pool-set:first-child{border-top:0}
.dsm-workbuddy-pool-set-copy{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.dsm-workbuddy-pool-set-copy b{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-pool-set-copy span{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-workbuddy-pool-set-ctl{flex:none;display:flex;align-items:center;gap:8px}
.dsm-workbuddy-pool-num{width:74px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:13px;text-align:center;font-variant-numeric:tabular-nums}
.dsm-workbuddy-pool-select{max-width:260px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:13px;cursor:pointer}
.dsm-workbuddy-pool-select:disabled,.dsm-workbuddy-pool-num:disabled{opacity:.5;cursor:default}
.dsm-workbuddy-pool-save-bar{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.dsm-workbuddy-pool-conflict{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:11px 13px;border-radius:10px;background:rgba(245,158,11,.08);border:1px solid var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-workbuddy-pool-pending{flex:none;align-self:center;font-size:12px;line-height:17px;color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-workbuddy-pool-conflict-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dsm-workbuddy-pool-conflict-main b{font-size:12px;font-weight:600;color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-workbuddy-pool-conflict-main span{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-pool-log{border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-workbuddy-pool-log-head{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:var(--dsw-alias-bg-layer-3,#2a2c33);border-bottom:1px solid var(--dsw-alias-border-l1,#2c2d31);font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-pool-log-clear{padding:2px 10px;font-size:12px}
.dsm-workbuddy-pool-log-body{max-height:186px;overflow-y:auto}
.dsm-workbuddy-pool-log-row{display:flex;gap:10px;padding:7px 14px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d31);font-size:12px;line-height:18px}
.dsm-workbuddy-pool-log-row:first-child{border-top:0}
.dsm-workbuddy-pool-log-time{flex:none;color:var(--dsw-alias-label-tertiary,#999);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dsm-workbuddy-pool-log-text{min-width:0;overflow-wrap:anywhere}
.dsm-workbuddy-pool-log-ok{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-pool-log-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-workbuddy-pool-log-error{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-workbuddy-pool-log-info{color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-pool-log-empty{padding:14px;font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}
@media (max-width:760px){.dsm-workbuddy-pool-row{grid-template-columns:1fr 1fr;row-gap:6px}.dsm-workbuddy-pool-select{max-width:180px}}
/* Pool switch, namespaced under .dsm-workbuddy-pool so it cannot collide with host styles. */
.dsm-workbuddy-pool .sw{position:relative;display:inline-block;width:38px;height:22px;flex:none;cursor:pointer}
.dsm-workbuddy-pool .sw input{position:absolute;opacity:0;width:0;height:0}
.dsm-workbuddy-pool .sw-track{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-border-l2,#3a3d45);transition:background .18s}
.dsm-workbuddy-pool .sw-track::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .18s;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.dsm-workbuddy-pool .sw input:checked+.sw-track{background:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-workbuddy-pool .sw input:checked+.sw-track::after{transform:translateX(16px)}
.dsm-workbuddy-pool .sw input:disabled+.sw-track{opacity:.4}
.dsm-workbuddy-pool .sw input:disabled{cursor:default}
`
