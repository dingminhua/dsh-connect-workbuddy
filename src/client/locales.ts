/**
 * Plugin-card copy registered under the settings.workbuddy locale namespace.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — `row.*` 的文案键约定与中英 1:1 键对齐（`zh: Record<Key, string>`
 *     强制双语同步）来自该项目，其又继承自
 *     dingminhua/dsh-subagent-default-model（MIT）。
 * 改动：文案按 WorkBuddy 的实际情况改写（积分套餐、模型倍率、多账号）。
 *
 * @module dsh-connect-workbuddy/client/locales
 */

export const en = {
  'row.title': 'WorkBuddy credits & models (dsh-connect-workbuddy)',
  'row.desc': 'Use WorkBuddy models in DSH: each refresh reads every model\'s credit multiplier from the upstream catalog, image input is toggled per model, several accounts can be switched or failed over automatically, and daily check-in plus your remaining credits are one click away. The domestic and international sides are two independent providers, each with its own account — use both at the same time.',
  'row.expand': 'Expand',
  'row.collapse': 'Collapse',
  'row.tabCn': 'Domestic',
  'row.tabGlobal': 'Global',
  'row.tabHint': 'Each tab is a separate provider (workbuddy / workbuddy-global) with its own account, credits, and models. Both sides are live at once: different sessions can pick from either side, and changes on one tab never touch the other.',
  // The free (×0) models are NOT unlimited: the upstream rate-limits them by
  // single-request volume (6004, measured ~25k tokens through / ~30k refused)
  // and by model-side load (14003). Neither is a cumulative per-window token
  // quota the plugin can read — there is no field for it — so this line states
  // the LIMITATION without naming a mechanism the plugin cannot verify.
  // Stated separately from `tabHint` and in bold because the misreading it
  // prevents is expensive: a user who believes ×0 means unlimited reads a 6004
  // as "the plugin is broken" instead of "this request is too big / too busy".
  'row.tabFreeQuotaWarn': 'Free models are not unlimited — the upstream limits them by request size and load.',
  'row.tabSwitchHint': 'Uncheck to switch this provider off. Its models disappear from the DSH model picker; your account, credits, and model settings are kept and return when you check it again.',
  'row.tabSwitchAria': 'Offer the {region} provider to DSH',
  'row.tabOffNotice': 'This provider is switched off: none of its models are offered to DSH. Your account, credits, and model settings are kept — check the box above the tab to bring it back.',
  'row.signedOutHint': 'Sign in once in the WorkBuddy desktop app; this plugin follows that sign-in automatically.',
  'row.signedOutWrongRegion': 'Your WorkBuddy sign-in was found, but it belongs to the other region tab. Switch tabs above to use it — there is nothing to sign in again.',
  'row.signedOutEncrypted': 'Your WorkBuddy sign-in is present, but its token fields are encrypted and the plugin could not read the key. Install the WorkBuddy desktop app, or set WORKBUDDY_APP_EXECUTABLE to its executable — signing in again will not change this.',
  'row.searchedTitle': 'Paths checked',
  'row.searchedHint': 'If your WorkBuddy keeps its login somewhere else, point the plugin at it with the WORKBUDDY_AUTH_FILE environment variable.',
  'row.reasonMissing': 'not found',
  'row.reasonUnreadable': 'unreadable',
  'row.reasonInvalid': 'no usable token',
  'row.reasonEncrypted': 'encrypted — needs the desktop app',
  'row.reasonWrongRegion': 'belongs to the other region',
  'row.sourceDesktop': 'desktop app',
  'row.sourceDsh': 'plugin copy',
  'row.searchedMore': 'Show the {count} path(s) that were not found',
  'row.reloginHint': 'If errors occur, sign back in to the WorkBuddy app.',
  // Shown when the Host reports that the hidden accounts could NOT be brought
  // back: on Windows a locked vault file can defeat both the unlink and the
  // rewrite. Says what happened and what to do, instead of leaving the user
  // with a rescan that looks like it worked.
  'row.rescanHidesKept': 'The accounts you removed are still hidden: the plugin could not update its own list file. On Windows this is usually a file lock — close antivirus or sync tools that may be holding files in the DSH profile, then try again.',
  'row.credentialRejectedTitle': 'WorkBuddy refused this account\'s token',
  'row.credentialRejectedIntro': 'The token for "{accountName}" is no longer accepted by the upstream, so credits and check-in are unavailable. Signing in again only helps if the problem is the token itself — here is what actually applies:',
  'row.credentialRejectedSwitch': 'Another sign-in on this machine answered the upstream: "{accountName}". Switching to it fixes this — no need to sign in again.',
  'row.credentialRejectedSwitchAction': 'Switch to "{accountName}"',
  'row.credentialRejectedRelogin': 'No other local sign-in exists to switch to. Sign in again in the WorkBuddy desktop app.',
  'row.credentialRejectedChoose': 'Other local sign-ins exist but none of them answered the upstream just now. Try switching to one above; if none works, sign in again in the desktop app.',
  'row.requestFailed': 'Request failed',
  // Shown when a REFRESH failed but the last good snapshot is still on
  // screen — distinct from `row.requestFailed`, which replaces the panel.
  'row.requestFailedHint': 'Refresh failed — showing the last loaded data: {message}',
  // Shown when NO document ever landed for the region, so there is nothing to
  // fall back to. Distinguishes a transient transport failure (recoverable,
  // hence the automatic retry and the button) from a refused request.
  'row.usageErrorHint': 'Could not read the account status: {message}. The local DSH service may have just restarted — retrying automatically.',
  'row.usageRetry': 'Retry',
  'row.poolErrUnavailable': 'The account pool is not available in this build (or its batch route is missing). Restart the app; if it persists, the plugin needs reinstalling.',
  'row.poolErrFailed': 'The batch failed on the host side: {message}',
  'row.poolErrHttp': 'The batch was refused (HTTP {status}). Check the plugin is up to date and try again.',
  'row.poolErrRouteMissing': 'The batch endpoint did not answer (HTTP {status}, no body) — the DSH Host is probably still running older plugin code, so this route is not registered. Quit DSH completely and start it again, then retry.',
  'row.poolErrNoMembers': 'No account is checked into this pool — the batch had nothing to run. Check at least one account and save.',
  'row.poolErrNoLiveMembers': 'Every account checked into this pool has lost its local sign-in, so the batch had nothing to run. Sign in again in the WorkBuddy desktop app, or save to drop them.',
  'row.poolErrNoFreeModel': 'This region has no zero-multiplier model to test with. Refresh the model catalog, or pick a target model yourself.',
  'row.poolErrNoCheckin': 'This region has no daily check-in — the action is not offered here.',
  'row.poolErrStaleModel': 'The target model is no longer offered by this region. Pick another, or switch back to automatic.',
  'row.creditsError': 'Credit query unavailable: {message}',
  'row.refresh': 'Refresh',
  'row.refreshing': 'Refreshing…',
  'row.accountUnnamed': 'Unnamed account',
  'row.accountsHint': 'Choose from locally detected sign-ins. Tokens are never shown or saved in DSH settings.',
  'row.accountsRescan': 'Detect accounts again',
  'row.accountsScanning': 'Detecting…',
  // Shown while the FIRST paint is in flight (issue #77). It replaces the
  // signed-out guidance, which used to render here and told signed-in users
  // they were not signed in for as long as the usage route took.
  'row.accountsLoading': 'Loading your accounts…',
  'row.accountsWriteFailed': 'The account change was not saved: {message} — the active profile\'s configuration file could not be updated (on Windows it may be locked by an antivirus scanner or a sync client). Your previous choice is still in effect; close whatever holds that file and try again (see docs/WINDOWS.md in the plugin repo for the exact path).',
  'row.selectionLostHint': 'The saved account no longer exists locally.',
  'row.selectionLostMessage': 'The account saved for this region is no longer among the local sign-ins (WorkBuddy replaced its login or cleaned up backups). Your other sign-ins are fine — pick a current one from the list above. Signing in again in the desktop app will not fix this.',
  // The card's three sections. The card is 3,500 px tall in one column, and the
  // two jobs on it are unrelated: operating an account (who serves, how much is
  // left, which order) and editing the catalog (which models, what context
  // budget, which reasoning tiers). Their COMMIT semantics even differ — an
  // account change lands on the click, a catalog change is a draft until saved —
  // so a single column puts the save button three screens from the thing it
  // saves.
  'row.panelAccounts': 'Accounts',
  'row.panelModels': 'Models',
  // Its own section because these switches GRANT capabilities (spend, tool
  // registration) rather than pick an account, and because every one of them is
  // due sub-options that a flat list under the tab bar had no room for.
  'row.panelCapabilities': 'Capabilities',
  'row.panelCapabilitiesHint': 'What the plugin may do on your behalf. Each switch takes effect on the click — there is no Save button in this section.',
  'row.panelDiag': 'Diagnostics',
  'row.panelAria': 'Card sections',
  'row.diagHint': 'What this card actually read, so a report can quote it. Nothing here changes a setting.',
  'row.diagRegion': 'Region',
  'row.diagDomain': 'Upstream domain',
  'row.diagAccount': 'Serving account',
  'row.diagToken': 'Sign-in expires',
  'row.diagCatalog': 'Models in the catalog',
  'row.diagEnabled': 'Enabled models',
  'row.diagPool': 'Account pool',
  'row.diagPoolOn': 'on · {count} accounts',
  'row.diagPoolOff': 'off',
  'row.diagFailures': 'Last failure',
  'row.diagNoFailures': 'Nothing reported.',
  // Issue #139. The upstream published daily hours for a promotion that this
  // plugin could not read, so the badge and the discounted price are hidden.
  // Saying so is the whole point: the alternative is a badge that silently
  // stops appearing, which reads as "the promotion ended" and is wrong.
  'row.diagPromoUnreadable': '{count} promotion hour(s) unreadable — badge hidden',
  // Issue #139. The host's own slot boundary draws an EMPTY div on a render
  // throw, which reads as "the plugin is not installed". This face says what
  // actually happened, so the next report can quote it.
  'row.cardCrashed': 'The configuration area failed to render.',
  'row.cardCrashedHint': 'The model provider itself is unaffected — chat and credits keep working. Quote the line above in a bug report.',
  'row.modelsTitle': 'Models',
  'row.modelsSummary': '{count} enabled',
  // Shown in the section header while the list is COLLAPSED. The save/discard
  // buttons live inside the fold, so without this a user could hide their own
  // unsaved edits behind it with nothing on screen saying so.
  'row.modelsDirty': 'unsaved changes',
  // The faint hint in the header's middle. It names the ACTION available right
  // now, so it reads as an instruction rather than as a label for the section —
  // a static "expand or collapse" would make the reader work out which applies.
  'row.modelsRefresh': 'Refresh from WorkBuddy',
  'row.modelsRefreshing': 'Refreshing models…',
  'row.discard': 'Discard changes',
  'row.save': 'Save',
  'row.saving': 'Saving…',
  'row.saveError': 'Save failed: {message}',
  'row.saveContentionHint': ' (The file was locked, so the write was refused — on Windows this is usually an antivirus scanner, a sync client such as OneDrive, or an editor with that file open. Close whatever holds it and save again; your edits are still here.)',
  'row.modelContext': 'Maximum context {context}',
  'row.contextBudget': 'DSH context budget',
  'row.modelOutput': 'Output {output}',
  'row.modelRate': '{rate}x credits',
  'row.modelMultimodal': 'Multimodal',
  'row.modelImage': 'Image',
  'row.modelImageText': 'Image input: the vendor documents this model as text-only, so a refresh leaves it unchecked. Tick it yourself only if you know it reads images.',
  'row.modelImageUnverified': 'Image input unverified: no vendor source confirms this model reads images, so a refresh leaves it unchecked rather than guessing. Tick it yourself if you have verified it works.',
  'row.modelOff': 'Can disable',
  'row.modelOffHint': 'Offer the “off” level for this model',
  'row.modelOffRefused': 'refuses off',
  'row.modelOffRefusedHint': 'Measured to reject the “off” level with HTTP 400 (code 11133) on both gateways. With this ticked, every request that carries no reasoning tier — compaction summaries above all — would fail, so it cannot be enabled here.',
  'row.modelEffortLabel': 'Default reasoning',
  'row.modelEffortAria': 'Default reasoning level for {model}',
  'row.modelEffortHint': 'The reasoning level this model uses when a request names none — new conversations, compaction summaries and session titles. Only the levels WorkBuddy itself declares for this model are offered; “Default (x)” means WorkBuddy’s own declared default for it.',
  'row.modelEffortFollow': 'Default',
  'row.modelEffortFollowNamed': 'Default ({effort})',
  'row.modelUnknown': 'Unknown',
  'row.modelCapabilityPending': 'Only capabilities advertised by WorkBuddy are shown.',
  // The two one-click sweeps (issue #61 follow-up, mirroring the sibling `trae`
  // plugin). Cost is stated in the HINT rather than a confirm dialog, per the
  // maintainer's choice: the "all" run covers models the user did not enable, so
  // it spends more than the enabled-only run.
  'row.modelsTestEnabled': 'Test enabled models',
  'row.modelsTestAll': 'Test all models',
  'row.modelsTesting': 'Testing {done}/{total}…',
  'row.modelsTestEnabledHint': 'Tests every model you have ENABLED, one request each — each probe sends a real-volume request, so this spends real credit (about 0.01 per model at the default 25000-token size). Rows show their verdict as it lands. Stops early if the credential is rejected.',
  'row.modelsTestAllHint': 'Tests EVERY model in this region\'s catalog, including the ones you have NOT enabled — so it costs noticeably more than "test enabled models". Same per-probe cost, same early stop on a rejected credential.',
  'row.tpsSweepEnabled': 'Measure speed (enabled)',
  'row.tpsSweepAll': 'Measure speed (all)',
  'row.tpsSweepEnabledHint': 'Measures OUTPUT SPEED for every model you have ENABLED: three runs each, taking the median. Unlike the availability probes above, this sends a tiny prompt and asks for 256 output tokens back, so it costs far less per model (measured 0.01–0.15 credit against 0.72), because this gateway prices by input. Speed matters because DSH dispatches models as parallel sub-agents, so a slow model costs wall-clock time across the whole run.',
  'row.tpsTesting': 'Measuring {done}/{total}…',
  'row.tpsMeasure': 'Speed',
  'row.tpsMeasuring': 'Measuring…',
  'row.tpsHint': 'Measure this model\'s output speed: three short requests, median taken. Uses about 256 output tokens per run and costs far less than an availability probe (measured 0.01–0.15 credit). The result is shown with the time it was taken, because speed changes with load and an old number is worse than none.',
  'row.tpsValue': '{tps} tok/s',
  'row.tpsValueTtft': '{tps} tok/s · first token {ttft}s',
  'row.tpsPartial': '{tps} tok/s ({samples} runs)',
  'row.tpsNoSample': 'Could not time this model (too few stream chunks)',
  'row.tpsNoUsage': 'Could not time this model (upstream reported no token count)',
  'row.tpsAllFailed': 'Speed measurement failed',
  'row.tpsCredit': 'cost {credit} credit',
  'row.tpsMeasuredAt': 'measured {at}',
  'row.modelsTestDone': 'Done: {available} of {total} available',
  'row.modelsTestAuth': 'Stopped: the credential was rejected, so every remaining model would answer the same way. Sign in again, then re-run.',
  'row.probe': 'Test',
  'row.probing': 'Testing…',
  'row.probeHint': 'Send a real-volume request (~25k input tokens) to this model and report whether it answers right now. The upstream rate limit fires on request SIZE — measured: about 20k tokens pass, about 30k are refused — so a small request can look fine while every long-conversation request is refused. This is why every test costs real credits (about 0.7) and runs one model at a time.',
  'row.probeOk': '✓ Usable',
  'row.probeOkMs': '✓ Usable ({ms})',
  'row.probeRateLimitedUnknown': '✗ Rate limited · the upstream gave no time for when it frees up',
  'row.probeRateLimitedAt': '✗ Rate limited · usable again after {at}',
  'row.probeModelBusyUnknown': '✗ This model is loaded right now · not your account — another account will not help; wait about a minute or switch models',
  'row.probeModelBusyAt': '✗ This model is loaded right now · not your account; retry after {at}, or switch models',
  'row.probeOutOfCreditUnknown': '✗ Not enough credits · the upstream gave no time for when it frees up',
  'row.probeOutOfCreditAt': '✗ Not enough credits · quota refreshes {at}',
  'row.probeCredentialRejected': '✗ WorkBuddy refused this account\'s token — sign in again or pick another account',
  'row.probePolicyRejected': '✗ WorkBuddy\'s server refused this request under its content policy — re-signing in won\'t help; try the desktop app or another region/account',
  'row.probeChannelRejected': '✗ The gateway refused the PROMPT itself, not this account — the opening of a system message matched its third-party-agent filter, so another account or region answers the same way',
  // Short form for the composer panel's one-line mark (issue #108); see the
  // Chinese entry for why the long label cannot live there.
  'row.probeChannelRejectedShort': '✗ Gateway refused the prompt',
  'row.probeNotFound': '✗ The upstream does not know this model',
  'row.probeUnavailable': '✗ The upstream could not be reached — no usable answer came back',
  'row.probeFailed': '✗ Test failed',
  'row.probeFailedStatus': '✗ Test failed (HTTP {status})',
  'row.probeError': 'Could not run the test: {message}',
  'row.cheer': 'Star on GitHub',

  // ---- OAuth sign-in (QR on CN, web page on the international build) ----
  'row.oauthTitle': 'Add an account by QR sign-in',
  'row.oauthStart': 'Sign in with QR code',
  'row.oauthStarting': 'Opening…',
  // The dialog opens the authorization page in the browser automatically
  // (placeholder-window-in-gesture); the copy/reopen buttons are the fallback
  // when that open is blocked.
  'row.oauthOpenHint': 'Open the sign-in page and confirm — the account is added here automatically when you finish:',
  'row.oauthOpened': 'Opened. Waiting for you to finish…',
  'row.oauthWaiting': 'Waiting for the sign-in to finish… ({seconds}s)',
  'row.oauthExpires': 'The sign-in window expires in about {minutes} min.',
  'row.oauthCancel': 'Cancel',
  'row.oauthCancelled': 'Sign-in cancelled.',
  'row.oauthTimedOut': 'The sign-in timed out — start again when ready.',
  'row.oauthDone': 'Added “{accountName}”. Pick it above to use it.',
  'row.oauthError': 'Sign-in failed: {message}',
  'row.oauthCopy': 'Copy link',
  'row.oauthCopied': 'Link copied',
  'row.oauthReopen': 'Open page again',
  'row.oauthDialogClose': 'Close',
  // The INTERNATIONAL sign-in is a browser page, not a QR code — the CN build
  // scans with the WorkBuddy app. Only the three strings that NAME the method
  // are split; every other line (waiting, cancel, done) is method-agnostic and
  // stays shared, so the two regions cannot drift apart on the rest.
  'row.oauthTitleGlobal': 'Add an account by web sign-in',
  'row.oauthStartGlobal': 'Sign in on the web',
  // ---- Shared busy veil ----
  // The line under a veil's scenario text: why the row under it has not moved
  // yet. Same words for every operation, because the wait is the same wait.
  'row.veilHintList': 'The list refreshes as soon as this finishes.',
  'row.oauthSyncing': 'Adding the account…',
  'row.transferTitle': 'Export / import accounts',
  'row.transferHint': 'Move accounts between computers as a JSON file. The file carries the credentials — keep it private. The format is shared with other WorkBuddy credential managers.',
  'row.transferExport': 'Export accounts',
  'row.transferExporting': 'Exporting…',
  'row.transferExportPick': 'Choose the accounts to export ({total} available):',
  'row.transferExportConfirm': 'Export {count} account(s)',
  'row.transferExported': 'Exported {count} account(s) to {fileName}.',
  'row.transferImport': 'Import accounts',
  'row.transferImporting': 'Importing…',
  // Shown while the picked file is being parsed. The picker itself is the OS
  // dialog (the import button opens it directly), so this is the first line the
  // user sees after choosing — it must say what is happening, not ask again.
  'row.transferPreviewing': 'Reading the file…',
  'row.transferPreviewTotal': '{total} account(s) in the file — untick what should stay out. Accounts already stored here are overwritten by the import.',
  'row.transferImportConfirm': 'Import {count} account(s)',
  'row.transferImported': 'Imported {imported} account(s); {skipped} skipped (no token, or belongs to the other region).',
  'row.transferEntryUnknown': 'unknown account',
  'row.transferNoToken': 'no token in this record',
  'row.transferCancel': 'Cancel',
  'row.transferError': 'Transfer failed: {message}',

  // ---- Account pool ----
  'row.poolTitle': 'Account pool',
  'row.poolNoCandidate': 'No account in this pool can be used right now.',
  'row.poolNoCandidateHint': 'Members are rate-limited, out of credits, rejected, or unreachable. Rate limits, drained quotas and transient failures return to the pool on their own — at the time the upstream states, or after a 30-minute fallback. Only a rejected credential needs a new sign-in.',
  // The POOL-level verdict for "every member is blocked by the SAME model"
  // (issue #64). Distinct from `poolNoCandidate` above, which blames the
  // ACCOUNTS; here the accounts are fine and the model is the wall. Without this
  // the card's own per-row labels ("model busy") add up to a claim that is
  // false in aggregate, and the user goes looking for a bad account — the exact
  // hunt issue #56 reported.
  'row.poolModelWideBusy': 'Every member is blocked on the same model — this is the model, not your accounts.',
  'row.poolModelWideBusyHint': 'Switching accounts cannot help: the limit follows the model, so a different account hits the same wall. Wait about a minute, or switch to a less busy model in this session.',
  // "Selected", not "all": the batch walks the CHECKED members only. The old
  // label said "all accounts" while the disable gate was "nothing checked", so
  // the button named a set it would never touch — unchecked rows are right there
  // in the table, which is exactly what makes "all" read as "every account I
  // have" rather than "every account in the pool".
  'row.poolCheckinAll': 'Check in selected',
  'row.poolCheckingIn': 'Checking in…',
  'row.poolTestAll': 'Test selected',
  'row.poolTesting': 'Testing…',
  'row.poolBusyHint': 'Running one account at a time…',
  'row.poolTargetAuto': 'Auto',
  'row.poolTargetStaleShort': 'target model unavailable',
  'row.poolTargetNoneShort': 'no free model',
  'row.poolTargetFree': 'Auto-picked free model: {model}',
  'row.poolTargetPreferred': 'Your chosen model: {model}',
  'row.poolTargetCurrentPreferred': 'Current: {model} (your choice).',
  'row.poolTargetCurrentFree': 'Current: {model} (auto-picked free model).',
  'row.poolTargetNone': 'This region has no zero-multiplier model yet.',
  'row.poolTargetStale': 'The target model you saved is no longer offered: {model}',
  'row.poolTargetStaleHint': 'The region\'s catalog changed and no longer lists this model, so testing is off rather than running against a model the upstream may not accept. Pick another target, or switch back to automatic.',
  'row.poolTargetStaleClear': 'Switch back to automatic',
  'row.poolTargetStaleOption': '{model} (no longer offered)',
  'row.poolTargetNoneHint': 'The domestic catalog only reveals its multipliers after a model refresh. Rather than quietly spending credits on a paid model, testing stays off until one appears — refresh the models, or pick a target model yourself.',
  'row.poolColumnAccount': 'Account',
  'row.poolColumnCredits': 'Credits',
  'row.poolColumnProbe': 'Status',
  'row.poolColumnCheckin': 'Check-in',
  'row.poolNeverTested': 'Untested',
  'row.poolTestedAt': 'Tested {at}',
  'row.poolCheckedIn': 'Checked in',
  'row.poolNotCheckedIn': 'Not checked in',
  'row.poolCheckinUnknown': '—',
  'row.probeAccountRestricted': 'Account restricted upstream',
  'row.poolCheckinEnterprise': 'N/A (enterprise)',
  'row.poolBenefitClaimable': '{title}: {count} credits',
  'row.poolBenefitUrgent': '{title}: {count} credits · {days}d left',
  'row.poolBenefitDueToday': '{title}: {count} credits · last day',
  'row.poolBenefitClaim': 'Claim',
  'row.poolBenefitClaiming': 'Claiming…',
  'row.poolBenefitClaimAria': 'Claim {title} ({count} credits) for this account',
  'row.poolLogBenefitClaimed': '{accountName} claimed {title}: {count} credits',
  'row.poolLogBenefitFailed': '{accountName} claim failed: {message}',
  'row.poolBenefitHint': 'Claim it on the plans page: {url}',
  'row.poolCreditSoon': '{count} expiring within 3 days',
  'row.poolCreditNearest': 'Nearest package expires {at}',
  'row.poolExcludedRateLimited': 'Rate limited',
  'row.poolExcludedModelBusy': 'Model busy',
  'row.poolExcludedOutOfCredit': 'Out of credits',
  'row.poolExcludedRejected': 'Rejected',
  'row.poolExcludedAccountRestricted': 'Account restricted upstream',
  'row.poolExcludedUnusable': 'Unusable',
  'row.poolRetryAt': 'Back after {at}',
  'row.poolRetryUnknown': 'The upstream gave no time for when this frees up',
  // Relative form of a stated recovery time. Always shown NEXT TO the absolute
  // instant, never instead of it: the instant is the upstream's own answer and
  // stays authoritative, while these save the reader the subtraction.
  'row.remainingImminent': 'any moment now',
  'row.remainingMinutes': 'in about {count} min',
  'row.remainingHours': 'in about {count} h',
  'row.remainingDays': 'in about {count} d',
  // The same duration WITH its verb (`recoversInText`). On an account row the
  // bare "in about 2 h" states how long but not what happens then, which is the
  // one thing the row exists to answer.
  'row.recoversImminent': 'recovering any moment now',
  'row.recoversMinutes': 'recovers in about {count} min',
  'row.recoversHours': 'recovers in about {count} h',
  'row.recoversDays': 'recovers in about {count} d',
  // How stale a measurement is, and which writer produced it. Two sites write
  // the same account's record and overwrite each other, so without these the
  // table cannot explain a change the user just watched happen.
  'row.poolProbeJustNow': 'just now',
  'row.poolProbeMinutesAgo': '{count} min ago',
  'row.poolProbeHoursAgo': '{count} h ago',
  'row.poolProbeDaysAgo': '{count} d ago',
  'row.poolProbeSourceTest': 'tested',
  'row.poolProbeSourceLive': 'hit by a live request',
  'row.poolProbeSourceUnknown': 'source unknown',
  // WHICH model a verdict is about (issue #61). 6004 is an account × model
  // condition, so a bare "available" was readable as account-level truth while
  // the model the user actually chats with was the one being refused.
  'row.poolProbeModel': 'model {model}',
  'row.poolProbeModelUnknown': 'model not recorded',
  'row.poolSettingsTitle': 'More settings',
  'row.poolSettingsHint': 'These are preferences: they take effect when you save (same as the model list). Test results are written automatically and are not affected by this button.',
  'row.poolEnabled': 'Enable the account pool',
  'row.poolEnabledHint': 'On: the pool picks the account for every request, and only a failover-worthy failure moves to the next account — a malformed request, a busy model, a platform queue, or a channel-gate refusal does not (switching accounts would only burn quota for the same refusal). Off: the account you select serves every request, and a failure is reported as it is.',
  'row.poolModeAuto': 'picking automatically',
  'row.poolModeManual': 'you pick',
  'row.poolManualAccountLabel': 'Account in use',
  'row.poolManualAccountNone': 'No account in effect',
  'row.poolTargetLabel': 'Test model (whole pool)',
  'row.poolTargetHint': 'One model for every account here — the test measures each row with it. Auto picks a zero-multiplier model from this region\'s catalog, preferring the largest context window; a manual choice wins.',
  'row.poolTargetAutoOption': 'Auto — pick a free model',
  'row.poolProbeSizeLabel': 'Test request size',
  'row.poolProbeSizeHint': 'How much text a test sends. The upstream refuses a request once it grows past roughly 20K–30K tokens, so a test smaller than your real conversations answers "usable" for an account that would refuse them. Bigger tests are more truthful but cost more credit each.',
  'row.poolProbeSizeDefault': 'Default (25K)',
  'row.poolProbeSizeOption': '{tokens}K tokens',
  'row.poolSaved': 'Save',
  'row.poolSaving': 'Saving…',
  'row.poolSaveFailed': 'Could not save: {message}',
  'row.poolSavedStaleRefresh': 'Saved, but the panel could not re-read it. The value is stored; the next refresh will show it.',
  'row.poolDiscard': 'Discard changes',
  'row.poolDirty': '● Unsaved changes',
  'row.poolManualUnlock': 'Turn off rotation',
  'row.poolLogTitle': 'Activity',
  'row.poolLogClear': 'Clear',
  'row.poolLogEmpty': 'Nothing yet. Check-ins, tests, and account switches are recorded here.',
  'row.poolLogCheckinStart': 'Checking in {count} account(s), one at a time',
  'row.poolLogCheckinClaimed': '{accountName}: checked in (+{credit})',
  'row.poolLogCheckinAlready': '{accountName}: already checked in today — skipped',
  'row.poolLogCheckinSkipped': '{accountName}: enterprise account, no daily check-in',
  'row.poolLogCheckinFailed': '{accountName}: check-in failed — {message}',
  'row.poolLogCheckinDone': 'Check-in finished',
  'row.poolLogBatchFailed': 'Batch failed — nothing ran: {message}',
  'row.poolLogTestStart': 'Testing {count} account(s) against {model}',
  'row.poolLogTestRow': '{accountName}: {outcome}',
  'row.poolLogTestDone': 'Test finished; the pool was re-ranked',
  'row.poolLogTestRowMalformed': '{accountName}: the host returned no result for this account',
  'row.poolRegionNote': 'The domestic and international pools are fully independent: accounts, switches, intervals, and target models never affect each other.',
  'row.poolMembersTitle': 'Accounts in this pool',
  'row.poolMembersHint': 'Only checked accounts rotate, get checked in, and get tested.',
  'row.poolSelectAll': 'Select all',
  'row.poolSelectNone': 'Clear all',
  'row.poolSelectedCount': '{count} of {total} selected',
  // The ordering rule, spelled out where the arrows are used. This is the ONE
  // place the full priority order is written down for a reader; `rankPool`'s
  // doc comment is the source of truth for the code, and the numbered list
  // below must stay in the same order as that comparator.
  'row.poolOrderRulesTitle': 'How this pool chooses an account',
  'row.poolOrderRulesIntro': 'The pool always picks the first account that can actually be billed right now. The rules below are checked in order — the first one that separates two accounts decides; later rules only break ties.',
  'row.poolOrderRuleUsable': '1. Can it be billed right now? Accounts that are rate-limited, out of credit, credential-rejected, or failing are moved to the back until their cooldown ends. This outranks everything, including your own order below.',
  'row.poolOrderRuleExpiring': '2. Does it have credits expiring within 3 days? Yes goes first. This also outranks your manual order — see the note below.',
  'row.poolOrderRuleManual': '3. Your manual order. The position you set with the ↑ / ↓ arrows. Accounts you never ordered are placed after every ordered one.',
  'row.poolOrderRuleNearestExpiry': '4. Which expiry comes first? Between accounts that both have credits expiring, the one losing them sooner goes first.',
  'row.poolOrderRuleExpiringAmount': '5. How many are expiring? Between those same accounts, the one with more at stake goes first. With nothing expiring this is equivalent to comparing totals.',
  'row.poolOrderRuleTotal': '6. Total credits. The account holding more goes first, so a nearly-drained account is kept in reserve.',
  'row.poolOrderRuleFreshness': '7. Freshness of the sign-in. The more recently issued credential wins a draw.',
  'row.poolOrderRuleId': '8. Account id. A final tie-break, so the same pool always produces the same order.',
  'row.poolOrderWhy': 'Why expiring credits outrank your manual order: expiring credits are money about to disappear, while a manual order may be stale or set by accident. If the manual order won, one mis-drag could let credits lapse unused. So an account with credits expiring within 3 days always goes ahead of one without, even if you dragged it to the bottom.',
  'row.poolOrderBadgeNote': 'The badge shows the position you SAVED, not the live ranking. An account can read "No. 2" while being benched for a rate limit — the number is your saved preference, and the pool skips accounts it cannot bill right now.',
  'row.poolOrderRulesToggle': 'Show the full ordering rule',
  'row.poolNoneSelected': 'No account is checked into this pool.',
  'row.poolNoneSelectedHint': 'Check at least one account to enable check-in and test.',
  'row.poolGhostMembers': '{count} pool member(s) are no longer signed in on this machine, so they are not counted and not used: {names}. Remove any you no longer need below.',
  'row.poolGhostRemove': 'Remove {account} from this pool',
  'row.poolGhostRemoveNamed': 'Remove {account} from this pool. This account is no longer signed in on this machine.',
  'row.poolGhostRemoveUnnamed': 'Remove {account} from this pool. No name was ever recorded for this account, so what you see is the start of its id.',
  'row.poolSelectAria': 'Include {accountName} in this region\'s account pool',
  'row.poolCurrentBadge': 'In use',
  'row.poolCurrentHeader': 'In use: {account}',
  'row.poolNotMember': 'Not in pool',
  'row.poolNotMemberHint': 'Not in the pool: rotation skips it, and batch check-in and test leave it alone.',
  'row.poolServingOutside': '“{account}” is serving right now but is not in this pool: rotation will not pick it, and batch check-in and test will not touch it.',
  'row.poolUnsavedMembers': 'Selection changed — save to apply',
  // Manual priority ordering: the rank badge and the ↑/↓ move arrows. The badge
  // is non-interactive (it describes the current order), the arrows act on it.
  'row.poolRankLabel': 'No. {rank}',
  // Deliberately no interpolated ordinal suffix. "{rank}st" is correct for 1
  // but produces "2st" / "3st" for the ranks the badge actually shows, and an
  // English ordinal needs a suffix helper the locale table does not have. This
  // wording reads correctly for every rank and matches the badge's "No. N".
  'row.poolRankManualTitle': 'You placed this account at position {rank} in the pool manually.',
  'row.poolRankAuto': 'Auto',
  'row.poolRankAutoTitle': 'Not manually sorted yet: the pool spends expiring credits first, then picks accounts by remaining balance. Use ↑/↓ to set your own order.',
  'row.poolMoveUpTitle': 'Move account up in this pool\'s order',
  'row.poolMoveDownTitle': 'Move account down in this pool\'s order',
  'row.poolMoveUpAria': 'Move {accountName} up in this pool\'s order',
  'row.poolMoveDownAria': 'Move {accountName} down in this pool\'s order',
  // Per-row actions: test ONE account, remove ONE account.
  'row.poolRowTest': 'Test',
  'row.poolRowRemove': 'Remove',
  'row.poolRowRemoveHint': 'Remove this account from the list. The WorkBuddy desktop app is not signed out — it keeps its own sign-in. Removing only hides the account here; 「Detect accounts again」 brings it back.',
  'row.poolRowRemoveAria': 'Remove the stored credential of {accountName}',
  'row.poolRowRemoved': '{accountName}: hidden from the list. 「Detect accounts again」 re-adds it; the desktop app stays signed in.',
  'row.poolRowRemoving': 'Removing the account…',
  'row.poolRowRemoveDesktopOnly': '{accountName}: hidden from the list — this account comes from the desktop app\'s own sign-in, which is left untouched. 「Detect accounts again」 re-adds it.',
  // Device-header tier and the per-account gear (虚拟值 / 真实值).
  //
  // The 「Real」 wording promises exactly what the tier does: one real device per
  // machine, shared by every account, signed by the bundled SDK. The hint names
  // the consequence (the gear is off) rather than only the mechanism, because a
  // greyed-out gear with no sentence next to it reads as a broken control.
  'row.deviceModeTitle': 'Device identity',
  'row.deviceModeVirtual': 'Virtual',
  'row.deviceModeReal': 'Real',
  'row.deviceModeHintVirtual': 'Every account presents a virtual device id derived from this machine. Use the gear on a row to set one by hand.',
  'row.deviceModeHintReal': 'Every account presents this machine\'s real device, signed by the bundled SDK. The gear is off — one real machine cannot be given two different ids. If the SDK is unavailable, no device header is sent at all (see 「SDK」).',
  'row.deviceGearHint': 'Edit this account\'s device id (X-Machine-ID / X-Session-ID)',
  'row.deviceGearBlockedHint': 'Only available in the Virtual tier',
  'row.deviceGearAria': 'Edit device parameters for {accountName}',
  'row.deviceModeRealBlockedTitle': 'Switch to Virtual first',
  'row.deviceModeRealBlocked': 'In the Real tier every account shares one real device, so there is nothing per-account to set. Switch the device identity to 「Virtual」 and open the gear again.',
  'row.deviceDialogTitle': 'Device parameters · {accountName}',
  'row.deviceDialogIntro': 'These two values are the X-Machine-ID / X-Session-ID this account presents upstream. Leave a field empty to keep deriving it from this machine\'s salt.',
  'row.deviceMachineLabel': 'Machine ID (X-Machine-ID)',
  'row.deviceSessionLabel': 'Session ID (X-Session-ID)',
  'row.deviceFieldPlaceholder': 'Empty = derived automatically',
  'row.deviceRandom': 'Randomize',
  'row.deviceRandomHint': 'Fills both with random 36-character ids',
  'row.deviceDialogP3': 'Real device token',
  'row.deviceDialogP3Hint': 'Signed by the built-in Turing Shield SDK. The Real tier uses it for every account; it is not editable here — see the 「SDK」 section.',
  'row.deviceDialogCancel': 'Cancel',
  'row.deviceDialogSave': 'Save',
  'row.deviceDialogSaving': 'Saving…',
  'row.deviceInvalid': 'Needs 36 lowercase hex characters (0-9a-f)',
  // 「SDK」 — the real-device section. Its own tab because it is the only page
  // with actions the user performs while nothing is broken (verify the link,
  // look at the value), whereas Diagnostics is read-only by contract.
  'row.panelSdk': 'SDK',
  'sdk.hint': 'The real device token this machine signs through the bundled SDK. Every account sends this one value in the Real tier; the Virtual tier never touches it.',
  'sdk.loading': 'Asking the SDK…',
  'sdk.unavailable': 'This Host build has no SDK route — real device parameters are not available here. The Virtual tier still works.',
  'sdk.state': 'Connection',
  'sdk.statusReady': 'Working',
  'sdk.statusStale': 'Reachable, but the last fetch failed — serving the previous token',
  'sdk.statusNoToken': 'SDK loaded, no token yet — open 「Refresh」',
  'sdk.statusMissing': 'No bundled SDK for this platform',
  'sdk.statusUnsupported': 'The SDK refused this platform',
  'sdk.statusError': 'The SDK could not be loaded',
  'sdk.bundle': 'SDK',
  'sdk.runtime': 'Runtime',
  'sdk.fetched': 'Last fetched',
  'sdk.tier': 'Tier in use',
  'sdk.tierReal': 'Real — accounts send this token',
  'sdk.tierVirtual': 'Virtual — this token is not sent',
  'sdk.valueLabel': 'X-Device-Token',
  'sdk.noValue': 'No token available',
  'sdk.length': '{count} chars',
  'sdk.reveal': 'Show',
  'sdk.hide': 'Hide',
  'sdk.copy': 'Copy',
  'sdk.copied': 'Copied',
  'sdk.refresh': 'Fetch again',
  'sdk.refreshing': 'Fetching…',
  'sdk.never': 'Never',
  'sdk.unknown': 'Unknown',
  'sdk.ageJustNow': 'just now',
  'sdk.ageMinutes': '{count}m ago',
  'sdk.ageHours': '{count}h {rest}m ago',
  // The image tool is the ONE capability where the model spends on its own
  // (no per-call approval in the host). Opt-in for that reason, so the copy says
  // what it costs instead of only naming it — and it names BOTH gateways, since
  // a picture costs ~5.71 credits on CN and ~0.03 internationally (measured
  // 2026-10-25; the media catalog carries no price, the settled usage.credit
  // does). The tool reports the actual charge either way.
  'row.upstreamHint': 'These change what the gateway sees, not which provider serves the call. All of them are sampled when the plugin mounts, so reload the plugin (or restart DSH) after changing one.',
  'row.usageIdentityLabel': 'Make the usage page record these calls like the official client',
  'row.usageIdentityHint': 'Adds the X-IDE-* headers (which fill the 使用端 column, otherwise blank) and sends conversation ids as 32-hex UUIDv7. Display alignment only: the User-Agent and the request body never change. Off by default because the evidence comes from a reporter, not from this plugin.',
  'row.keepPromptLastLabel': 'Record what you actually typed, not the injected context',
  'row.keepPromptLastHint': 'Moves the harness-injected runtime context above your real prompt, so the usage page stops showing "Time sampled…" as your question. Message count and text are preserved. Off by default because it changes the message order the upstream counts.',
  'row.sessionTitleLabel': 'Send session titles to the lightweight model',
  'row.sessionTitleHint': 'The host fires one title request per new session and bills it at the main model rate. This re-points that one request at a hidden lightweight model. The request still happens either way. Off by default.',
  'row.sessionTitleModel': 'Target model:',
  'row.extraPrefixesCount': 'Custom injected prefixes in effect:',
  // The channel-gate auto-continue. The copy has to say three things at once —
  // what failure it reacts to, that it spends real requests, and that the cap
  // counts CONSECUTIVE sends — because the switch is off by default and the
  // user's only other source for any of it is the config file.
  'row.channelRejectContinueLabel': 'Resend 「继续」 after the gateway refuses the request',
  'row.channelRejectContinueHint': 'LAST RESORT, not a fix for 11128. When the gateway answers 400 with code 11128 (「被网关的渠道校验拦截」), the turn just fails: the plugin never retries it in place and never swaps accounts, because the gate matches the message contents and every account sends the same ones. Fixed system fingerprints are byte-identical every turn, so resending only pays for the same 400 again; since 5.13.1 `prepareChatBody` rewrites known phrases instead. The narrow case this can help is content that changes between turns. It sends the text below as a NEW turn and spends a real request each time. Stops after N CONSECUTIVE sends (default 1); one successful turn, or one message you type yourself, resets the count. Subagent sessions are never touched. Off by default. Takes effect immediately, no reload.',
  'row.channelRejectContinueLimit': 'Max consecutive sends:',
  'row.channelRejectContinueText': 'Text sent:',
  'row.cliBridgeLabel': 'Let the local CodeBuddy CLI do the work',
  'row.cliBridgeHint': 'Adds the codebuddy_ask tool and the /codebuddy command. Each call spends CodeBuddy quota. injectResult only affects /codebuddy — its result is injected back into the session, costing one DSH turn when the session is idle; tool calls never read it. Rate-limited: 6 turns per session per hour, 20 per process per hour, one turn at a time. Off by default.',
  // The three quick-adjust pins of the route: which model and which reasoning
  // tier the local CLI runs on, and in what order it walks the credential
  // regions. The model list is not hardcoded — it is the catalog the card
  // already synced for the active tab, so it follows the upstream; a pinned
  // value the catalog does not list still shows.
  'row.cliBridgeModelLabel': 'CLI model',
  'row.cliBridgeModelDefault': 'CLI default',
  'row.cliBridgeModelAria': 'Model the local CodeBuddy CLI runs on',
  'row.cliBridgeModelHint': 'Written to cliBridge.model and passed to the CLI as --model. "CLI default" leaves the model to the CLI itself. The list is the catalog this tab synced from the upstream.',
  'row.cliBridgeEffortLabel': 'CLI effort',
  'row.cliBridgeEffortDefault': 'CLI default',
  'row.cliBridgeEffortAria': 'Reasoning effort the local CodeBuddy CLI runs on',
  'row.cliBridgeEffortHint': 'Written to cliBridge.effort and passed to the CLI as --effort. "CLI default" leaves the tier to the CLI itself. When the picked model lists supported tiers, only those are offered.',
  'row.cliBridgeRegionOrderLabel': 'Region order',
  'row.cliBridgeRegionOrderAria': 'Order in which the local CodeBuddy CLI walks the credential regions',
  'row.cliBridgeRegionOrderHint': 'Written to cliBridge.regionOrder: the order the CLI tries the WorkBuddy credentials in, until one logs in. The region actually used is reported per turn as credential_region. Applies from the next call.',
  'row.cliBridgeRegionOrderCnFirst': 'CN first',
  'row.cliBridgeRegionOrderGlobalFirst': 'Global first',
  'row.cliBridgeRegionOrderCnOnly': 'CN only',
  'row.cliBridgeRegionOrderGlobalOnly': 'Global only',
  'row.cliBridgePickersHint': 'All three pickers write the global cliBridge block; "CLI default" on model and effort is an explicit empty value, not "unset" — the CLI then uses its own defaults; the region picker writes cliBridge.regionOrder.',
  'row.imageToolLabel': 'Let the model draw images',
  'row.imageToolHint': 'Adds the workbuddy_draw_image tool, which the MODEL may call on its own — about 5.71 credits per image on the CN gateway and about 0.03 on the international one, with no per-call confirmation. Ticking it here only authorizes THIS tab\'s region. Off everywhere means the tool is not registered at all.',
  'row.videoToolLabel': 'Let the model generate videos',
  'row.videoToolHint': 'Adds the workbuddy_draw_video tool, which the MODEL may call on its own — a video is an async task (submit, poll, then download) that costs WorkBuddy credits and runs tens of seconds to minutes, with no per-call confirmation. Ticking it here only authorizes THIS tab\'s region. Off everywhere means the tool is not registered at all.',
  'row.videoModelLabel': 'Video model per mode',
  'row.videoModelHint': 'Pinned separately for text-to-video and image-to-video, from THIS region\'s own catalog — a model id does not carry across regions. A call that names no model uses the pin; with nothing pinned the tool takes the first model of that group. A pin the catalog no longer carries quietly falls back to the first model instead of failing.',
  'row.videoModelDefault': 'Default (first in the group)',
  // The media roster. It answers "what can this region actually draw" from the
  // region's own product configuration, which is the ONLY source of truth for
  // it: the catalog carries no price and no capability flag. Its IMAGE rows stay
  // a list (one model per image tag today); the VIDEO rows are pinnable in the
  // picker above, because CN now publishes two models per video tag.
  'row.mediaModelsLabel': 'Image models in this region',
  'row.mediaModelsHint': 'Read from this account\'s product configuration. The draw tools pick their models from here: a prompt without an image uses a text-to-image model, one WITH an image uses an image-to-image model. Image rows are read-only (pass a model to the tool to change it); the VIDEO model is pinnable in the picker above.',
  'row.mediaModelsEmpty': 'This region publishes no image or video model.',
  'row.mediaModelsError': 'Could not read the media model list: {message}',
  'row.mediaModelsRefresh': 'Re-read',
  'row.mediaModelsRefreshing': 'Reading…',
  'row.mediaTagTextToImage': 'text → image',
  'row.mediaTagImageToImage': 'image → image',
  'row.mediaTagTextToVideo': 'text → video',
  'row.mediaTagImageToVideo': 'image → video',
  'row.showCreditsCn': 'Show credits in the composer toolbar',
  'row.showCreditsGlobal': 'Show credits in the composer toolbar',
  'row.showCreditsCnHint': 'Show the domestic (WB CN) credit balance in the composer toolbar, but only while this session uses a WB CN model. Click it for per-account balances and a one-click test of the checked accounts (the test spends real credits). The readout refreshes by itself every 5 minutes; the per-account table every 60 seconds while it is open.',
  // WHERE the readout sits (issue #62). The composer row is a LIST seat shared
  // with any other plugin that registers there — one report is the readout
  // disappearing once another plugin was installed — so the seat is a choice.
  'row.creditPositionLabel': 'Position',
  'row.creditPositionComposer': 'composer toolbar',
  'row.creditPositionStats': 'below the input box',
  'row.creditPositionAria': 'Credit readout position for {region}',
  // The subordinate control's own explanation, ALWAYS visible: it answers "why
  // is there a picker here at all" rather than restating the option names.
  // Restating them belongs to the disabled state only — see
  // creditPositionDisabledHint. Both are deliberately short: they are the
  // second and third text tiers under the switch's title, and a longer line
  // would push the switch itself into second place.
  'row.creditPositionHintInline': 'Where the readout sits. "composer toolbar" is the default — the row with the model picker.',
  'row.creditPositionDisabledHint': 'Unavailable while the switch above is off: tick "Show credits in the composer toolbar" first.',
  // The row's explanation: what the readout IS. Kept distinct from
  // creditPositionHintInline, which explains the picker beside it — one
  // sentence per control.
  'row.showCreditsHintInline': 'The balance for the account currently serving this tab. Click for per-account balances; it also refreshes every 5 minutes.',
  // The supplement to a quota failure (issue #63), rendered as an INLINE
  // PARENTHETICAL in the conversation — one short clause, no dialog, no button.
  // The plugin no longer claims the `shell.quota-notice` chain seat, so this is
  // NOT appended to the host's sentence by this plugin any more (that takeover
  // is what parked an unstyled span at the overlay's top-left); the host draws
  // its own sentence and this qualifies it where the user is already looking.
  // Written to be TRUE FOR BOTH cases the QUOTA code covers — a model's own daily
  // quota that has nothing to do with credits, and a genuinely empty balance —
  // because the upstream says which it is in Chinese prose the plugin must not
  // parse to make policy. The glyphs are part of the string so a locale that
  // brackets differently is not at the mercy of a CSS `content` rule.
  'quotaNotice.fallbackHead': 'The quota for this request is exhausted',
  'quotaNotice.supplement': ' (some models also have a daily limit that is unrelated to your credits)',
  'row.creditPositionHint': 'Where the credit readout sits. "composer toolbar" is the default (the row with the model picker). Choose "below the input box" — the row carrying the round / step / token statistics — if another plugin occupies the composer toolbar and the readout does not appear.',
  'row.showCreditsGlobalHint': 'Show the international (WB AI) credit balance in the composer toolbar, but only while this session uses a WB AI model. Click it for per-account balances and a one-click test of the checked accounts (the test spends real credits). The readout refreshes by itself every 5 minutes; the per-account table every 60 seconds while it is open.',
  'composer.pointsCn': 'WB CN',
  'composer.pointsGlobal': 'WB AI',
  'composer.panelTitleCn': 'WB CN credits',
  'composer.panelTitleGlobal': 'WB AI credits',
  'composer.account': 'Account',
  'composer.credits': 'Credits',
  'composer.switchTo': 'Switch to {account}',
  'composer.current': 'In use',
  'composer.noAccounts': 'No account in this region',
  'composer.signedOut': 'Not signed in',
  // The panel's header button TESTS the accounts rather than re-reading their
  // balances: a mark in that table is a measurement, and only another measurement
  // can improve it. It still re-reads afterwards — the probes live in the usage
  // document — so pressing this leaves the table current as well as tested.
  'composer.testAll': 'Test all',
  'composer.testing': 'Testing…',
  'composer.testAllHint': 'Test every account in this region, one at a time',
  'composer.testFailed': 'Could not test the accounts',
  'composer.refreshFailed': 'Could not refresh credits',
  'composer.lastRefresh': 'Last refreshed',
  'composer.panelTitle': 'WorkBuddy credits',
  // The "· N 新模型" segment. The wording MUST stay "first seen by this
  // machine": this plugin has no upstream "listed since" field, so claiming the
  // gateway added a model would be fabricating an upstream fact. The segment
  // and its row render only when the count is non-zero.
  'composer.newModels': 'new models',
  'composer.newModelsRow': 'Models first seen by this machine',
  'composer.newModelsTitle': 'Models first seen by this machine: ',
  'composer.newModelsSep': ', ',
  'composer.newModelsNote': '"New" means this machine recorded the model id for the first time; it says nothing about when the upstream listed it. Only models first seen within the last 7 days are shown.',
  'sidebar.creditsCn': 'WB CN credits',
  'sidebar.creditsGlobal': 'WB AI credits',
  'sidebar.refresh': 'Refresh',
  'sidebar.refreshing': 'Refreshing…',
  'sidebar.lastRefresh': 'Last refreshed {time}',
  'sidebar.refreshFailed': 'Refresh failed',
  'sidebar.signedOut': 'Not signed in',
  // The live CodeBuddy turn readout. Kept terse: it sits in the composer's
  // ambient dock next to the shell's own round/token pills, where a sentence
  // would wrap and push the composer.
  'cliLive.running': 'CodeBuddy',
  'cliLive.toolCalls': '{count} tools',
  'cliLive.elapsed': '{seconds}s',
  'cliLive.starting': 'starting…',
  'cliLive.finishing': 'finishing…',
  'cliLive.lastTool': 'last: {tool}',
  'cliLive.chars': '{count} chars',
  'cliLive.aria': 'A CodeBuddy turn is running: {detail}',
} as const

export type WorkBuddySettingsKey = keyof typeof en

export const zh: Record<WorkBuddySettingsKey, string> = {
  'row.title': '接入使用 WorkBuddy 积分与模型（dsh-connect-workbuddy）',
  'row.desc': '在 DSH 中使用 WorkBuddy 模型：每次刷新都按上游目录读取每个模型的积分倍率，图片输入可逐模型开关，多个账号可切换或由账号池自动换号，每日签到与剩余积分一键可查。国内版与国际版是两个独立供应商，各有自己的账号，可同时使用。',
  'row.expand': '展开',
  'row.collapse': '收起',
  'row.tabCn': '国内版',
  'row.tabGlobal': '国际版',
  'row.tabHint': '每个 tab 是一个独立供应商（workbuddy / workbuddy-global），各有自己的账号、积分与模型。两边同时生效：不同会话可各选一边，一侧的改动不影响另一侧。',
  // 免费（×0）模型**不是无限量**：上游按**单次请求体积**限流（6004，实测约 25k token
  // 通过、约 30k 被拒）并按**模型侧负载**限流（14003）。两者都不是插件能读到的
  // 「时间段内累计 token 定额」——上游没有这个字段——所以这句只说限制存在，不声称
  // 插件无法验证的机制。与 `tabHint` 分开、且加粗显示，因为它要防的误读代价很高：
  // 以为 ×0 = 无限用的人，会把 6004 读成「插件坏了」而不是「这个请求太大/太忙」。
  'row.tabFreeQuotaWarn': '免费模型并非无限量：上游按单次请求体积与负载限流。',
  'row.tabSwitchHint': '取消勾选即关闭该供应商：它的模型不再出现在 DSH 模型选择器里；账号、积分与模型设置都会保留，重新勾选即恢复。',
  'row.tabSwitchAria': '是否向 DSH 提供{region}供应商',
  'row.tabOffNotice': '该供应商已关闭：它的模型不会提供给 DSH。账号、积分与模型设置均已保留——勾选上方复选框即可恢复。',
  'row.signedOutHint': '在 WorkBuddy 桌面 App 里登录一次即可，插件会自动跟随当前登录的账号。',
  'row.signedOutWrongRegion': '找到了你的 WorkBuddy 登录信息，但它属于另一个地区的标签页。切换到上方对应标签页即可使用——不需要重新登录。',
  'row.signedOutEncrypted': '你的 WorkBuddy 登录信息在，但其中的 token 字段是加密的，插件拿不到密钥。请安装 WorkBuddy 桌面 App，或用环境变量 WORKBUDDY_APP_EXECUTABLE 指定它的可执行文件——重新登录无法解决这个问题。',
  'row.searchedTitle': '已检查的路径',
  'row.searchedHint': '如果你的 WorkBuddy 把登录信息存在别处，可以用环境变量 WORKBUDDY_AUTH_FILE 指定。',
  'row.reasonMissing': '不存在',
  'row.reasonUnreadable': '无法读取',
  'row.reasonInvalid': '没有可用的 token',
  'row.reasonEncrypted': '已加密——需要桌面 App',
  'row.reasonWrongRegion': '属于另一个地区',
  'row.sourceDesktop': '桌面 App',
  'row.sourceDsh': '插件副本',
  'row.searchedMore': '显示另外 {count} 条「不存在」的路径',
  'row.reloginHint': '出现错误，重新登录 WorkBuddy APP 即可。',
  // 隐藏账号没能恢复时显示：Windows 上被占用的文件会让删除与改写双双失败。
  // 说明发生了什么、该做什么，而不是让用户以为「重新检测」成功了。
  'row.rescanHidesKept': '已删除的账号仍是隐藏状态：插件没能更新自己的名单文件。Windows 上通常是文件被占用——请关闭可能正在占用 DSH 配置目录的杀毒/同步工具后重试。',
  'row.credentialRejectedTitle': 'WorkBuddy 拒绝了这个账号的 token',
  'row.credentialRejectedIntro': '「{accountName}」的 token 已不被上游接受，所以积分与签到都用不了。重新登录只在「确实是 token 的问题」时才有用——当前实际适用的是下面这一条：',
  'row.credentialRejectedSwitch': '本机另一个账号「{accountName}」刚刚实测可用，切换到它即可恢复，不必重新登录。',
  'row.credentialRejectedSwitchAction': '切换到「{accountName}」',
  'row.credentialRejectedRelogin': '本机没有其他账号可切换。请在 WorkBuddy 桌面端重新登录。',
  'row.credentialRejectedChoose': '本机还有其他账号，但刚才都没能通过上游校验。可以在上方切换一个试试；如果都不行，请在桌面端重新登录。',
  'row.requestFailed': '请求失败',
  'row.requestFailedHint': '刷新失败——下方为上次加载的数据：{message}',
  'row.usageErrorHint': '读取账号状态失败：{message}。本地 DSH 服务可能刚重启过，正在自动重试。',
  'row.usageRetry': '重试',
  'row.poolErrUnavailable': '本版本没有可用的账号池（或其批量接口缺失）。请重启应用；若仍不行，插件可能需要重新安装。',
  'row.poolErrFailed': '批量操作在宿主侧失败：{message}',
  'row.poolErrHttp': '批量操作被拒绝（HTTP {status}）。请确认插件是最新版本后重试。',
  'row.poolErrRouteMissing': '批量操作接口没有应答（HTTP {status}，无响应体）—— 宿主进程很可能还在跑旧版插件代码，这个接口没有注册上。请完全退出 DSH 再重新打开后重试。',
  'row.poolErrNoMembers': '本池没有勾选任何账号，批量操作没有可执行对象。请至少勾选一个账号并保存。',
  'row.poolErrNoLiveMembers': '本池勾选的账号在本机都已不再登录，批量操作没有可执行对象。请在 WorkBuddy 桌面端重新登录，或保存以移除它们。',
  'row.poolErrNoFreeModel': '本区域没有可用的免费（倍率为 0）模型。请先刷新模型目录，或自己指定一个目标模型。',
  'row.poolErrNoCheckin': '本区域没有每日签到 —— 这里不提供该操作。',
  'row.poolErrStaleModel': '目标模型已不在本区域目录中。请改选一个，或切回自动。',
  'row.creditsError': '积分查询失败：{message}',
  'row.refresh': '刷新',
  'row.refreshing': '正在刷新…',
  'row.accountUnnamed': '未命名账号',
  'row.accountsHint': '选择本机检测到的登录账号；Token 不会显示，也不会保存到 DSH 设置。',
  'row.accountsRescan': '重新检测账号',
  'row.accountsScanning': '正在检测…',
  // 首屏加载中的提示（issue #77）。它取代的正是「未登录」那段说明——
  // 那一段在用量接口返回前一直显示，让已登录的用户以为自己没登录。
  'row.accountsLoading': '正在加载账号…',
  'row.accountsWriteFailed': '账号改动未保存：{message} —— 当前 profile 的配置文件写入失败（Windows 上可能被杀毒软件或同步盘占用）。当前仍是原来保存的选择，请先关闭占用该文件的程序再重试（文件的确切路径见插件仓库的 docs/WINDOWS.md）。',
  'row.selectionLostHint': '已保存的账号在本机已不存在。',
  'row.selectionLostMessage': '该区域保存的账号已不在本机登录列表中（WorkBuddy 更换了登录或清理了备份文件）。本机其他登录仍然可用——请在上方列表中重新选择一个当前账号。重新登录桌面端 App 无法修复此问题。',
  'row.panelAccounts': '账号',
  'row.panelModels': '模型',
  'row.panelCapabilities': '能力',
  'row.panelCapabilitiesHint': '插件可以替你做什么。这些开关点一下立即生效 —— 这一区里没有保存按钮。',
  'row.panelDiag': '诊断',
  'row.panelAria': '卡片分区',
  'row.diagHint': '这张卡片实际读到了什么，方便贴进问题反馈。这里没有任何会改动设置的控件。',
  'row.diagRegion': '区域',
  'row.diagDomain': '上游域名',
  'row.diagAccount': '当前服务账号',
  'row.diagToken': '登录有效期至',
  'row.diagCatalog': '目录中的模型',
  'row.diagEnabled': '已启用的模型',
  'row.diagPool': '账号池',
  'row.diagPoolOn': '开启 · {count} 个账号',
  'row.diagPoolOff': '关闭',
  'row.diagFailures': '最近一次失败',
  'row.diagNoFailures': '没有报错。',
  'row.diagPromoUnreadable': '{count} 条活动时段读不懂 —— 徽标已隐藏',
  'row.cardCrashed': '配置区渲染失败。',
  'row.cardCrashedHint': '模型服务本身未受影响，对话与积分仍可用。反馈问题时请附上上面这行。',
  'row.modelsTitle': '模型',
  'row.modelsSummary': '已启用 {count} 个',
  // 折叠态显示在标题行。保存/放弃按钮在折叠区里面，没有这个提示，用户会把
  // 自己未保存的改动藏到折叠后面，而界面上什么都不说。
  'row.modelsDirty': '有未保存的修改',
  // 标题行中间的淡色提示。它说的是「此刻能做的动作」，因此读起来像一句指引，
  // 而不是区块的标签——写成固定的「展开或收起」会让读者自己去想该按哪个。
  'row.modelsRefresh': '从 WorkBuddy 刷新',
  'row.modelsRefreshing': '正在刷新模型…',
  'row.discard': '放弃修改',
  'row.save': '保存',
  'row.saving': '保存中…',
  'row.saveError': '保存失败：{message}',
  'row.saveContentionHint': '（该文件被占用，写入被拒——Windows 上通常是杀毒软件、OneDrive 这类同步盘，或正打开该文件的编辑器。请先关闭占用者再保存一次；你的改动仍然还在。）',
  'row.modelContext': '最大上下文 {context}',
  'row.contextBudget': 'DSH 上下文预算',
  'row.modelOutput': '最大输出 {output}',
  'row.modelRate': '积分 {rate}x',
  'row.modelMultimodal': '多模态',
  'row.modelImage': '图片',
  'row.modelImageText': '图片输入：厂商文档标明该模型仅支持文本，因此刷新时不会自动勾选。只有你确认它能读图，才建议手动勾上。',
  'row.modelImageUnverified': '图片输入未核实：没有厂商资料确认该模型能读图，刷新时按「不猜」处理，不会自动勾选。如果你验证过确实可用，可以手动勾上。',
  'row.modelOff': '可关闭思考',
  'row.modelOffHint': '为这个模型提供「关闭思考」档位',
  'row.modelOffRefused': '拒绝 off',
  'row.modelOffRefusedHint': '实测在两个网关上都拒绝「关闭思考」档位（HTTP 400 / code 11133）。勾选后，所有未指定推理档位的请求（尤其是压缩摘要）都会失败，因此这里不能启用。',
  'row.modelEffortLabel': '默认推理强度',
  'row.modelEffortAria': '{model} 的默认推理强度',
  'row.modelEffortHint': '请求未指定档位时这个模型使用的推理强度——新对话、压缩摘要、会话标题都属于这类请求。这里只列出 WorkBuddy 为该模型声明的档位；「默认（x）」里的 x 就是 WorkBuddy 自己声明的默认档位。',
  'row.modelEffortFollow': '默认',
  'row.modelEffortFollowNamed': '默认（{effort}）',
  'row.modelUnknown': '未知',
  'row.modelCapabilityPending': '仅展示 WorkBuddy 接口明确公布的模型能力。',
  // 两个一键遍历按钮（issue #61 的后续，与同族 trae 插件对齐）。成本写在 title 提示里
  // 而不是二次确认，按维护者的选择：「所有模型」含未启用的，所以比「仅启用」花得多。
  'row.modelsTestEnabled': '一键测试启用模型',
  'row.modelsTestAll': '一键测试所有模型',
  'row.modelsTesting': '测试中 {done}/{total}…',
  'row.modelsTestEnabledHint': '逐个测试你**已启用**的模型，一个模型一次请求 —— 每次探测都发真实体积的请求，真花积分（默认 25000 token 体积下约 0.01/个）。每行的结果一出来就显示。凭据被拒时提前停止。',
  'row.modelsTestAllHint': '测试本区域目录里的**每一个**模型，含**未启用**的 —— 所以比「仅测试启用模型」明显更贵。单次探测成本相同，凭据被拒时同样提前停止。',
  'row.tpsSweepEnabled': '一键测速启用模型',
  'row.tpsSweepAll': '一键测速所有模型',
  'row.tpsSweepEnabledHint': '测**已启用**模型的**输出速度**：每个模型跑 3 次取中位数。和上面的可用性探测不同，它只发一个极小的提示、要求返回 256 个输出 token —— 这个网关按**输入**计价，所以单模型成本低得多（实测 0.01–0.15 积分，可用性探测是 0.72）。速度之所以重要：DSH 会把模型当子代理并行派发，慢模型拖的是整个任务的实际耗时。',
  'row.tpsTesting': '测速中 {done}/{total}…',
  'row.tpsMeasure': '测速',
  'row.tpsMeasuring': '测速中…',
  'row.tpsHint': '测量该模型的输出速度：3 次短请求取中位数。每次约 256 个输出 token，成本远低于可用性探测（实测 0.01–0.15 积分）。结果旁边会标出**测量时间** —— 速度随负载变化，一个过期的数字比没有更糟。',
  'row.tpsValue': '{tps} tok/s',
  'row.tpsValueTtft': '{tps} tok/s · 首字 {ttft}s',
  'row.tpsPartial': '{tps} tok/s（{samples} 次）',
  'row.tpsNoSample': '无法测速：流里的分块太少，算不出速率',
  'row.tpsNoUsage': '无法测速：上游没报 token 数',
  'row.tpsAllFailed': '测速失败',
  'row.tpsCredit': '花费 {credit} 积分',
  'row.tpsMeasuredAt': '{at} 测',
  'row.modelsTestDone': '完成：{total} 个里 {available} 个可用',
  'row.modelsTestAuth': '已停止：凭据被拒，剩下的模型都会得到同一个答案。请重新登录后再跑一次。',
  'row.probe': '测试',
  'row.probing': '测试中…',
  'row.probeHint': '对该模型发一条真实体积的请求（约 25k 输入 token），报告它现在能不能用。上游的限流按请求体积触发——实测约 20k 能过、约 30k 被拒——所以小请求看着正常、长对话里却可能每次都被拒。这也是为什么每次测试都会消耗真实积分（约 0.7），且一次只测一个模型。',
  'row.probeOk': '✓ 可用',
  'row.probeOkMs': '✓ 可用（{ms}）',
  'row.probeRateLimitedUnknown': '✗ 被限流 · 上游未给出何时恢复',
  'row.probeRateLimitedAt': '✗ 被限流 · {at} 之后可再用',
  'row.probeModelBusyUnknown': '✗ 该模型当前负载较高 · 不是账号被限流——换账号没用，建议等待约 1 分钟或切换模型',
  'row.probeModelBusyAt': '✗ 该模型当前负载较高 · 不是账号被限流；{at} 之后可重试，或切换模型',
  'row.probeOutOfCreditUnknown': '✗ 积分不足 · 上游未给出何时恢复',
  'row.probeOutOfCreditAt': '✗ 积分不足 · 积分包 {at} 刷新',
  'row.probeCredentialRejected': '✗ WorkBuddy 拒绝了这个账号的 token——请重新登录或换一个账号',
  'row.probePolicyRejected': '✗ WorkBuddy 服务端按内容策略拒绝了这次请求——重新登录无效；可在桌面端验证或切换区域/账号',
  // PLAIN TEXT, no `**bold**` markup: this label is rendered as a JSX text
  // child (`probeResultView` → `<p>{view.text}</p>`), not through a rich-text
  // renderer, so markdown emphasis would reach the screen as literal
  // asterisks. Every sibling probe label in this file is plain text for the
  // same reason. (The `**` style IS used elsewhere — but only in strings that
  // go into a `title=` tooltip, where the host renders markdown.)
  'row.probeChannelRejected': '✗ 网关拦的是提示词本身，不是这个账号——某条 system 消息的开头命中了它的第三方 agent 过滤，换账号或换区域都会得到同一个答案（测试能过、聊天被拒，正是这个原因）',
  // THE SHORT FORM of the same verdict, for the composer panel's one-line mark
  // (issue #108). The full label above is an EXPLANATION — 88 characters in
  // Chinese, 179 in English — and the panel prints it beside an account name in
  // a column roughly 180 px wide. It cannot fit there by construction, so it was
  // clipped mid-sentence by `nowrap` + `overflow:hidden`, which reads as a
  // rendering bug rather than as "there is more to this". The panel gets the
  // VERDICT; the full sentence stays one hover away in the row's `title` (which
  // carries `availabilityLine`, not this) and on the pool card, which has room.
  'row.probeChannelRejectedShort': '✗ 网关拦的是提示词',
  'row.probeNotFound': '✗ 上游不认识这个模型',
  'row.probeUnavailable': '✗ 连不上上游——上游没有给出可用答复',
  'row.probeFailed': '✗ 测试失败',
  'row.probeFailedStatus': '✗ 测试失败（HTTP {status}）',
  'row.probeError': '无法执行测试：{message}',
  'row.cheer': '鼓励一下',

  // ---- OAuth 登录（国内扫码，国际版网页） ----
  'row.oauthTitle': '扫码添加账号',
  'row.oauthStart': '扫码登录',
  'row.oauthStarting': '正在打开…',
  // 弹窗内点击后自动在浏览器打开授权页（手势内占位窗口导航）；复制/重开按钮是
  // 打开被拦时的兜底。
  'row.oauthOpenHint': '打开登录页并完成确认——完成后账号会自动出现在这里：',
  'row.oauthOpened': '已打开，等待你完成登录…',
  'row.oauthWaiting': '正在等待登录完成…（{seconds} 秒）',
  'row.oauthExpires': '登录窗口约 {minutes} 分钟后过期。',
  'row.oauthCancel': '取消',
  'row.oauthCancelled': '已取消登录。',
  'row.oauthTimedOut': '登录超时——请重新开始。',
  'row.oauthDone': '已添加「{accountName}」。在上方选中它即可使用。',
  'row.oauthError': '登录失败：{message}',
  'row.oauthCopy': '复制链接',
  'row.oauthCopied': '已复制链接',
  'row.oauthReopen': '重新打开页面',
  'row.oauthDialogClose': '关闭',
  // 国际版登录是浏览器网页，国内版才是用 App 扫码。只拆「称呼登录方式」的三条，
  // 其余（等待、取消、完成）与方式无关，继续共用，避免两个区域在别处走偏。
  'row.oauthTitleGlobal': '网页登录添加账号',
  'row.oauthStartGlobal': '网页登录',
  // ---- 共用缓冲遮罩 ----
  'row.veilHintList': '完成后列表会立即刷新。',
  'row.oauthSyncing': '正在添加账号…',
  'row.transferTitle': '导出 / 导入账号',
  'row.transferHint': '用 JSON 文件在电脑之间迁移账号。文件里是账号凭据——请妥善保管。该格式与同类 WorkBuddy 凭据管理工具通用。',
  'row.transferExport': '导出账号',
  'row.transferExporting': '正在导出…',
  'row.transferExportPick': '选择要导出的账号（共 {total} 个）：',
  'row.transferExportConfirm': '导出 {count} 个账号',
  'row.transferExported': '已导出 {count} 个账号到 {fileName}。',
  'row.transferImport': '导入账号',
  'row.transferImporting': '正在导入…',
  'row.transferPreviewing': '正在读取文件…',
  'row.transferPreviewTotal': '文件中共 {total} 个账号——不需要的请取消勾选。导入会覆盖这里已存储的同名账号。',
  'row.transferImportConfirm': '导入 {count} 个账号',
  'row.transferImported': '已导入 {imported} 个账号；跳过 {skipped} 个（缺 token，或属于另一个区域）。',
  'row.transferEntryUnknown': '未知账号',
  'row.transferNoToken': '此记录没有 token',
  'row.transferCancel': '取消',
  'row.transferError': '传输失败：{message}',

  // ---- 账号池 ----
  'row.poolTitle': '账号池',
  'row.poolNoCandidate': '账号池里目前没有可用的账号。',
  'row.poolNoCandidateHint': '成员要么在限流冷却中、要么积分耗尽、要么凭据被拒、要么上游无响应。限流、积分耗尽与瞬时故障都会自动回池——按上游给出的恢复时间，没给时间就按 30 分钟兜底，不需要你操作；只有「凭据被拒」需要重新登录。',
  // 「所有成员都撞在同一个模型上」的池级结论（issue #64）。与上面那条刻意分开：
  // 那条说的是**账号**不行，这条说的是**账号没问题、模型才是那堵墙**。没有它，
  // 卡片上每行「模型繁忙」加起来就成了一个整体上错误的结论，用户会去找一个不存
  // 在的坏账号 —— 正是 issue #56 报告的那场搜寻。
  'row.poolModelWideBusy': '所有成员都卡在同一个模型上 —— 这是模型的问题，不是你的账号。',
  'row.poolModelWideBusyHint': '换账号解决不了：限制跟随模型，换一个账号撞的是同一堵墙。等大约 1 分钟，或把这个会话切到负载较低的模型。',
  // 「勾选的」而不是「所有」：这两个按钮只走勾选进池的成员，而表格里
  // 未勾选的行就摆在旁边 —— 「所有账号」会被读成「我登录过的每一个账号」，
  // 与禁用条件（一个都没勾就置灰）和成员区那句「只有勾选的账号参与轮换、
  // 签到与测试」都对不上。
  'row.poolCheckinAll': '签到勾选的账号',
  'row.poolCheckingIn': '签到中…',
  'row.poolTestAll': '测试勾选的账号',
  'row.poolTesting': '测试中…',
  'row.poolBusyHint': '正在逐个账号执行…',
  'row.poolTargetAuto': '自动',
  'row.poolTargetStaleShort': '目标模型已失效',
  'row.poolTargetNoneShort': '无免费模型',
  'row.poolTargetFree': '自动选中的免费模型：{model}',
  'row.poolTargetPreferred': '你指定的模型：{model}',
  'row.poolTargetCurrentPreferred': '当前：{model}（你指定）。',
  'row.poolTargetCurrentFree': '当前：{model}（自动挑选的免费模型）。',
  'row.poolTargetNone': '本区域暂时没有倍率为 0 的免费模型。',
  'row.poolTargetStale': '你保存的目标模型已不在目录中：{model}',
  'row.poolTargetStaleHint': '本区域的模型目录已变化，不再包含这个模型，因此测试被停用——而不是拿一个上游可能不接受的模型去跑。请改选一个目标模型，或切回自动。',
  'row.poolTargetStaleClear': '切回自动',
  'row.poolTargetStaleOption': '{model}（已下架）',
  'row.poolTargetNoneHint': '国内版的倍率要等模型目录刷新后才会出现。为了不让你在不知情的情况下花掉积分，插件不会自动改用收费模型——请先刷新模型目录，或自己指定一个目标模型。',
  'row.poolColumnAccount': '账号',
  'row.poolColumnCredits': '积分',
  'row.poolColumnProbe': '状态',
  'row.poolColumnCheckin': '签到',
  'row.poolNeverTested': '未测试',
  'row.poolTestedAt': '测试于 {at}',
  'row.poolCheckedIn': '已签到',
  'row.poolNotCheckedIn': '未签到',
  'row.poolCheckinUnknown': '—',
  'row.probeAccountRestricted': '账号被上游限制使用',
  'row.poolCheckinEnterprise': '不适用（企业版）',
  'row.poolBenefitClaimable': '{title}：{count} 积分',
  'row.poolBenefitUrgent': '{title}：{count} 积分 · 剩 {days} 天',
  'row.poolBenefitDueToday': '{title}：{count} 积分 · 今天截止',
  'row.poolBenefitClaim': '领取',
  'row.poolBenefitClaiming': '领取中…',
  'row.poolBenefitClaimAria': '为该账号领取{title}（{count} 积分）',
  'row.poolLogBenefitClaimed': '{accountName} 已领取{title}：{count} 积分',
  'row.poolLogBenefitFailed': '{accountName} 领取失败：{message}',
  'row.poolBenefitHint': '去套餐与积分页领取：{url}',
  'row.poolCreditSoon': '{count} 积分 3 天内过期',
  'row.poolCreditNearest': '最近积分包 {at} 过期',
  'row.poolExcludedRateLimited': '被限流',
  'row.poolExcludedModelBusy': '模型繁忙',
  'row.poolExcludedOutOfCredit': '积分耗尽',
  'row.poolExcludedRejected': '被拒绝',
  'row.poolExcludedAccountRestricted': '账号被上游限制使用',
  'row.poolExcludedUnusable': '不可用',
  'row.poolRetryAt': '{at} 之后可再用',
  'row.poolRetryUnknown': '上游未给出何时恢复',
  // 上游给出的恢复时间的「相对说法」。总是与绝对时刻**并列**显示，而不是取代它：
  // 绝对时刻是上游的原话、始终权威，这几个键只是替读者省掉一次心算。
  'row.remainingImminent': '即将恢复',
  'row.remainingMinutes': '约 {count} 分钟后',
  'row.remainingHours': '约 {count} 小时后',
  'row.remainingDays': '约 {count} 天后',
  // 带动词的同一时长（`recoversInText`）：账号行上单独一句「约 2 小时后」只说了
  // 时长，没说那一刻会发生什么 —— 读起来既可能是「限流解除」也可能是别的。
  // 这一行整行的职责就是回答「这个账号现在能不能用」，所以动词不能省。
  'row.recoversImminent': '即将恢复',
  'row.recoversMinutes': '约 {count} 分钟后恢复',
  'row.recoversHours': '约 {count} 小时后恢复',
  'row.recoversDays': '约 {count} 天后恢复',
  // 记录有多旧、以及是谁写的。两个写入方会互相覆盖同一个账号的记录，
  // 没有这两项就无法解释用户亲眼看到的变化（测出 ok，过后变成被限流）。
  'row.poolProbeJustNow': '刚刚',
  'row.poolProbeMinutesAgo': '{count} 分钟前',
  'row.poolProbeHoursAgo': '{count} 小时前',
  'row.poolProbeDaysAgo': '{count} 天前',
  'row.poolProbeSourceTest': '测得',
  'row.poolProbeSourceLive': '聊天撞上',
  'row.poolProbeSourceUnknown': '来源未知',
  // 结论是针对**哪个模型**的（issue #61）。6004 是「账号 × 模型」维度的条件，
  // 只写「可用」会被读成账号级结论，而被拒的恰恰是用户真在用的那个模型。
  'row.poolProbeModel': '模型 {model}',
  'row.poolProbeModelUnknown': '未记录模型',
  'row.poolSettingsTitle': '更多设置',
  'row.poolSettingsHint': '下面是偏好设置：点保存才生效（与「模型管理」一致）。测试结果由插件自动写入，不受这个保存按钮影响。',
  'row.poolEnabled': '启用账号池',
  'row.poolEnabledHint': '开启：由账号池为每次请求挑号；只有可换号的失败才换下一个——请求本身不合法、模型繁忙、平台排队、渠道校验这四类不换（换号只会为同一个拒绝白烧一次配额）。关闭：你选的账号服务每一次请求，失败如实报错。',
  'row.poolModeAuto': '自动挑号',
  'row.poolModeManual': '手动选号',
  'row.poolManualAccountLabel': '使用哪个账号',
  'row.poolManualAccountNone': '当前没有生效的账号',
  'row.poolTargetLabel': '测试用模型（全池统一）',
  'row.poolTargetHint': '全池共用这一个模型，测试就是拿它逐个去测。「自动」会从本区域目录里挑一个倍率为 0 的免费模型，多个候选取上下文窗口最大的；手动指定优先于自动。',
  'row.poolTargetAutoOption': '自动 —— 挑一个免费模型',
  'row.poolProbeSizeLabel': '测试请求体积',
  'row.poolProbeSizeHint': '测试时发送多少文本。上游在请求大约超过 2 万～3 万 token 时会开始拒绝，所以测试体积若小于你真实对话的体积，就会出现「测出可用、实际一发就被限」。体积越大测得越准，但每次测试消耗的积分也越多。',
  'row.poolProbeSizeDefault': '默认（2.5 万）',
  'row.poolProbeSizeOption': '{tokens} 万 token',
  'row.poolSaved': '保存',
  'row.poolSaving': '保存中…',
  'row.poolSaveFailed': '保存失败：{message}',
  'row.poolSavedStaleRefresh': '已保存，但面板未能重新读取。设置已写入；下次刷新后会显示。',
  'row.poolDiscard': '放弃修改',
  'row.poolDirty': '● 有未保存的修改',
  'row.poolManualUnlock': '关闭自动轮换',
  'row.poolLogTitle': '活动记录',
  'row.poolLogClear': '清空',
  'row.poolLogEmpty': '尚无活动。签到、测试与账号切换都会记录在这里。',
  'row.poolLogCheckinStart': '开始签到 {count} 个账号（逐个执行）',
  'row.poolLogCheckinClaimed': '{accountName}：签到成功 +{credit}',
  'row.poolLogCheckinAlready': '{accountName}：今日已签到，跳过',
  'row.poolLogCheckinSkipped': '{accountName}：企业账号无每日签到',
  'row.poolLogCheckinFailed': '{accountName}：签到失败 —— {message}',
  'row.poolLogCheckinDone': '签到完成',
  'row.poolLogBatchFailed': '批量操作失败 —— 没有执行：{message}',
  'row.poolLogTestStart': '开始测试 {count} 个账号 × {model}',
  'row.poolLogTestRow': '{accountName}：{outcome}',
  'row.poolLogTestDone': '测试完成，已重新计算候选账号',
  'row.poolLogTestRowMalformed': '{accountName}：Host 未返回该账号的结果',
  'row.poolRegionNote': '国内版与国际版是完全独立的两个账号池：账号、开关、间隔、目标模型互不影响。',
  'row.poolMembersTitle': '本池包含的账号',
  'row.poolMembersHint': '只有勾选的账号参与轮换、签到与测试。',
  'row.poolSelectAll': '全选',
  'row.poolSelectNone': '全不选',
  'row.poolSelectedCount': '已选 {count} / {total}',
  // 排序规则说明。顺序必须与 rankPool 的比较器完全一致（见 src/account-pool.ts）。
  'row.poolOrderRulesTitle': '本池如何挑选账号',
  'row.poolOrderRulesIntro': '池子总是先挑「现在确实能扣费的」账号。下面这些规则按顺序逐条比较，第一条分出胜负就停止，后面的只在平局时才看。',
  'row.poolOrderRuleUsable': '1. 现在能扣费吗？被限流、积分耗尽、凭证被拒或调用失败的账号会被挪到后面，直到冷却结束。这一条优先级最高，压过下面的手动顺序。',
  'row.poolOrderRuleExpiring': '2. 有 3 天内会过期的积分吗？有就排前面。这一条同样压过手动顺序，原因见下方说明。',
  'row.poolOrderRuleManual': '3. 你排的手动顺序。就是用 ↑ / ↓ 设定的位置。没有手动排过的账号，会排在所有已排序账号之后。',
  'row.poolOrderRuleNearestExpiry': '4. 谁先过期？两个都有临期积分时，先到期的排前面。',
  'row.poolOrderRuleExpiringAmount': '5. 过期多少？同样是两个都有临期积分时，临期数额大的排前面。没有临期积分时，这一步等同于比较总积分。',
  'row.poolOrderRuleTotal': '6. 总积分。积分多的排前面，接近耗尽的号先留着备用。',
  'row.poolOrderRuleFreshness': '7. 登录凭证新旧。凭证签发更晚的赢下平局。',
  'row.poolOrderRuleId': '8. 账号 id。最终兜底，保证同样的池子每次排出来的顺序都一样。',
  'row.poolOrderWhy': '为什么临期积分压过手动顺序：临期积分是马上要过期的钱，而手动顺序可能已经过时、也可能是手滑拖错了。如果让手动顺序赢，一次误拖就足以让积分白白过期。所以有 3 天内到期积分的账号，永远排在没有的账号前面 —— 哪怕你把它拖到了最后一位。',
  'row.poolOrderBadgeNote': '徽标显示的是你「保存」的位置，不是此刻的实际排序。一个账号可能写着「第 2 位」却因为被限流而暂时不被选中 —— 那个数字代表你的偏好，池子会跳过当下无法扣费的账号。',
  'row.poolOrderRulesToggle': '查看完整排序规则',
  'row.poolNoneSelected': '还没有勾选任何账号。',
  'row.poolNoneSelectedHint': '勾选至少一个账号，才能签到与测试。',
  'row.poolGhostMembers': '有 {count} 个已选入本池的账号在本机已不再登录，因此不计入、也不会被使用：{names}。不需要的可在下方逐个移除。',
  'row.poolGhostRemove': '把 {account} 移出本池',
  'row.poolGhostRemoveNamed': '把 {account} 移出本池。该账号在本机已不再登录。',
  'row.poolGhostRemoveUnnamed': '把 {account} 移出本池。这个账号从未记录过名字，显示的是它 id 的开头几位。',
  'row.poolSelectAria': '把 {accountName} 加入本区域的账号池',
  'row.poolCurrentBadge': '当前使用',
  'row.poolCurrentHeader': '当前使用：{account}',
  'row.poolNotMember': '未入池',
  'row.poolNotMemberHint': '不在池里：不参与轮换，也不进批量签到与测试。',
  'row.poolServingOutside': '「{account}」正在使用，但不在这个池里：轮换不会挑它，批量签到与测试也不会动它。',
  'row.poolUnsavedMembers': '勾选已改动 —— 保存后生效',
  // 手动优先级排序：排序徽标与 ↑/↓ 移动按钮。徽标不可点（只描述当前顺序），箭头负责调整。
  'row.poolRankLabel': '第 {rank} 位',
  'row.poolRankManualTitle': '你在本池中手动把该账号排在第 {rank} 位。',
  'row.poolRankAuto': '自动排序',
  'row.poolRankAutoTitle': '还没有手动排序：池会先花临期积分，再按余额多寡选号。用 ↑/↓ 自己指定顺序。',
  'row.poolMoveUpTitle': '在本池顺序中上移该账号',
  'row.poolMoveDownTitle': '在本池顺序中下移该账号',
  'row.poolMoveUpAria': '在本池顺序中上移 {accountName}',
  'row.poolMoveDownAria': '在本池顺序中下移 {accountName}',
  // 行级操作：测试单个账号 / 删除单个账号。
  'row.poolRowTest': '测试',
  'row.poolRowRemove': '删除',
  'row.poolRowRemoveHint': '把这个账号从列表中移除。桌面 App 不会被退出登录——它保留自己的登录状态。移除只是暂时隐藏，点「重新检测账号」即可找回。',
  'row.poolRowRemoveAria': '删除 {accountName} 的已存凭据',
  'row.poolRowRemoved': '{accountName}：已从列表中隐藏。点「重新检测账号」会重新加入，桌面 App 的登录不受影响。',
  'row.poolRowRemoving': '正在删除账号…',
  'row.poolRowRemoveDesktopOnly': '{accountName}：已从列表中隐藏——这个账号来自桌面 App 自己的登录，该登录未被改动。点「重新检测账号」会重新加入。',
  // 设备头档位与逐账号齿轮。中文这几句的要点与英文一致：**「真实值」= 所有账号
  // 共用这台机器真实的设备**，所以齿轮关掉——一台真机不可能有两个 id。只写"不可
  // 编辑"而不写原因，用户会当成控件坏了。
  'row.deviceModeTitle': '设备头',
  'row.deviceModeVirtual': '虚拟值',
  'row.deviceModeReal': '真实值',
  'row.deviceModeHintVirtual': '每个账号使用一台按本机盐派生的虚拟设备。点某行右侧的齿轮可以手工指定它的值。',
  'row.deviceModeHintReal': '所有账号共用这台机器真实的设备，由内置 SDK 签发。齿轮已关闭——一台真机不能有两个不同的 id。SDK 不可用时一个设备头都不发（见「SDK」分区）。',
  'row.deviceGearHint': '编辑这个账号的设备标识（X-Machine-ID / X-Session-ID）',
  'row.deviceGearBlockedHint': '只在「虚拟值」档下可用',
  'row.deviceGearAria': '编辑 {accountName} 的设备参数',
  'row.deviceModeRealBlockedTitle': '请先切回「虚拟值」',
  'row.deviceModeRealBlocked': '「真实值」档下所有账号共用这台机器的真实设备，没有"这个账号"的参数可改。把设备头切回「虚拟值」后再点齿轮。',
  'row.deviceDialogTitle': '设备参数 · {accountName}',
  'row.deviceDialogIntro': '这两个值就是该账号发给上游的 X-Machine-ID / X-Session-ID。留空表示继续按本机盐自动派生。',
  'row.deviceMachineLabel': '机器 ID（X-Machine-ID）',
  'row.deviceSessionLabel': '会话 ID（X-Session-ID）',
  'row.deviceFieldPlaceholder': '留空 = 自动派生',
  'row.deviceRandom': '一键随机',
  'row.deviceRandomHint': '一次给两项各填一个 36 位随机 id',
  'row.deviceDialogP3': '真实设备 Token',
  'row.deviceDialogP3Hint': '由内置 Turing Shield SDK 签发。「真实值」档下所有账号用它；它不在这里编辑——见「SDK」分区。',
  'row.deviceDialogCancel': '取消',
  'row.deviceDialogSave': '保存',
  'row.deviceDialogSaving': '保存中…',
  'row.deviceInvalid': '需要 36 个十六进制字符（0-9a-f）',
  'row.panelSdk': 'SDK',
  'sdk.hint': '这台机器通过内置 SDK 签发的真实设备 token。「真实值」档下所有账号都发这一个值；「虚拟值」档完全不碰它。',
  'sdk.loading': '正在询问 SDK…',
  'sdk.unavailable': '这个 Host 版本没有 SDK 路由——这里拿不到真实设备参数。「虚拟值」档不受影响。',
  'sdk.state': '连接状态',
  'sdk.statusReady': '正常',
  'sdk.statusStale': '能连上，但最近一次取数失败——仍在使用上一枚 token',
  'sdk.statusNoToken': 'SDK 已加载，还没取到 token——点「重新获取」',
  'sdk.statusMissing': '这个平台没有内置 SDK',
  'sdk.statusUnsupported': 'SDK 拒绝了这个平台',
  'sdk.statusError': 'SDK 加载失败',
  'sdk.bundle': 'SDK',
  'sdk.runtime': '运行时',
  'sdk.fetched': '最近取到',
  'sdk.tier': '当前档位',
  'sdk.tierReal': '真实值——账号发的就是它',
  'sdk.tierVirtual': '虚拟值——这枚 token 不发出去',
  'sdk.valueLabel': 'X-Device-Token',
  'sdk.noValue': '还没有可用的 token',
  'sdk.length': '{count} 字符',
  'sdk.reveal': '显示',
  'sdk.hide': '隐藏',
  'sdk.copy': '复制',
  'sdk.copied': '已复制',
  'sdk.refresh': '重新获取',
  'sdk.refreshing': '获取中…',
  'sdk.never': '从未',
  'sdk.unknown': '未知',
  'sdk.ageJustNow': '刚刚',
  'sdk.ageMinutes': '{count} 分钟前',
  'sdk.ageHours': '{count} 小时 {rest} 分前',
  // 生图工具是本插件里唯一「由模型自己决定花钱」的能力（宿主没有逐次确认的
  // 机制），所以默认关闭，文案也必须把单价说出来，而不是只给它一个名字。
  // 单价按区分：国内区约 5.71、国际区约 0.03 积分/张（2026-10-25 实测；目录
  // 里没有价格，只有结算时的 usage.credit），工具本身回报的是实扣值。
  'row.upstreamHint': '这一组改的是网关看到什么，不是由哪个 provider 提供服务。四项都在插件挂载时采样，改完需重载插件或重启 DSH。',
  'row.usageIdentityLabel': '让用量页把调用记成官方客户端的样子',
  'row.usageIdentityHint': '补上 X-IDE-* 头（「使用端」那一列就不会空白），并把会话 id 改成 32 位十六进制 UUIDv7。只影响显示：User-Agent 与请求正文永不变。默认关闭——证据来自报告者，本插件未在真机复现。',
  'row.keepPromptLastLabel': '记录你真正输入的话，而不是注入的上下文',
  'row.keepPromptLastHint': '把宿主注入的运行上下文挪到真实提问前面，用量页就不会再把「Time sampled…」当成你的提问。消息条数与文本都不变。默认关闭——它会改变上游会数到的消息顺序。',
  'row.sessionTitleLabel': '会话标题请求改用轻量模型',
  'row.sessionTitleHint': '宿主每个新会话都会发一次标题请求，并按主模型费率计费；开启后这一次改投隐藏的轻量模型。请求无论开不开都会发出。默认关闭。',
  'row.sessionTitleModel': '目标模型：',
  'row.extraPrefixesCount': '生效的自定义注入前缀：',
  // 渠道门自动续发。这段文案要同时说清三件事：它只对哪一种失败起作用、它会花掉
  // 真实请求、上限数的是**连续**次数——因为开关默认关闭，而用户了解这些的唯一
  // 其他途径就是配置文件。
  'row.channelRejectContinueLabel': '被网关渠道校验拦截后，自动再发一次「继续」',
  'row.channelRejectContinueHint': '最后兜底，不是 11128 的修复。上游用 400 + code 11128（「被网关的渠道校验拦截」）拒绝时，这一轮就直接失败了：插件不会在原地重试，也不会换号——网关匹配的是消息内容，每个账号发出去都一样。固定 system 指纹每一轮逐字节相同，重发只会再付一次同一个 400；5.13.1 起由 `prepareChatBody` 按句改词处理。只有被拒内容刚好随轮次变化的窄情况才可能靠新回合碰过去。它会把下面这句作为新回合发出，每次真实消耗一次请求；默认只发 1 次、默认关闭；连续计数，成功一轮或你自己发一条消息即清零。子代理会话一律不碰，改完立即生效，不必重载插件。',
  'row.channelRejectContinueLimit': '连续发送上限：',
  'row.channelRejectContinueText': '发送的文本：',
  'row.cliBridgeLabel': '允许调用本机 CodeBuddy CLI 干活',
  'row.cliBridgeHint': '开启后多出 codebuddy_ask 工具与 /codebuddy 指令；每次调用花 CodeBuddy 配额。injectResult 只影响 /codebuddy：其结果回注会话，会话空闲时多花一次 DSH 回合；工具调用不读它。限流：每会话每小时 6 回合、每进程每小时 20 回合、同时只跑一个回合。默认关闭。',
  // 本地 CLI 路由的三个快调旋钮：跑哪个模型、哪个推理档位、按什么顺序
  // 遍历凭据区域。模型列表不写死——是卡片已为当前页签同步到的目录，
  // 跟随上游；已选值即使目录里没有也会原样列出，不让它无声消失。
  'row.cliBridgeModelLabel': 'CLI 模型',
  'row.cliBridgeModelDefault': 'CLI 默认',
  'row.cliBridgeModelAria': '本地 CodeBuddy CLI 运行所用的模型',
  'row.cliBridgeModelHint': '写入 cliBridge.model，CLI 以 --model 接收；"CLI 默认"表示沿用 CLI 自身默认。列表来自当前页签同步到的目录。',
  'row.cliBridgeEffortLabel': 'CLI 档位',
  'row.cliBridgeEffortDefault': 'CLI 默认',
  'row.cliBridgeEffortAria': '本地 CodeBuddy CLI 的推理档位',
  'row.cliBridgeEffortHint': '写入 cliBridge.effort，CLI 以 --effort 接收；"CLI 默认"表示沿用 CLI 自身默认。所选模型列出支持档位时只给出这些档位。',
  'row.cliBridgeRegionOrderLabel': '区域顺序',
  'row.cliBridgeRegionOrderAria': '本地 CodeBuddy CLI 遍历凭据区域的顺序',
  'row.cliBridgeRegionOrderHint': '写入 cliBridge.regionOrder：CLI 按此顺序尝试 WorkBuddy 凭据，直到登录成功；实际使用的区域在工具输出里以 credential_region 报告。自下次调用起生效。',
  'row.cliBridgeRegionOrderCnFirst': '国内优先',
  'row.cliBridgeRegionOrderGlobalFirst': '国际优先',
  'row.cliBridgeRegionOrderCnOnly': '仅国内',
  'row.cliBridgeRegionOrderGlobalOnly': '仅国际',
  'row.cliBridgePickersHint': '三个选择都写入全局 cliBridge 块；模型/档位的"CLI 默认"是显式的空值而非未设置，届时 CLI 使用自己的默认；区域选择写入 cliBridge.regionOrder。',
  'row.imageToolLabel': '允许模型自主生图',
  'row.imageToolHint': '开启后模型可以自己调用 workbuddy_draw_image 画图——国内区约 5.71、国际区约 0.03 积分/张，没有逐次确认。在这里勾选只授权当前这一区的账号。两区都关着时该工具根本不会注册。',
  'row.videoToolLabel': '允许模型自主生视频',
  'row.videoToolHint': '开启后模型可以自己调用 workbuddy_draw_video 生成短视频——视频是异步任务（提交、轮询到完成、再下载到本地），要几十秒到几分钟，没有逐次确认。在这里勾选只授权当前这一区的账号。两区都关着时该工具根本不会注册。',
  'row.videoModelLabel': '按模式指定视频模型',
  'row.videoModelHint': '文生视频与图生视频各钉一个，选项只来自当前这一区自己的目录——模型 id 不跨区。调用时不填 model 就用这里钉的；什么都没钉就用该组第一个模型。钉住的模型如果目录里已经没有了，会安静地回落到第一个，而不是让这次生成失败。',
  'row.videoModelDefault': '默认（组内第一个）',
  // 媒体模型清单。它回答的是「这一区到底能画什么」，唯一可信来源是该区账号
  // 自己的产品配置：目录里既没有价格也没有能力标志。其中「图像」那一半仍是
  // 列表（每个图像 tag 组今天只有一个模型）；「视频」那一半可以在上面的选择器
  // 里钉住，因为国内区现在每个视频 tag 组有两个模型。
  'row.mediaModelsLabel': '本区可用的图像模型',
  'row.mediaModelsHint': '读自当前账号的产品配置。生图工具就按这里挑模型：不填图片走「文生图」那一组，填了图片走「图生图」那一组。「图像」那几行是只读的（想换就在调用工具时指定模型）；「视频」模型可以在上面的选择器里钉住。',
  'row.mediaModelsEmpty': '这一区的产品配置里没有图像或视频模型。',
  'row.mediaModelsError': '读取媒体模型清单失败：{message}',
  'row.mediaModelsRefresh': '重新读取',
  'row.mediaModelsRefreshing': '正在读取…',
  'row.mediaTagTextToImage': '文生图',
  'row.mediaTagImageToImage': '图生图',
  'row.mediaTagTextToVideo': '文生视频',
  'row.mediaTagImageToVideo': '图生视频',
  'row.showCreditsCn': '在输入框工具栏显示积分读数',
  'row.showCreditsGlobal': '在输入框工具栏显示积分读数',
  'row.showCreditsCnHint': '在对话输入框工具栏显示国内版（WB CN）剩余积分，仅当本会话使用 WB CN 模型时出现。点击可看各账号余额并一键测试勾选的账号（测试会真实消耗积分）。读数每 5 分钟自动刷新；各账号明细在面板打开时每 60 秒刷新。',
  // 积分显示在哪个位置（issue #62）。输入框工具栏是**共享**的 list 插槽，
  // 别的插件也注册在那里时本插件读数会消失（报告者遇到的就是这个），
  // 所以位置做成可选项。
  'row.creditPositionLabel': '显示位置',
  'row.creditPositionComposer': '输入框工具栏',
  'row.creditPositionStats': '输入框下方',
  'row.creditPositionAria': '{region} 的积分显示位置',
  // 位置选择器的从属说明，**始终可见**：它解释的是「为什么这里还有个下拉框」，
  // 而不是复述选项名称 —— 复述类说明只该在该行灰掉时出现，见
  // creditPositionDisabledHint。两段文字都刻意短：它们是主开关标题下的
  // 第二、三级文字，再长就会把主开关本身挤成次要信息。
  'row.creditPositionHintInline': '读数显示在哪里。「输入框工具栏」是默认位置，与模型选择同一行。',
  'row.creditPositionDisabledHint': '主开关关闭时不可调整：先勾选上方「在输入框工具栏显示积分读数」。',
  // 这一行讲「读数是什么」；下面 creditPositionHintInline 讲「选位置是什么意思」。
  // 一个控件一句说明。
  'row.showCreditsHintInline': '当前为本 tab 服务的那个账号的余额。点一下能看各账号明细，另外每 5 分钟自动刷新一次。',
  // 额度失败的补充（issue #63），渲染成**对话里的行内括号**——一句短话，没有对话框、
  // 没有按钮。插件**不再**占用宿主的 `shell.quota-notice` 链座位，所以这句不再由本插件
  // 拼在宿主句子后面（那次占用才是把无样式 span 留在 overlay 左上角的原因）；宿主自己画
  // 它那句，本插件只在这句旁边补一句。措辞对 QUOTA 覆盖的**两种**情况都成立 —— 模型自己
  // 的每日额度（与积分无关）与真的积分耗尽 —— 因为上游说的是中文散文，插件不允许解析它
  // 来下政策判断。
  'quotaNotice.fallbackHead': '当前请求的额度已用尽',
  'quotaNotice.supplement': '（部分模型另有每日额度，与积分无关）',
  'row.creditPositionHint': '积分显示在哪里。「输入框工具栏」是默认位置（与模型选择同一行）。如果装了别的插件后读数不显示，改成「输入框下方」—— 那是「轮次 / 步数 / token」统计所在的那一行。',
  'row.showCreditsGlobalHint': '在对话输入框工具栏显示国际版（WB AI）剩余积分，仅当本会话使用 WB AI 模型时出现。点击可看各账号余额并一键测试勾选的账号（测试会真实消耗积分）。读数每 5 分钟自动刷新；各账号明细在面板打开时每 60 秒刷新。',
  'composer.pointsCn': 'WB CN',
  'composer.pointsGlobal': 'WB AI',
  'composer.panelTitleCn': 'WB CN 积分',
  'composer.panelTitleGlobal': 'WB AI 积分',
  'composer.account': '账号',
  'composer.credits': '积分',
  'composer.switchTo': '切换到 {account}',
  'composer.current': '当前选用',
  'composer.noAccounts': '该区域暂无账号',
  'composer.signedOut': '未登录',
  'composer.testAll': '一键测试',
  'composer.testing': '正在测试…',
  'composer.testAllHint': '逐个测试本区所有账号（一次一个，避免触发上游限流）',
  'composer.testFailed': '测试失败',
  'composer.refreshFailed': '积分刷新失败',
  'composer.lastRefresh': '最近刷新',
  'composer.panelTitle': 'WorkBuddy 积分',
  // 「· N 新模型」段的措辞。措辞必须停在「本机首次见到」：本插件拿不到上游
  // 的「上架时间」字段，说「网关新增」就是在替上游编一个事实。段与面板行只在
  // 数量非零时渲染。
  'composer.newModels': '新模型',
  'composer.newModelsRow': '本机首次见到的模型',
  'composer.newModelsTitle': '本机首次见到的模型：',
  'composer.newModelsSep': '、',
  'composer.newModelsNote': '「新」指本机首次记到它，与上游何时上架无关。只列最近 7 天内首见的。',
  'sidebar.creditsCn': 'WB CN 积分',
  'sidebar.creditsGlobal': 'WB AI 积分',
  'sidebar.refresh': '刷新',
  'sidebar.refreshing': '刷新中…',
  'sidebar.lastRefresh': '最近刷新 {time}',
  'sidebar.refreshFailed': '刷新失败',
  'sidebar.signedOut': '未登录',
  'cliLive.running': 'CodeBuddy',
  'cliLive.toolCalls': '{count} 次工具',
  'cliLive.elapsed': '{seconds} 秒',
  'cliLive.starting': '启动中…',
  'cliLive.finishing': '收尾中…',
  'cliLive.lastTool': '最近：{tool}',
  'cliLive.chars': '{count} 字',
  'cliLive.aria': '有一个 CodeBuddy 回合正在跑：{detail}',
}
