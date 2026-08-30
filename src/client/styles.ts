/**
 * Client styles for the WorkBuddy plugin card.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 整套 `dsm-*` 卡片样式系统（卡片外壳、按钮原语、`--dsw-alias-*`
 *     主题变量与十六进制回退值）逐字沿用自该项目，其又复制自
 *     dingminhua/dsh-subagent-default-model（MIT）的 SETTINGS_CSS。
 *     沿用目的是让两个插件共享同一套外部表现语言。
 * 改动：类名由 `dsm-trae-*` 改为 `dsm-workbuddy-*`；
 *   移除 trae 特有的 1M 变体样式，新增按套餐聚合的积分行样式。
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
.dsm-plugin-card-chevron{color:var(--dsw-alias-label-tertiary,#999);flex:none;display:inline-flex;transition:transform .16s}
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
.dsm-workbuddy-usage-account{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:14px;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-workbuddy-usage-account-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsm-workbuddy-usage-expiry{padding-left:19px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}
.dsm-workbuddy-account-picker{display:block}
.dsm-workbuddy-usage-select-wrap{position:relative}
.dsm-workbuddy-usage-select{appearance:none;width:100%;font:inherit;padding:10px 34px 10px 12px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-3,#2a2c33);cursor:pointer;transition:border-color .15s,box-shadow .15s}
.dsm-workbuddy-usage-select:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#5686fe);box-shadow:0 0 0 3px rgba(86,134,254,.22)}
.dsm-workbuddy-usage-select:disabled{opacity:.6;cursor:default}
.dsm-workbuddy-usage-select-wrap::after{content:"";position:absolute;top:50%;right:12px;width:7px;height:7px;transform:translateY(-65%) rotate(45deg);border-right:1.6px solid var(--dsw-alias-label-secondary,#c6c9d0);border-bottom:1.6px solid var(--dsw-alias-label-secondary,#c6c9d0);pointer-events:none}
.dsm-workbuddy-usage-text{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary,#b8b8b8)}
.dsm-workbuddy-usage-error{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-workbuddy-usage-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.dsm-workbuddy-usage-status{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6)}
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
.dsm-workbuddy-models-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsm-workbuddy-models-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}
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
.dsm-workbuddy-model-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px}
.dsm-workbuddy-model-actions-buttons{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dsm-workbuddy-usage-cheer{display:inline-flex;align-items:center;gap:4px;flex:none;text-decoration:underline;text-underline-offset:2px;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5;transition:color .16s}
.dsm-workbuddy-usage-cheer-star{font-size:12px;line-height:1;display:inline-flex}
.dsm-workbuddy-usage-cheer:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-usage-cheer:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:2px}
`
