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
/* One sidebar-credit switch, belonging to the ACTIVE tab's region. It sits on
   its own line so it reads as a property of this tab rather than as a shared
   pair of settings — the tab bar already says which region is in scope. */
.dsm-workbuddy-credits-switch{display:flex;align-items:center;gap:6px;margin:8px 0 2px;cursor:pointer;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-credits-switch input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-workbuddy-credits-switch input:disabled{opacity:.4;cursor:default}
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
.dsm-workbuddy-models{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:14px}
.dsm-workbuddy-models-fold{display:flex;flex-direction:column;gap:10px}
/* A plain header now: the section does not fold, so it is neither clickable nor
   focusable, and the list-marker rules that hid the native <details> triangle are
   gone with it. */
.dsm-workbuddy-models-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsm-workbuddy-models-title-row{display:flex;align-items:center;gap:6px;min-width:0}
.dsm-workbuddy-models-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}
/* Unsaved-changes marker. It sits in the HEADER rather than beside the save
   buttons at the foot of the list, so a pending edit is visible without
   scrolling to the end of a long model list. */
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
.dsm-workbuddy-model-off{display:inline-flex;align-items:center;gap:5px;flex:none;cursor:pointer;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-workbuddy-model-off input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
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
.dsm-workbuddy-pool-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsm-workbuddy-pool-current-badge{padding:2px 10px;border-radius:999px;background:rgba(86,134,254,.16);color:var(--dsw-alias-brand-primary,#5686fe);font-size:12px;font-weight:600;line-height:18px;white-space:nowrap}
/* Sits under the header block, before the batch buttons: account discovery is
   the first step of using the pool, so it reads above the actions it enables. */
/* Manual-mode account picker: shares the settings row layout (.pool-set), and
   only the select itself needs a hint that it is a PICKER of accounts rather
   than of models — the two sit near each other and used to be indistinguishable
   to a selector query as well as to the eye. */
.dsm-workbuddy-pool-account-select{min-width:200px}
.dsm-workbuddy-pool-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-pool-badge{flex:none;padding:2px 9px;border-radius:999px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-brand-primary,#5686fe);background:rgba(86,134,254,.12);border:1px solid rgba(86,134,254,.32)}
/* One row, two clusters: LEFT acts on the accounts you checked, RIGHT re-reads
   which accounts exist. Before this the rescan button was on its own row pushed
   right while the batch buttons were on the next row pushed left — two
   alignments two lines apart, with nothing explaining the split. */
.dsm-workbuddy-pool-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px}
.dsm-workbuddy-pool-actions-group{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
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
.dsm-workbuddy-pool-probe{display:flex;flex-direction:column;gap:4px}
.dsm-workbuddy-pool-probe-main{color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-pool-probe-prov{display:flex;align-items:center;gap:5px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#999);min-width:0;flex-wrap:wrap}
.dsm-workbuddy-pool-prov-tag{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-tertiary,#999);font-size:10px;font-weight:600;line-height:15px;white-space:nowrap}
.dsm-workbuddy-pool-prov-live{background:rgba(245,158,11,.16);color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-workbuddy-pool-prov-unknown{background:var(--dsw-alias-bg-layer-3,#2a2c33);border:1px solid var(--dsw-alias-border-l1,#2c2d31);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-pool-prov-sep{color:var(--dsw-alias-label-dimmed,#9aa0a6);opacity:.7}
.dsm-workbuddy-pool-prov-age{color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}
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
.dsm-workbuddy-pool-save-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px}
.dsm-workbuddy-pool-save-buttons{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:none}
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
/**
 * Composer credit readout styles, injected by the readout component itself.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 该项目的 `COMPOSER_POINTS_CSS`，类名改为 `dsm-workbuddy-*`，
 *     其余（尺寸、节奏、主题变量与回退值、表格对齐）逐条沿用。
 *
 * Separate from the card bundle because the readout lives in the session's
 * composer, not inside the plugin card; a card that is closed still shows this,
 * and on some hosts the card is never mounted at all.
 */
export const WORKBUDDY_COMPOSER_CSS = `
/* The readout is plain composer text — no border, no fill at rest. The padding
   is only the click target, invisible until the pointer arrives. */
.dsm-workbuddy-composer-credits{display:inline-flex;align-items:center;min-width:0}
.dsm-workbuddy-composer-credits-trigger{
  appearance:none;display:inline-flex;align-items:center;align-self:stretch;
  padding:2px 6px;border:0;border-radius:6px;background:transparent;
  /* EXPLICIT, not inherit. The composer row's own font and body colour are
     noticeably larger and darker than the neighbouring controls — a credit
     readout is secondary information and must not shout. 12px matches this
     plugin's original line; label-tertiary matches the shell's own composer-row
     control (ContextMeter), which is the sibling this reads alongside. */
  font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-tertiary,#999);
  white-space:nowrap;cursor:pointer;
  font-variant-numeric:tabular-nums;
}
.dsm-workbuddy-composer-credits-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-workbuddy-composer-credits-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
/* The panel is portaled to document.body and positioned from the trigger, so it
   MUST be fixed — otherwise the left/top it measures are ignored and it lands in
   document flow. All material comes from shell tokens so it follows the theme. */
.dsm-workbuddy-composer-panel{
  position:fixed;z-index:1100;box-sizing:border-box;
  width:min(248px,calc(100vw - 24px));padding:12px;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));
  border-radius:var(--dsw-radius-lg,14px);
  background:var(--dsw-specific-menu,Canvas);
  box-shadow:var(--dsw-elevation-prominent,0 8px 32px rgba(0,0,0,.22));
  backdrop-filter:var(--dsw-menu-backdrop-filter,none);
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#444);
}
.dsm-workbuddy-composer-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.dsm-workbuddy-composer-panel-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,CanvasText)}
/* Self-contained: the dsm-btn primitive lives in TRAE_CARD_CSS, which the
   composer never loads, so the refresh button must style itself. */
.dsm-workbuddy-composer-panel-refresh{
  appearance:none;flex:none;margin-left:auto;padding:3px 10px;
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.34));
  border-radius:7px;background:transparent;
  color:var(--dsw-alias-label-secondary,#444);
  font:inherit;font-size:11px;line-height:16px;cursor:pointer;
}
.dsm-workbuddy-composer-panel-refresh:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,rgba(127,127,127,.6));color:var(--dsw-alias-label-primary,CanvasText)}
.dsm-workbuddy-composer-panel-refresh:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-composer-panel-refresh:disabled{opacity:.5;cursor:default}
/* The panel is a TABLE: one row per account in the region, one figure (the
   general balance) per row, and a row click switches accounts.

   Rhythm is deliberate: the header sits on a hairline, the switch button owns
   ALL horizontal padding (and pulls back by the same amount so its label lines
   up with the header), and every row is the same height. A misaligned first
   column is what makes a two-column popover read as broken. */
.dsm-workbuddy-composer-panel-table{
  width:100%;border-collapse:collapse;
  font-size:12px;line-height:18px;
}
.dsm-workbuddy-composer-panel-table thead th{
  padding:0 0 7px;font-weight:500;text-align:left;font-size:11px;
  color:var(--dsw-alias-label-tertiary,GrayText);
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
}
.dsm-workbuddy-composer-panel-num{
  text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;
}
.dsm-workbuddy-composer-panel-table thead th.dsm-workbuddy-composer-panel-num{padding-right:0}
.dsm-workbuddy-composer-panel-table tbody th{
  padding:0;font-weight:400;text-align:left;vertical-align:middle;
}
.dsm-workbuddy-composer-panel-table tbody td{
  padding:4px 0;vertical-align:middle;
  color:var(--dsw-alias-label-primary,CanvasText);
}
/* The current account reads as current without shouting: a filled dot and a
   slightly heavier weight. Disabled — pressing it would write a selection that
   has not changed. */
.dsm-workbuddy-composer-panel-table tbody tr.dsm-workbuddy-composer-panel-row-current td{font-weight:600}
.dsm-workbuddy-composer-panel-switch{
  appearance:none;display:flex;align-items:center;gap:7px;
  width:100%;padding:4px 6px;margin-left:-6px;
  border:0;border-radius:6px;background:transparent;
  color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer;
  white-space:nowrap;overflow:hidden;
}
.dsm-workbuddy-composer-panel-switch>span:last-child{overflow:hidden;text-overflow:ellipsis}
/* The name + optional reason mark. A COLUMN so the mark drops onto its own line
   under the name: side by side they would stretch the name column and squeeze
   the numeric one, and the switch's own overflow rule would ellipsise the mark
   instead of the name. */
.dsm-workbuddy-composer-panel-who{display:flex;flex-direction:column;min-width:0;gap:1px}
.dsm-workbuddy-composer-panel-name{overflow:hidden;text-overflow:ellipsis}
/* Why the account cannot serve right now ("被限流"), in the warn colour the pool
   table uses for the same fact — so one measurement reads the same on both. */
.dsm-workbuddy-composer-panel-mark{
  font-size:11px;line-height:15px;
  color:var(--dsw-alias-state-warn-primary,#f59e0b);
}
/* Hover belongs to the switch, not the row: the number cell is not clickable,
   so lighting it up would promise an action it cannot perform. */
.dsm-workbuddy-composer-panel-switch:hover:not(:disabled){
  background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));
}
.dsm-workbuddy-composer-panel-switch:focus-visible{
  outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-1px;
}
.dsm-workbuddy-composer-panel-switch:disabled{cursor:default}
.dsm-workbuddy-composer-panel-dot{
  flex:none;width:7px;height:7px;border-radius:50%;
  background:var(--dsw-alias-label-dimmed,rgba(127,127,127,.5));
}
.dsm-workbuddy-composer-panel-table tr.dsm-workbuddy-composer-panel-row-current .dsm-workbuddy-composer-panel-dot{
  background:var(--dsw-state-success,#22a06b);
}
.dsm-workbuddy-composer-panel-foot{
  display:flex;justify-content:space-between;gap:8px;
  margin-top:9px;padding-top:7px;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
  font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,GrayText);
}
.dsm-workbuddy-composer-panel-empty{margin:0;color:var(--dsw-alias-label-tertiary,GrayText)}
.dsm-workbuddy-composer-panel-error{margin:8px 0 0;color:var(--dsw-alias-state-error-primary,#d92d20);font-size:11px;line-height:16px}
`
