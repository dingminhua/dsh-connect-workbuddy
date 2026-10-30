/**
 * Client styles for the WorkBuddy plugin card.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 整套 dsm-* 卡片样式系统（卡片外壳、按钮原语、--dsw-alias-*
 *     主题变量与十六进制回退值）逐字沿用自该项目，其又复制自
 *     dingminhua/dsh-subagent-default-model（MIT）的 SETTINGS_CSS。
 *     沿用目的是让两个插件共享同一套外部表现语言。
 * 改动：类名由 dsm-trae-* 改为 dsm-workbuddy-*；
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
/* The provider bar: one CARD per region, side by side.
 *
 * COPIED FROM dsh-connect-trae, rule for rule, because an approximation of it
 * read as a different component. An earlier revision marked the selected card
 * with 1px border PLUS an inset 1.5px hairline in the contrast colour, and
 * that is 2.5 CSS px of near-black on a 2x display — five device pixels of
 * frame against the reference's one. What the reference does instead:
 *
 *   - selected = the accent COLOUR on the same 1px border, plus a slightly
 *     darker fill. The LIGHTNESS carries the state, not the thickness.
 *   - the switch is separated from the label by a hairline RULE inside the
 *     card (border-left in border-l1), not by dead space. That rule is what
 *     makes the switch read as a second control in the same box rather than
 *     as a floating square at the card's right edge.
 *   - the cell owns its padding (8px 12px) and the tab button has none, so
 *     the label's text sits at a predictable inset no matter how the button's
 *     focus ring draws.
 *   - 10px corner radius, matching the reference's card shape.
 *
 * The row stays what it was semantically: role="tablist" with one button per
 * region, and the checkbox inside each card is a SEPARATE control (switch this
 * provider on/off) — never merged into the tab action. Both regions can be on
 * at once, so this must not become a radio group just because the cards look
 * like one.
 *
 * The checkbox is the PLATFORM'S OWN, styled only with accent-color — the
 * same three declarations the reference card has, no more. An earlier revision
 * drew it here (appearance:none, 15px square, 3px radius, a tick made of two
 * rotated borders) on the theory that pinning the geometry would match the
 * reference across platforms. It did not: the reference does not draw it, so
 * the drawn box was a second, invented control sitting in the same row as the
 * real one. Measured against the screenshot, its box is 26 device px on a 2x
 * display — 13 CSS px, which is the engine's own default size, not a number
 * anyone wrote down.
 *
 * accent-color hands size, radius and tick glyph to the platform. That is the
 * point: the box then follows the reader's OS and theme, which is what makes
 * it read as a checkbox rather than as a painted square. */
.dsm-workbuddy-tabs{display:flex;gap:8px;align-items:stretch}
.dsm-workbuddy-tab-cell{display:flex;align-items:center;gap:4px;flex:1;min-width:0;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#2a2c33);transition:border-color .15s,background .15s}
.dsm-workbuddy-tab-cell:hover{border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-workbuddy-tab-cell:has(.dsm-workbuddy-tab-active){border-color:var(--dsw-alias-brand-primary,#5686fe);background:var(--dsw-alias-bg-layer-2,#232529)}
.dsm-workbuddy-tab{appearance:none;font:inherit;cursor:pointer;flex:1;min-width:0;border:0;border-radius:7px;padding:0;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:600;line-height:20px;text-align:left;background:transparent;transition:color .15s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsm-workbuddy-tab:hover:not(:disabled):not(.dsm-workbuddy-tab-active){color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-tab-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:baseline}
/* The hairline rule between the label and the switch. The auto left margin is
   what pushes the switch to the card's right edge; without it the rule would
   sit tight against the text. */
.dsm-workbuddy-tab-switch{display:inline-flex;align-items:center;flex:none;margin-left:auto;padding-left:10px;border-left:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));cursor:pointer}
.dsm-workbuddy-tab-switch input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-workbuddy-tab-switch input:disabled{cursor:default}
/* SECTION TABS: the card's own top-level split (accounts / models / diagnostics).
 *
 * Deliberately NOT the boxed cells above. Those are the REGION scope — a
 * two-way either/or, each side carrying its own on/off switch — while these are
 * panels of ONE document, the shape a reader already knows from the app's own
 * settings window. Two rows of boxes would read as one four-way choice.
 *
 * The hidden attribute on each panel is what does the work: an inactive panel
 * stays MOUNTED, so switching back does not refetch, a half-filled catalog draft
 * survives the trip, and the account pool keeps its log. It also takes the
 * inactive panel out of the accessibility tree, which is exactly what
 * role="tabpanel" wants — unlike display:none reached by a CSS class, it
 * cannot be overridden by a later rule. */
.dsm-workbuddy-panels{display:flex;align-items:stretch;gap:2px;margin:16px 0 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24))}
.dsm-workbuddy-panel-tab{appearance:none;font:inherit;cursor:pointer;border:0;background:transparent;padding:7px 11px;margin-bottom:-1px;border-bottom:2px solid transparent;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:600;line-height:20px;white-space:nowrap;transition:color .15s,border-color .15s}
.dsm-workbuddy-panel-tab:hover:not(.dsm-workbuddy-panel-tab-active){color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-panel-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-panel-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6);border-bottom-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-workbuddy-panel{margin-top:12px}
/* DIAGNOSTICS: a two-column fact table rather than prose. Each row is one thing
 * the card actually READ, so a bug report can quote a line instead of
 * paraphrasing the UI. No control lives here on purpose — a diagnostics panel
 * that can change settings is a settings panel with a worse name. */
.dsm-workbuddy-diag{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#232529)}
.dsm-workbuddy-diag-row{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:8px 12px}
.dsm-workbuddy-diag-row+.dsm-workbuddy-diag-row{border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24))}
.dsm-workbuddy-diag-label{flex:none;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-workbuddy-diag-value{min-width:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px;line-height:18px;text-align:right;overflow-wrap:anywhere}
.dsm-workbuddy-diag-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dsm-workbuddy-diag-bad{color:var(--dsw-alias-label-caution,#e8b34b)}
.dsm-workbuddy-diag-hint{margin:10px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
/* PREFERENCE LINES: a checkbox on a line that commits on the click, packed from
   the LEFT — the shape the reference card uses for this exact block.
 *
 * They belong to the TAB block above and carry no heading of their own, because
 * both switches describe THIS tab. Earlier revisions gave them a headed section,
 * which meant a second 「积分」 heading one line under the tab hint; the reference
 * card never had one either.
 *
 * The picker used to sit at the row's far edge, pushed there by
 * justify-content:space-between. That split one sentence into two objects with
 * half a card of empty space between them, and left the reader to guess which
 * label the control belonged to. Here nothing in a row stretches: the words ask
 * the question and the control answers right beside them.
 *
 * align-items:flex-start, not center: the hint wraps to two lines at narrow
 * widths, and centring would float the checkbox against the middle of it.
 *
 * No horizontal inset: the reference card pads this block by the same 2px its
 * tab hint carries, so box and caption share one left edge. THIS card's tab hint
 * (the dsm-workbuddy-models-summary class) has no side padding, so copying the
 * reference's 2px would leave the two edges 2px apart — a difference too small
 * to name and just big enough to look unaligned. */
.dsm-workbuddy-prefs{display:flex;flex-direction:column;gap:14px;padding:2px 0 0}
.dsm-workbuddy-pref{display:flex;align-items:flex-start;gap:10px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0);cursor:pointer}
/* The platform's own checkbox, themed only with accent-color. A hand-drawn box
   was tried on this card and reverted: brand-primary resolves to the host's
   CONTRAST colour, so a ticked box painted itself as a heavy black pill — the
   loudest object in a section made of plain 13px text. */
.dsm-workbuddy-pref input{flex:none;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-workbuddy-pref-check,.dsm-workbuddy-image-tool-check,.dsm-workbuddy-video-tool-check,.dsm-workbuddy-cli-bridge-check,.dsm-workbuddy-upstream-check,.dsm-workbuddy-channel-continue-check{inline-size:15px;block-size:15px;margin:3px 0 0}
/* The upstream-identity switches are their own group, so they get a divider
   above them instead of relying on spacing alone: they change the request the
   whole plugin sends, not a per-region display choice, and reading them as the
   tail of the preference list would misrepresent what flipping one costs. */
.dsm-workbuddy-upstream-pref{margin-top:4px}
.dsm-workbuddy-upstream-pref:first-of-type{border-top:1px solid var(--dsw-alias-bg-layer-3,#2e3034);padding-top:10px}
.dsm-workbuddy-pref input:disabled{cursor:default}
.dsm-workbuddy-pref:has(input:disabled){opacity:.6;cursor:default}
/* The NAME and what it does are TWO lines, not one wrapped blob: first what the
   switch does, then what it means. Running them together is what made this
   block read as a wall of text. */
.dsm-workbuddy-pref-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsm-workbuddy-pref-label{font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6)}
/* The picker's own line: indented by the checkbox's width plus the row gap
   (15px + 10px), so its label starts on the same left edge as the checkbox
   labels above it rather than under their boxes. */
.dsm-workbuddy-pref-indent{padding-left:25px}
/* Name then control, packed left — 显示位置 [输入框工具栏] — so the row reads as
   one sentence instead of a text column facing a control column. */
.dsm-workbuddy-pref-lead{display:flex;align-items:center;justify-content:flex-start;gap:10px;min-width:0}
.dsm-workbuddy-pref-lead .dsm-workbuddy-pref-label{flex:none}
.dsm-workbuddy-pref-hint{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:17px}
/* The media roster: a READ-ONLY list, so it is drawn as quiet rows rather than
   as a table — it answers "what can this tab draw with" in passing, and must
   not compete with the switches above it for attention. The id is monospace
   and dimmer than the name because it is the string a tool call has to pass,
   not the thing a human reads; the tag chips carry the only colour, one hue
   per direction (text→image vs image→image), so the grouping is visible
   without a legend. */
/* Aligned with the indented rows above it, but under its OWN class: the
   credit position picker owns .dsm-workbuddy-pref-indent, and the card suite
   resolves that selector expecting the picker. This block is a block (lead
   row + hint + list), not a single indented line. */
.dsm-workbuddy-media{padding-left:25px}
.dsm-workbuddy-media-list{margin:2px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.dsm-workbuddy-media-row{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px;min-width:0}
.dsm-workbuddy-media-name{color:var(--dsw-alias-label-secondary,#b8bcc4);font-size:12px}
.dsm-workbuddy-media-id{color:var(--dsw-alias-label-tertiary,#8b8f98);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.dsm-workbuddy-media-tags{display:inline-flex;flex-wrap:wrap;gap:4px}
.dsm-workbuddy-media-tag{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b8f98)}
/* The per-mode video-model picker. It reuses .dsm-workbuddy-media-row so the
   tag chip and the select sit on one baseline, like a roster row does. */
.dsm-workbuddy-video-model-select{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,#b8bcc4);background:var(--dsw-alias-bg-l1,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:1px 6px;max-width:100%;min-width:0}
.dsm-workbuddy-video-model-select:disabled{opacity:.6}
.dsm-workbuddy-media-empty,.dsm-workbuddy-media-error{font-size:12px;line-height:17px}
.dsm-workbuddy-media-empty{color:var(--dsw-alias-label-tertiary,#8b8f98)}
.dsm-workbuddy-media-error{color:var(--dsw-alias-label-error,#e5675f)}
/* The supplement to the host's fixed quota sentence (issue #63). The plugin no
   longer claims the host's shell.quota-notice chain seat, so this no longer
   paints into shell.overlay — that seat is the reason the previous build's
   inline span parked at the overlay's TOP-LEFT as a box the maintainer had
   never seen before. It is kept inline and box-free for the surface that
   renders it INSIDE a line of conversation: the moment it paints a box it stops
   being a parenthetical and becomes the dialog that was already rejected once.
   The body is one step quieter than the text it follows. */
.dsm-workbuddy-quota-notice{display:inline}
.dsm-workbuddy-quota-notice-body{color:var(--dsw-alias-label-tertiary,#8b8f98);font-size:12px}
/* The seat picker is the PLATFORM's select, sized by its own two options rather
 * than stretched: the control answers one short question and sits beside the
 * words that ask it.
 *
 * This was drawn by hand for one revision — appearance:none, a layer-2 panel and
 * a chevron built from two rotated gradients — copying a reference screenshot's
 * white field. That does not survive the trip: the screenshot was a LIGHT
 * settings page, this card is dark, and the drawn field ended up the only
 * element here with its own fill, border and arrow, so it read as a form control
 * pasted into a paragraph. The reference card's own dark build uses the native
 * control with a hairline border, which is what this rule is.
 *
 * Sized by content, not by a min-width: it used to carry min-width:132px so it
 * could share a heading row with the account badge, and that floor is now the
 * reason a two-word option would still leave a gap after the word it answers. */
.dsm-workbuddy-credit-position{flex:none;max-width:none;margin-top:0;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:7px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:12px;line-height:16px;cursor:pointer}
.dsm-workbuddy-credit-position:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-workbuddy-credit-position:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-credit-position:disabled{opacity:.5;cursor:default}
/* The quick-adjust pins of the CLI route (model, effort): two native selects
   side by side, the same hairline-bordered rule as the seat picker — content-
   sized, no chevron build, no own fill. The row rides the switch row's
   dsm-workbuddy-pref-indent indent, because it answers a question the switch
   above it poses. */
.dsm-workbuddy-cli-bridge-pickers{flex-wrap:wrap}
.dsm-workbuddy-cli-bridge-pick{display:flex;align-items:center;gap:6px;min-width:0}
.dsm-workbuddy-cli-bridge-select{flex:none;max-width:none;margin-top:0;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:7px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:12px;line-height:16px;cursor:pointer}
.dsm-workbuddy-cli-bridge-select:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-workbuddy-cli-bridge-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-cli-bridge-select:disabled{opacity:.5;cursor:default}
/* A card whose provider is switched OFF dims its LABEL AND DOT. The checkbox
 * beside them must stay at full strength, because that checkbox is the only
 * way to switch the region back on — dimming it would grey out the control
 * that fixes the state it is reporting. Its own disabled rule still dims it
 * when writes are unavailable, which is a different condition and reads as a
 * different thing.
 *
 * That is also what the reference card does: it marks the off state on the
 * tab button and leaves the switch live. */
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
/* A failed status read is recoverable, so the banner carries an action: the
   message alone told the user nothing they could do but close the card. */
.dsm-workbuddy-usage-error-block{display:flex;flex-direction:column;align-items:flex-start;gap:10px;margin-top:12px}
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
/* The one grey line that states what a section is FOR, at the top of a panel.
   Kept as its own class instead of reusing the models-summary class: the same
   rule now heads the capability section, whose vocabulary has nothing to do with
   models, and a shared name would send the next reader to the wrong panel. */
.dsm-workbuddy-panel-note{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
/* The free-model quota warning (see the tabFreeQuotaWarn locale key). Bold on
   purpose, and it keeps the summary's own grey rather than the primary label
   colour: it has to stand out from the three lines around it WITHOUT reading as
   an error banner, because the fact it states is normal product behaviour
   rather than a failure. Weight is the only signal it needs. */
.dsm-workbuddy-free-quota-warn{font-weight:600}
/* Every model is laid out in full — NO inner scroll box.
 *
 * The previous rule capped this at max-height 520px with overflow-y auto, so a
 * 20-model roster showed about seven rows and hid the rest behind a scrollbar
 * the user had to discover and then drag inside a panel that already scrolls.
 * A model picker whose whole job is "let me see and tick models" should not
 * have two scrollbars stacked on top of each other.
 *
 * overflow:hidden stays, and it is load-bearing rather than vestigial: the
 * rounded corners are drawn by this bordered box, so without clipping the first
 * and last row would paint square corners over it. Nothing is CLIPPED by it any
 * more, because the box is now exactly as tall as its contents.
 *
 * NOTE: no backticks in CSS comments inside this template literal — one would
 * terminate the string early and silently drop every rule after it. */
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
.dsm-workbuddy-model-off-blocked{cursor:not-allowed;opacity:.75}
.dsm-workbuddy-model-off-flag{margin-left:2px;padding:0 4px;border-radius:4px;background:var(--dsw-alias-label-caution-background,#4a3a1f);color:var(--dsw-alias-label-caution,#e8b34b);font-size:10px;line-height:14px;white-space:nowrap}
.dsm-workbuddy-model-copy{display:flex;align-items:baseline;gap:8px;min-width:0}
.dsm-workbuddy-model-name{display:inline-flex;align-items:baseline;gap:7px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:500;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-model-name-rate{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-weight:400;line-height:16px;flex:none}
/* The upstream's own promotion badge ("限时免费" / "Free now" / "Pro Only").
   The colour is the upstream's own, handed in as a custom property; without
   one the brand colour stands in. "flex:none" keeps the badge whole while the
   model name beside it truncates with an ellipsis. The plain background comes
   first so an engine without color-mix still gets a readable chip. */
.dsm-workbuddy-model-label{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;vertical-align:baseline}
/* The same chip, inside the HOST's picker. A model row there is one line wide
   and already carries the name, the check mark and the load icon, so the chip
   gets a hard ceiling and the TEXT inside it truncates — the chip itself must
   stay whole, because a half-drawn pill reads as a rendering bug. "6em" at the
   chip's 10px is about six characters: enough for "夜间折扣", not enough for a
   label to push the row's own controls out of view. */
.dsm-workbuddy-model-label-promo{max-width:6em;overflow:hidden}
.dsm-workbuddy-model-label-promo-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The "本机首次见到" marker: the SAME quiet ink as the composer pill's
   "· N 新模型" segment (label-dimmed), but no chip border and one step smaller,
   so it reads as a side note beside the promotion chip rather than a second
   badge competing with the model name. */
.dsm-workbuddy-model-label-new{flex:none;display:inline-flex;align-items:center;padding:0 5px;border-radius:999px;font-size:10px;line-height:16px;font-weight:600;white-space:nowrap;color:var(--dsw-alias-label-dimmed,rgba(127,127,127,.6))}
.dsm-workbuddy-busy{flex:none;display:inline-flex;align-items:center;block-size:12px;color:var(--dsm-workbuddy-busy-color);vertical-align:-2px}
.dsm-workbuddy-busy svg{display:block;block-size:12px;inline-size:auto}
.dsm-workbuddy-model-promo{flex:none;display:inline-flex;align-items:center;padding:0 7px;border-radius:999px;font-size:10px;line-height:16px;font-weight:600;white-space:nowrap;color:var(--dsm-workbuddy-promo-color,var(--dsw-alias-brand-primary,#5686fe));background:rgba(255,255,255,.08);background:color-mix(in srgb,var(--dsm-workbuddy-promo-color,var(--dsw-alias-brand-primary,#5686fe)) 16%,transparent);border:1px solid transparent;border-color:color-mix(in srgb,var(--dsm-workbuddy-promo-color,var(--dsw-alias-brand-primary,#5686fe)) 40%,transparent)}
.dsm-workbuddy-model-id{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-model-desc{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}
.dsm-workbuddy-model-details{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.dsm-workbuddy-model-meta{display:flex;align-items:center;gap:7px 12px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
.dsm-workbuddy-model-meta-tag{padding:1px 7px;border-radius:999px;font-size:11px;line-height:15px;background:rgba(174,179,187,.11);color:var(--dsw-alias-label-secondary,#c6c9d0)}
/* The per-model default thinking tier (issue #179). It lives INSIDE the meta row
   so it sits on the same baseline as the context/output figures it belongs with,
   and stays a small inline control rather than a third row of its own — the row
   already carries the probe buttons on its right-hand side. */
.dsm-workbuddy-model-effort{display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.dsm-workbuddy-model-effort-select{font:inherit;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary,#c6c9d0);background:rgba(174,179,187,.11);border:1px solid transparent;border-radius:999px;padding:1px 6px;cursor:pointer;max-width:180px}
.dsm-workbuddy-model-effort-select:hover:not(:disabled){border-color:var(--dsw-alias-border-l2,#3a3d45)}
.dsm-workbuddy-model-effort-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-model-effort-select:disabled{opacity:.55;cursor:default}
.dsm-workbuddy-context-budget{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex:none;margin:0;padding:0;border:0;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-workbuddy-context-budget label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
.dsm-workbuddy-context-budget input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-workbuddy-model-capability-note{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
/* Model probe (test button + result). The result line is its own row under the
   meta line, because a cooldown sentence ("rate limited - the upstream gave no
   time") does not fit next to the context/output chips, and truncating it would
   hide exactly the part the user needs. */
/* FOUR buttons now live here (refresh + two availability sweeps + the speed
   sweep added for issue #92), and the labels are long in Chinese
   (一键测速启用模型). flex:none alone let the group run past the header on a
   narrow card, so the group may WRAP and each label refuses to break mid-word —
   the same failure the pool row's action buttons had. The wrap is what makes a
   fourth button safe; without it the header would need a scroll. */
.dsm-workbuddy-models-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.dsm-workbuddy-models-head-actions .dsm-btn{white-space:nowrap}
/* The sweep buttons keep the outline weight of the refresh button beside them, so
   the header reads as one group of equal actions. */
.dsm-workbuddy-models-sweep{white-space:nowrap}
.dsm-workbuddy-models-sweep-summary{margin:6px 0 0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
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
/* The block's heading: title on the left, serving-account badge on the right.
 *
 * It used to hold a THIRD child — the credit-readout switch, slotted in between
 * the title and the badge by the card. A control that configures something else
 * spent several revisions sitting inside this block's title, and it forced the
 * row onto a shared baseline with a picker whose width shoved the badge to the
 * far edge. The switch now has its own section above; what is left is the one
 * thing that is genuinely this block's title row.
 *
 * The badge is pushed right with margin-left:auto rather than the row using
 * space-between, so it stays on the right edge even if a future change adds a
 * child or removes one. */
.dsm-workbuddy-pool-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
/* SOLID badge: white ink on the success green itself, plus a matching hairline.
 *
 * This is deliberately a stronger stop than a tinted pill. Green TEXT on the old
 * pale-blue tint still read as a quiet annotation — and a comment that has to be
 * looked for is not doing its job when the badge's whole point is "THIS row is
 * the one serving". Filled also matches how the host marks primary affordances.
 *
 * Both halves now come from the SAME token, so they cannot drift apart the way
 * they did when the ink was --dsw-alias-brand-primary — the host's CONTRAST
 * colour, which painted near-BLACK on light themes (see the checkbox note at
 * line ~118). Theme-following: #22c55e dark / #16a34a light.
 *
 * Contrast: white on #22c55e ≈ 2.2:1, on #16a34a ≈ 3.3:1 — under the 4.5:1 bar
 * for body text, which is why the badge stays 11-12px and BOLD and never carries
 * a sentence: it is read as a shape first, a word second. The border keeps the
 * pill from bleeding into the row tint if a theme remaps success to something
 * dark. */
.dsm-workbuddy-pool-current-badge{margin-left:auto;padding:2px 10px;border-radius:999px;background:var(--dsw-alias-state-success-primary,#22c55e);border:1px solid rgba(34,197,94,.55);color:#fff;font-size:12px;font-weight:600;line-height:18px;white-space:nowrap}
/* Sits under the header block, before the batch buttons: account discovery is
   the first step of using the pool, so it reads above the actions it enables. */
/* THE HEAD SLOT — one place that answers "who is serving?".
 *
 * With the pool off it holds the account picker, with the pool on the badge.
 * Both are pushed right by the same rule so the header does not jump between
 * the two states. The picker used to live in a settings row of its own further
 * down the page, which meant the same account name appeared in the title row,
 * in that row, and again in the member table. */
.dsm-workbuddy-pool-head-pick{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:12px}
.dsm-workbuddy-pool-head-pick-label{color:var(--dsw-alias-label-secondary,#c6c9d0);white-space:nowrap}
.dsm-workbuddy-pool-account-select{min-width:200px}
.dsm-workbuddy-pool-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-pool-badge{flex:none;padding:2px 9px;border-radius:999px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-brand-primary,#5686fe);background:rgba(86,134,254,.12);border:1px solid rgba(86,134,254,.32)}
/* No top rule: this bar now hangs directly under 「本池包含的账号 / 已选 N / M /
   全选 / 全不选」 and acts on exactly that set, so a separator here would cut the
   buttons away from the count that explains them. The divider that matters is
   the one the member block has against 「更多设置」 below. */
.dsm-workbuddy-pool-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsm-workbuddy-pool-actions-group{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-workbuddy-pool-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-pool-note{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-pool-warn{margin:0;padding:9px 11px;border-radius:9px;font-size:12px;line-height:17px;color:var(--dsw-alias-state-warn-primary,#f59e0b);background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.3)}
/* Ghost members (issue #60): the warning plus one removable chip per id. The
   chips are what make the warning actionable — a ghost has no row in the table
   above, because that roster is the sign-ins this machine still has. */
.dsm-workbuddy-pool-ghosts{display:flex;flex-direction:column;gap:6px}
.dsm-workbuddy-pool-ghost-list{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.dsm-workbuddy-pool-ghost{display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 9px;border-radius:999px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary,#f59e0b);background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.3)}
.dsm-workbuddy-pool-ghost-name{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-pool-ghost-remove{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:999px;font-size:11px;line-height:1;cursor:pointer;color:inherit;background:transparent}
.dsm-workbuddy-pool-ghost-remove:hover:not(:disabled){background:rgba(245,158,11,.2)}
.dsm-workbuddy-pool-ghost-remove:disabled{cursor:default;opacity:.5}
.dsm-workbuddy-pool-error{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary,#ef4444);white-space:pre-line}
.dsm-workbuddy-pool-table{border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-workbuddy-pool-row{display:grid;grid-template-columns:1.6fr 1fr 1.3fr .9fr .8fr;gap:10px;align-items:center;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d31);font-size:13px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
/* No check-in column (the international region): the freed track goes to the actions. */
.dsm-workbuddy-pool-table:not(.dsm-workbuddy-pool-table-checkin) .dsm-workbuddy-pool-row{grid-template-columns:1.6fr 1fr 1.3fr 1.7fr}
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
.dsm-workbuddy-pool-account-name .dsm-workbuddy-pool-current-tag{align-self:flex-start;margin-top:2px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-state-success-primary,#22c55e);border:1px solid rgba(34,197,94,.55);color:#fff;font-size:11px;font-weight:600;line-height:16px;white-space:nowrap}
/* Manual-priority chrome (order badge + up/down arrows). The rank badge is a SPAN,
   not a button: it only DESCRIBES the current order and must not read as a
   control (nor join the row's button list). The solid vs dashed distinction is
   load-bearing — a numeric rank must NOT appear when the credit policy still
   decides the order, so the -auto modifier is the dashed/grey state. */
.dsm-workbuddy-pool-account-name .dsm-workbuddy-pool-order{display:flex;align-items:center;gap:6px;margin-top:2px;flex-wrap:wrap}
.dsm-workbuddy-pool-account-name .dsm-workbuddy-pool-rank{display:inline-flex;align-items:center;border-radius:999px;border:1px solid rgba(86,134,254,.32);background:rgba(86,134,254,.12);color:var(--dsw-alias-brand-primary,#5686fe);font-size:11px;font-weight:600;line-height:16px;padding:1px 6px;white-space:nowrap;cursor:default;font-variant-numeric:tabular-nums}
.dsm-workbuddy-pool-account-name .dsm-workbuddy-pool-rank-auto{border:1px dashed var(--dsw-alias-border-l1,#2c2d31);background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-pool-account-name .dsm-workbuddy-pool-move{display:inline-flex;align-items:center;gap:2px}
.dsm-workbuddy-pool-account-name .dsm-workbuddy-pool-move-btn{width:18px;height:18px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#2c2d31);background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:1;cursor:pointer}
.dsm-workbuddy-pool-account-name .dsm-workbuddy-pool-move-btn:disabled{opacity:.4;cursor:default}
/* Hover/focus must change BOTH halves of the contrast pair.
   The rule this replaces recoloured only the glyph — to
   --dsw-alias-label-primary (#e6e6e6) — and left the background as it was. In
   the LIGHT theme that token is near-WHITE, so on hover the arrow painted
   white-on-light and vanished under the cursor (reported as "the up arrow
   disappears when I hover"). Recolouring text without also repainting its
   backdrop is unsafe whenever the two come from independent tokens, so this
   sets an explicit tinted background and keeps the glyph on the brand colour,
   which is legible in both themes. The outline is a third, theme-independent
   affordance so the target is findable even if a token is remapped. */
.dsm-workbuddy-pool-account-name .dsm-workbuddy-pool-move-btn:not(:disabled):hover,
.dsm-workbuddy-pool-account-name .dsm-workbuddy-pool-move-btn:not(:disabled):focus-visible{background:rgba(86,134,254,.16);border-color:rgba(86,134,254,.55);color:var(--dsw-alias-brand-primary,#5686fe);outline:2px solid rgba(86,134,254,.45);outline-offset:1px}
.dsm-workbuddy-pool-excluded{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
/* The ordering-rule disclosure, placed directly above the member table.
   A native <details>: the marker is left to the browser so the control keeps
   its built-in keyboard and screen-reader behaviour. The summary is a full-width
   row because a 12px grey label on its own is a small click target, and this is
   the one place a confused user is meant to click. */
.dsm-workbuddy-pool-order-rules{border:1px solid var(--dsw-alias-border-l1,#2c2d31);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#232529);overflow:hidden}
.dsm-workbuddy-pool-order-rules-summary{padding:8px 12px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;font-weight:600;line-height:18px}
.dsm-workbuddy-pool-order-rules-summary:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-pool-order-rules-summary:focus-visible{outline:2px solid rgba(86,134,254,.55);outline-offset:-2px}
.dsm-workbuddy-pool-order-rules-body{display:flex;flex-direction:column;gap:8px;padding:0 12px 12px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d31);padding-top:10px}
/* The rules already carry their own "1." … "8." inside the sentence, so the <ol>
   is semantic only. Suppressing the marker keeps a single number on screen
   instead of "1. 1. …". */
.dsm-workbuddy-pool-order-rules-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-pool-order-rules-list li{padding-left:2px}
/* The "why expiring credits win" note is the sentence users push back on, so
   it is tinted rather than buried in the same grey as the eight rules. */
.dsm-workbuddy-pool-order-rules-why{margin:0;padding:8px 10px;border-radius:8px;border-left:3px solid var(--dsw-alias-state-warn-primary,#f59e0b);background:rgba(245,158,11,.10);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-pool-credits{display:flex;flex-direction:column;gap:1px;min-width:0;font-variant-numeric:tabular-nums}
.dsm-workbuddy-pool-credits b{color:var(--dsw-alias-label-primary,#e6e6e6);font-weight:600}
.dsm-workbuddy-pool-soon{font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-workbuddy-pool-soon-plain{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999)}
/* Claimable benefits (issue #79). A quiet line by default — it is an opportunity, not a fault — and loud only when the window is about to close. */
.dsm-workbuddy-pool-benefits{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999);min-width:0}
/* One entry = text + pill, and the text wraps rather than being cut.
   The tag used to be nowrap + ellipsis, which truncated the label to
   「模型服务异常补偿…」 — dropping the amount, i.e. the only part the user is
   deciding on. Measured in headless Chrome at the card's real width, the entry
   line has room for two lines, so the tag clamps to two and shows the whole
   label; the pill wraps to the line below and never shrinks.
   line-clamp, not plain wrapping: an unexpectedly long upstream title must not
   push the row taller than the pill can travel. */
.dsm-workbuddy-pool-benefit-tag{min-width:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
/* min-width:0 IS the whole fix (issue #79).
   The pill made this entry's min-content 229px (full line + button) inside a
   148px column, so it painted over the probe column beside it.
   A flex ITEM defaults to min-width:auto and refuses to shrink below its
   content, which is what pinned it at 229; min-width:0 lets the tag ellipsize
   and the pill keep its size.

   Measured in headless Chrome against the real rendered row, as an A/B:
     min-width:0        -> 0 overflowing children, entry 148px
     without it          -> 3 overflowing children, entry 229px
   Changing the row's grid tracks to minmax(0,...) was tried too and made NO
   difference (the entry overflows its CELL, so the CELL was never the
   constraint) — so the tracks are left as they were. */
.dsm-workbuddy-pool-benefit{display:flex;flex-wrap:wrap;align-items:center;gap:2px 5px;min-width:0;max-width:100%}
.dsm-workbuddy-pool-benefit-urgent{color:var(--dsw-alias-state-warn-primary,#f59e0b);font-weight:600}
/* The claim pill: a solid amber call to action.
   Orange, not the brand blue, because this is the ONE control in the pool that
   hands the user something (500 credits) instead of spending their attention on
   a read-only figure. It should read as an opportunity, and amber is the hue
   that says "take this" without shouting.

   Solid fill rather than a tinted outline: at 19px tall and 46px wide, a tinted
   outline sat next to the 1,294 credit figure above it and read as DISABLED.
   The solid fill also survives the row's grey text without competing for the
   eye. The card's own 已签到 green is the only other saturated element here.

   Load-bearing details, each measured in headless Chrome:
   - white-space:nowrap: without it the flex row squeezed 领取 into 领/取 on
     two lines and the pill grew into a 32px-tall blob;
   - a fixed 19px height, so it matches the 11px text beside it instead of
     inheriting .dsm-btn's padding;
   - flex:none, so the shrinking column eats the TEXT and never the pill. */
/* Order matters: this rule must come AFTER .dsm-btn-outline (line ~36) so its
   amber background wins. Two-class specificity turned out to be the wrong lever
   and was REMOVED after measuring: pairing the classes also beat the
   dsm-workbuddy-pool-small-btn padding, and without dsm-btn-outline on the
   element the button fell back to dsm-btn's default background — rendered white
   on a dark row. Source order is what was already working; keep it. */
.dsm-workbuddy-pool-benefit-btn{
  /* Flex centring plus a 1px nudge is what actually centres 领取.
     Measured on the rendered pill in headless Chrome (OCR-free pixel scan of
     the glyph mask inside the 46x19 box):
       display:inline-flex; align-items:center  ->  above 3.5px, below 4.5px,
                                                     glyph sat 1.0px low
       plus translateY(-0.5px) below           ->  above 4.0px, below 4.0px
     Flex centring centres the LINE BOX, and a CJK glyph's ink sits below the
     centre of its em box, so centring the box leaves the ink low. The nudge
     compensates for the ink, not for the box. It is half a pixel because the
     label renders at 2x on a retina display and 1px would overshoot there. */
  display:inline-flex;
  align-items:center;
  justify-content:center;
  flex:none;
  padding:0 9px;
  height:19px;
  font-size:11px;
  line-height:1;
  font-weight:600;
  border-radius:999px;
  white-space:nowrap;
  letter-spacing:.01em;
  border-color:var(--dsw-alias-state-warn-primary,#f59e0b);
  color:#2a1d05;
  background:var(--dsw-alias-state-warn-primary,#f59e0b);
  /* The only shadow in the pool table: it lifts the pill off the row so the
     control reads as clickable rather than as part of the label. */
  box-shadow:0 1px 2px rgba(0,0,0,.28);
  transition:filter .12s ease;
}
/* Optical centring for the label (issue #79).
   Flex centring centres the LINE BOX, but a CJK glyph's ink sits below the
   centre of that box, so 领取 measured 3.5px above / 4.5px below — visibly low.
   padding-top pushes the ink down by shifting the line box within the centred
   flex item. Measured on the rendered pill in headless Chrome, as a sweep:
     (none)        -> above 3.5 / below 4.5  (+1.0 low)
     padding-top:1px -> above 4.0 / below 4.0  (centred)
     padding-top:2px -> above 4.5 / below 3.5  (-1.0 high)
   transform and padding-bottom were both tried first and moved the ink the
   WRONG way, because both grow the flex item, which re-centres the line box
   downward. Padding-top is the one that shifts the ink up. */
.dsm-workbuddy-pool-benefit-btn > span{display:block;padding-top:1px}
.dsm-workbuddy-pool-benefit-btn:hover:not(:disabled){
  /* Brighten, do not invert: an inverted pill loses its "take this" reading,
     and the dark-on-amber swap is the part that looked cheap in the draft. */
  filter:brightness(1.08);
  border-color:var(--dsw-alias-state-warn-primary,#f59e0b);
  color:#2a1d05;
  background:var(--dsw-alias-state-warn-primary,#f59e0b);
}
.dsm-workbuddy-pool-benefit-btn:active:not(:disabled){filter:brightness(.94)}
/* A row action is in flight: this row, or another one. The pill goes flat so it
   cannot be clicked twice while the first claim is still landing. */
.dsm-workbuddy-pool-benefit-btn:disabled{
  opacity:.45;
  cursor:default;
  box-shadow:none;
}
.dsm-workbuddy-pool-probe,.dsm-workbuddy-pool-checkin{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999);min-width:0;overflow-wrap:anywhere}
.dsm-workbuddy-pool-probe{display:flex;flex-direction:column;gap:4px}
.dsm-workbuddy-pool-probe-main{color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-pool-probe-prov{display:flex;align-items:center;gap:5px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#999);min-width:0;flex-wrap:wrap}
.dsm-workbuddy-pool-prov-tag{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-tertiary,#999);font-size:10px;font-weight:600;line-height:15px;white-space:nowrap}
.dsm-workbuddy-pool-prov-live{background:rgba(245,158,11,.16);color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-workbuddy-pool-prov-unknown{background:var(--dsw-alias-bg-layer-3,#2a2c33);border:1px solid var(--dsw-alias-border-l1,#2c2d31);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-pool-prov-sep{color:var(--dsw-alias-label-dimmed,#9aa0a6);opacity:.7}
.dsm-workbuddy-pool-prov-age{color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}
/* WHICH model a verdict is about (issue #61). Deliberately quiet: it is scope
   information on the provenance line, not a status of its own, so an ok row and
   a rate-limited row must not look different because of it. */
.dsm-workbuddy-pool-prov-model{color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:190px}
.dsm-workbuddy-pool-members{display:flex;flex-direction:column;gap:10px}
.dsm-workbuddy-pool-members-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsm-workbuddy-pool-members-title{margin:0 0 3px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-pool-members-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* The 测试/删除 and 全选/全不选 buttons. Shared with the benefit pill, which
 * OVERRIDES both properties at higher specificity (see its rule above): a pill is
 * a capsule whose height is fixed at 19px, so inheriting this 3px/10px rhythm
 * pushed its own padding/line-height out and changed how the label sat.
 * Kept as-is rather than narrowed to the parents that use it, so the row-action
 * and select-all sizing stays in one place. */
.dsm-workbuddy-pool-small-btn{padding:3px 10px;font-size:12px}
.dsm-workbuddy-pool-check{display:inline-flex;align-items:center;flex:none;cursor:pointer}
.dsm-workbuddy-pool-check input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-workbuddy-pool-check input:disabled{cursor:default;opacity:.5}
.dsm-workbuddy-pool-checked{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-pool-unknown{color:var(--dsw-alias-label-dimmed,#9aa0a6)}
.dsm-workbuddy-pool-not-member{color:var(--dsw-alias-label-dimmed,#9aa0a6)}
/* A section break, not just a gap: below this line the page stops showing what
   the pool IS and starts showing the knobs that change it. Without the rule the
   heading floated under the table with nothing marking the change of subject. */
.dsm-workbuddy-pool-settings-wrap{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:14px}
.dsm-workbuddy-pool-dirty{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-workbuddy-pool-settings{display:flex;flex-direction:column;gap:1px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#24262c)}
/* THE MODE BAR — the page's master control, directly under the title.
 *
 * It reuses the .dsm-workbuddy-pool-settings class for the bordered, stacked
 * look, and on purpose: the component tests locate 「启用账号池」 as the first
 * checkbox inside that class, and a user who has learned "settings live in a
 * bordered block" should not have to learn a second shape for the most
 * important one.
 *
 * What it adds is a brand-tinted edge and background, so it reads as "this
 * decides what the rest of the page means" instead of as one more settings
 * card — the switch used to sit at the BOTTOM, 400px below this point.
 */
.dsm-workbuddy-pool-modebar{padding:12px 14px;gap:8px;border-color:rgba(86,134,254,.36);background:linear-gradient(180deg,rgba(86,134,254,.10),rgba(86,134,254,.02)),var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-workbuddy-pool-modebar-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsm-workbuddy-pool-modebar-label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
/* The mode in words. A switch's position is a 20px shape to decode; this says
   which of the two modes is in force, and therefore how to read the table. */
.dsm-workbuddy-pool-modebar-state{flex:none;padding:1px 9px;border-radius:999px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-brand-primary,#5686fe);background:rgba(86,134,254,.14);border:1px solid rgba(86,134,254,.3)}
.dsm-workbuddy-pool-modebar .dsm-workbuddy-pool-dirty{margin-left:auto}
.dsm-workbuddy-pool-modebar .dsm-workbuddy-pool-note{line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
/* Orthogonal concepts in one sentence when they collide ("in use" vs "in the
   pool"). A left rule marks it as an aside about the row above, not a warning. */
.dsm-workbuddy-pool-serving-note{padding-left:10px;border-left:2px solid rgba(86,134,254,.5);color:var(--dsw-alias-label-secondary,#c6c9d0)}
/* Subheading for "the rest of the settings": one step DOWN from the page title,
   so the panel has one title instead of two equally loud ones. */
.dsm-workbuddy-pool-card-head{display:flex;align-items:center;gap:8px}
.dsm-workbuddy-pool-card-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#c6c9d0)}
/* QR sign-in + export/import, ABOVE the settings block.
   One toolbar row, not a column of two: with the captions gone (the buttons
   name themselves) there is nothing left to stack, and a row is where a user
   looks for instant actions. The dashed edge still separates them from the
   saved preferences below — that contrast is now the whole point, since the
   heading under this row is the one that says 「点保存才生效」.
   Left-aligned, not right: 扫码登录 is the primary action and it should read
   first, in the same left-hand column as 一键签到 above and 「更多设置」 below.
   Pushed to the right edge the three buttons looked like the tail of the row
   above rather than the start of this one. */
.dsm-workbuddy-pool-tools{display:flex;flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:flex-start;gap:8px;border:1px dashed var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;padding:6px 10px}
/* A bar inside the toolbar is a flex item, not a full-width row: it keeps only
   its own content width, and the toolbar decides where the group sits. */
.dsm-workbuddy-pool-tools .dsm-workbuddy-bar{flex:0 1 auto;min-width:0;margin:0}
/* Status text may wrap here instead of truncating: a toolbar row is short, and
   「已导出」「等待扫码」 are the whole message — an ellipsis would eat it. */
.dsm-workbuddy-pool-tools .dsm-workbuddy-bar-status{white-space:normal}
.dsm-workbuddy-pool-set{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:12px 14px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d31)}
.dsm-workbuddy-pool-set:first-child{border-top:0}
.dsm-workbuddy-pool-set-copy{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.dsm-workbuddy-pool-set-copy b{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-pool-set-copy span{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-workbuddy-pool-set-ctl{flex:none;display:flex;align-items:center;gap:8px}
.dsm-workbuddy-pool-num{width:74px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:13px;text-align:center;font-variant-numeric:tabular-nums}
.dsm-workbuddy-pool-select{max-width:260px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:13px;cursor:pointer}
.dsm-workbuddy-pool-select:disabled,.dsm-workbuddy-pool-num:disabled{opacity:.5;cursor:default}
/* The commit row: pinned to the bottom of the viewport while the panel is on
 * screen. The panel is taller than a screen, and the two buttons that make any
 * edit real used to sit at its very bottom — off-screen at the moment the user
 * finished editing, and invisible entirely in a screenshot. Opaque, because
 * content scrolls under it. */
.dsm-workbuddy-pool-save-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px;position:sticky;bottom:0;z-index:2;padding-bottom:8px;background:var(--dsw-alias-bg-layer-3,#2a2c33)}
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
/* Per-row actions (test / remove), right side of each pool row. */
/* Per-row actions (test / remove), right side of each pool row.
   The nowrap is NOT cosmetic: a two-character label (测试) belongs on one line,
   and this row's track is a fraction of the table — in a narrow window it let
   the label break into 测 / 试. Clipping is the right failure for a button
   whose label is fixed and tiny. */
.dsm-workbuddy-pool-row-actions{display:flex;gap:6px;align-items:center;justify-content:flex-end;flex:none}
.dsm-workbuddy-pool-row-actions .dsm-workbuddy-pool-small-btn{white-space:nowrap}
.dsm-workbuddy-pool-row-actions .dsm-workbuddy-pool-small-btn{padding:2px 10px;font-size:12px}
/* This account's own test model (issue #61). Narrower than the section-level
   picker so a long model name cannot push the two buttons out of the row. */
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
/* Account action bars: QR sign-in and export/import.
   One row each — live status, actions — instead of a padded block per feature.
   There is no caption: each bar holds buttons that name themselves, so a
   heading above them would repeat the button in a smaller font (「扫码添加账号」
   over 「扫码登录」). The section keeps an aria-label for the same reason a
   caption existed, so the name is still available to a screen reader.
   The bar is the resting height; only an open dialog (below) grows vertically,
   so the card does not scroll past a wall of chrome to reach the buttons.
   Status text shares the row rather than claiming its own, and is what
   truncates first when the card is narrow. */
.dsm-workbuddy-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0;padding:0}
.dsm-workbuddy-bar-status{flex:1 1 auto;min-width:0;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#e8e9ed);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-bar-hint{color:var(--dsw-alias-label-tertiary,#999)}
.dsm-workbuddy-bar-actions{display:flex;gap:8px;flex:none;margin-left:auto}
.dsm-workbuddy-bar a{color:var(--dsw-alias-brand-primary,#5686fe);text-decoration:none}
.dsm-workbuddy-bar a:hover{text-decoration:underline}
.dsm-workbuddy-bar-ok{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-bar-error{color:var(--dsw-alias-state-error-primary,#ef4444)}
/* Secondary text inside the transfer DIALOG (not a bar): the privacy note
   shown when credentials leave the machine. Kept independent of the bar
   classes so the dialog does not depend on the bar's layout to be readable. */
.dsm-workbuddy-hint{color:var(--dsw-alias-label-tertiary,#999)}
/* The transfer dialog is deliberately a block: it holds a scrollable account
   list and per-entry checkboxes, which cannot live in a one-row bar. */
.dsm-workbuddy-transfer-dialog{margin-top:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;background:var(--dsw-alias-bg-secondary,transparent)}
.dsm-workbuddy-transfer-dialog p{margin:0 0 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#e8e9ed)}
.dsm-workbuddy-transfer-dialog-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.dsm-workbuddy-transfer-list{list-style:none;margin:0 0 8px;padding:0;max-height:180px;overflow-y:auto}
.dsm-workbuddy-transfer-list label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary,#e8e9ed);cursor:pointer;padding:2px 0}
.dsm-workbuddy-transfer-list input[type="checkbox"]{flex:none}
.dsm-workbuddy-transfer input[type="file"]{font-size:12px;color:var(--dsw-alias-label-primary,#e8e9ed);margin-bottom:8px}
/* The import picker's input is driven by the 「import」 button, so it must not
   render as a visible field: hide it from layout AND from assistive tech (the
   button carries the accessible name). Not display:none alone — that also
   removes it from the tab order in some engines, which is fine here, but the
   clip-based form is the one that reliably keeps programmatic .click() working
   across browsers. */
.dsm-workbuddy-transfer-file{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
/* The sign-in URL inside the OAuth dialog: long https links must wrap rather
   than push the dialog wide — break-all, since URLs have no soft wrap points. */
.dsm-workbuddy-oauth-url{word-break:break-all;overflow-wrap:anywhere}
.dsm-workbuddy-oauth-url a{color:var(--dsw-alias-brand-primary,#5686fe);text-decoration:none}
.dsm-workbuddy-oauth-url a:hover{text-decoration:underline}
/* The shared busy veil: a fixed overlay for operations whose result only shows
   up after the list re-read (remove / import / sign-in).
   It is NOT a modal: no control, no dismissal — only "this is running" and
   "here is why nothing moved yet". Fixed positioning so it covers the card
   regardless of which section started the operation, and a semi-transparent
   backdrop so the table stays visible underneath — the user is watching a
   specific row change, and hiding it would defeat the point.

   The mask and the card surface are the HOST's own tokens, not this file's
   invention. --dsw-alias-bg-mask-1 + --dsw-mask-blur is exactly what the
   host's own overlays use (see dsh-client-ui-settings-general's Dws9Sa_mask),
   so the veil now dims the way every other overlay in the shell does instead
   of laying its own black wash on top. The previous hardcoded rgba(0,0,0,.38)
   was tuned against neither theme: too weak next to the host's .24 mask in
   light mode, and it ignored the host's blur entirely.

   bg-layer-2 (not bg-primary, which does not exist in the host's token set
   at all and therefore always fell through to this file's near-black #1b1c20)
   is the same surface the host puts behind its panels — that near-black fallback
   is what made the veil read as a black slab with unreadable text on it. */
.dsm-workbuddy-veil{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32));backdrop-filter:var(--dsw-mask-blur);cursor:progress}
/* --dsw-elevation-prominent is the host's own panel shadow (a hairline stroke
   plus two soft layers); the previous 0 8px 28px rgba(0,0,0,.35) was a
   hand-rolled drop shadow that read as a heavy grey box. */
.dsm-workbuddy-veil-card{display:flex;flex-direction:column;align-items:center;gap:8px;max-width:min(340px,80vw);padding:16px 20px;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.35))}
.dsm-workbuddy-veil-text{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#0f1115);text-align:center}
/* label-secondary, not label-tertiary: this line carries the operation's
   detail and must stay legible. tertiary is the host's dimmest tier
   (neutral-bluish-600 on light, neutral-bluish-400 on dark) and is meant
   for metadata, not for a sentence the user has to read while waiting. */
.dsm-workbuddy-veil-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b);text-align:center}
/* The spinner proves the UI is alive when the row under it has not changed yet
   — which is precisely the confusion the veil exists to remove. It follows the
   host's own state spinner (dsh's _dsh-state-dot-spin): an SVG arc whose
   dash breathes while it turns, currentColor so it inherits the tier it sits
   in, and the same 1.5s beat. The previous 18px border-ring at .7s was roughly
   twice the host's speed and visibly out of step with every other spinner in
   the shell — that mismatch, more than the shape itself, is what made it look
   cheap.

   Reduced-motion users get the static arc rather than a frozen ring, matching
   how the host degrades its own spinner. */
.dsm-workbuddy-veil-spinner{width:20px;height:20px;color:var(--dsw-alias-label-secondary,#61666b);animation:dsm-workbuddy-veil-spin 1.5s linear infinite}
.dsm-workbuddy-veil-spinner-track{opacity:.25}
.dsm-workbuddy-veil-spinner-arc{stroke-dasharray:12 150;animation:dsm-workbuddy-veil-dash 1.5s ease-in-out infinite}
@keyframes dsm-workbuddy-veil-spin{to{transform:rotate(360deg)}}
@keyframes dsm-workbuddy-veil-dash{0%{stroke-dasharray:12 150;stroke-dashoffset:0}50%{stroke-dasharray:24 150;stroke-dashoffset:-6}to{stroke-dasharray:12 150;stroke-dashoffset:0}}
@media (prefers-reduced-motion: reduce){.dsm-workbuddy-veil-spinner{animation:none}.dsm-workbuddy-veil-spinner-arc{animation:none;stroke-dasharray:18 150;stroke-dashoffset:-3}}
`
/**
 * Composer credit readout styles, injected by the readout component itself.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 该项目的 COMPOSER_POINTS_CSS，类名改为 dsm-workbuddy-*，
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
/* The new-model marker ("· 2 新模型") is its OWN button, a sibling of the credit
   trigger inside the same pill — not text bolted into it, so the row is not one
   giant click target and a screen reader can take a user straight to "which
   models". MUTED on purpose, and muted FURTHER than the figure: the credits are
   what this pill exists to show, and the marker only qualifies them, so
   "2 新模型" must never out-shout "143 积分". label-dimmed sits a step below the
   trigger's own label-tertiary for exactly that reason. */
.dsm-workbuddy-composer-credits-new{
  appearance:none;display:inline-flex;align-items:center;align-self:stretch;
  padding:2px 6px;border:0;border-radius:6px;background:transparent;
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-dimmed,rgba(127,127,127,.6));
  white-space:nowrap;cursor:pointer;font-variant-numeric:tabular-nums
}
.dsm-workbuddy-composer-credits-new:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-workbuddy-composer-credits-new:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
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
/* The second line under the name: TWO facts, two tones.
   .dsm-workbuddy-composer-panel-mark-current -- "当前选用", green: it says which
     account is serving this tab, which is not a problem and must not be painted
     like one. The owner asked for exactly this ("框出来的，当前选用用绿色的字").
   .dsm-workbuddy-composer-panel-mark-reason -- why it cannot serve ("被限流"),
     in the warn colour the pool table uses for the same fact, so one
     measurement reads the same on both surfaces.
   The two are siblings in a flex line and the separator between them is drawn
   here, not in the text: rendered text stays exactly "当前选用 · 被限流 · 约 6
   小时后" for anything that reads the DOM as a string. */
.dsm-workbuddy-composer-panel-mark{
  display:flex;flex-wrap:wrap;align-items:baseline;
  font-size:11px;line-height:15px;
  /* WRAP, do not clip (issue #108). The switch above sets white-space:nowrap
     and overflow:hidden for the NAME, which must stay on one line and ellipsise.
     Inherited here, those two rules cut the reason mark mid-sentence with no
     ellipsis at all — the reporter saw "…不是这个账号—" and read it as broken
     rendering, because a hard cut carries no signal that more exists. The mark
     is the one part of this row whose length is NOT under the layout's control
     (it is a translated sentence, and the two locales differ by 2x), so it
     wraps instead: an extra line is a legible outcome, a severed stroke is not.
     overflow-wrap:anywhere because Chinese has no spaces to break at. */
  white-space:normal;
  overflow-wrap:anywhere;
}
.dsm-workbuddy-composer-panel-mark-current{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-composer-panel-mark-reason{color:var(--dsw-alias-state-warn-primary,#f59e0b);min-width:0}
.dsm-workbuddy-composer-panel-mark-current+.dsm-workbuddy-composer-panel-mark-reason::before{
  content:" · ";color:var(--dsw-alias-label-dimmed,rgba(127,127,127,.6));
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
/* Availability, matching the pool table's dot EXACTLY (see
   account-state.ts, stateTone, which is the one place the rule lives).
   Three states, and colour answers only the first question: can this account
   serve the next message? The second question -- which account is serving this
   tab -- is answered in words on the row ("current"), so the colour is free to
   stay honest about usability. Green for usable (selected or not), red for a
   refusal of any kind (a stated rate limit included: amber used to sit here and
   read as "mostly fine"), and the neutral grey above for an account nobody has
   measured yet, which is neither.
   NOTE: no backticks in this comment. The whole stylesheet is a template
   literal, and a stray backtick silently closes it (the file then fails to
   parse with a misleading "Expected a semicolon"). */
.dsm-workbuddy-composer-panel-dot-ok{background:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-composer-panel-dot-error{background:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-workbuddy-composer-panel-dot-unknown{background:var(--dsw-alias-label-dimmed,rgba(127,127,127,.5))}
/* The new-model readout BELOW the foot hairline: the label ("本机首次见到的模型")
   in the footnote tone and the names in the body tone, so it reads as a note and
   never as a fourth column of the table above. Sits AFTER the foot because the
   foot's hairline is the one separator between the table and this block — two
   hairlines back to back would look like a rendering fault.
   The names WRAP rather than ellipsise (overflow-wrap:anywhere): Chinese has no
   spaces to break at, and a hard cut carries no signal that more exists. */
.dsm-workbuddy-composer-panel-new{margin-top:9px}
.dsm-workbuddy-composer-panel-new-row{margin:0;font-size:11px;line-height:16px}
/* The row is FOCUSED (not just scrolled) when the "· N 新模型" button opened the
   panel, so a screen reader lands on it; the component keeps it out of the tab
   order with tabIndex={-1}, hence outline:none here. The highlight is a
   barely-there tint: the row has to be findable, not loud — this is a footnote,
   not a notification, and the credits table above is the thing to read first. */
.dsm-workbuddy-composer-panel-new-row-revealed{outline:none;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-workbuddy-composer-panel-new-label{color:var(--dsw-alias-label-tertiary,GrayText)}
.dsm-workbuddy-composer-panel-new-list{color:var(--dsw-alias-label-secondary,#444);overflow-wrap:anywhere}
/* One class for BOTH footnotes: the definition of "new", and the version note
   when the on-disk history was written by a newer build. They are the same
   KIND of sentence — "what a word means here" — and two classes would let the
   two drift apart in size or tone. */
.dsm-workbuddy-composer-panel-note{
  margin:5px 0 0;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-tertiary,GrayText);overflow-wrap:anywhere;
}
.dsm-workbuddy-composer-panel-foot{
  display:flex;justify-content:space-between;gap:8px;
  margin-top:9px;padding-top:7px;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
  font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,GrayText);
}
.dsm-workbuddy-composer-panel-empty{margin:0;color:var(--dsw-alias-label-tertiary,GrayText)}
.dsm-workbuddy-composer-panel-error{margin:8px 0 0;color:var(--dsw-alias-state-error-primary,#d92d20);font-size:11px;line-height:16px}

/* The CLI live pill shares the composer dock row with the credit readout above
   and the shell's own ContextMeter, so it takes ITS metrics from the same place
   the credit trigger does: 12px/18px, label-tertiary, tabular numerals. Rendered
   with inline styles it inherited the dock's body font and read as stray text
   sitting next to two native-looking controls. */
.dsm-workbuddy-cli-live{
  display:inline-flex;align-items:center;gap:6px;
  padding:2px 6px;border-radius:6px;
  font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-tertiary,#999);
  white-space:nowrap;font-variant-numeric:tabular-nums;
}
/* A quiet pulse is the whole signal that the turn is still moving: the label's
   second counter also advances, but at one tick a second it is easy to miss. */
.dsm-workbuddy-cli-live-dot{
  width:6px;height:6px;border-radius:50%;flex:0 0 auto;
  background:var(--dsw-alias-brand-primary,#5686fe);
  animation:dsm-workbuddy-cli-live-pulse 1.6s ease-in-out infinite;
}
@keyframes dsm-workbuddy-cli-live-pulse{0%,100%{opacity:.3}50%{opacity:1}}
/* Respect the OS setting: a blinking dot is decoration, the numbers are the
   information, and they keep updating with the animation off. */
@media (prefers-reduced-motion:reduce){
  .dsm-workbuddy-cli-live-dot{animation:none;opacity:.8}
}
`
