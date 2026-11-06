/**
 * The CN region's gateway host, and the ONE place an override is validated.
 *
 * ## Why this exists (issue #220)
 *
 * The CN chat gateway was the single hard-coded constant
 * `https://copilot.tencent.com`. In a corporate network that filters on the TLS
 * ClientHello's SNI, that name is reset before the handshake completes — while
 * the SAME network lets the WorkBuddy desktop app work, because the app reads a
 * failover list from its own config and uses `wb.tencentbuddy.com` as well.
 *
 * The reporter measured (2026-11-06): `copilot.tencent.com` answers
 * `ECONNRESET` in <100ms while `wb.tencentbuddy.com` answers a normal
 * `401 Authorization Required`. This module is what lets such a user point the
 * plugin at a host their network actually permits.
 *
 * ## Why an allowlist, and not "any URL you like"
 *
 * The value feeds `Authorization: Bearer <token>` on every CN request, plus the
 * refresh-token exchange. A free-form base is therefore a **credential
 * exfiltration primitive**: whoever can edit the settings (a synced profile, a
 * shared dotfile, a pasted "fix" from a forum post) could redirect a live
 * WorkBuddy token to a host they run. That is a strictly worse failure than the
 * timeout it fixes, and it is invisible — the requests would keep succeeding.
 *
 * So the override names a HOST from a closed set, never a URL from the open
 * internet. The set is the CN product's own brand registrable domains, measured
 * 2026-11-06 to answer the chat, billing, catalog and busy routes identically
 * (see `docs/CN_GATEWAY_FALLBACK.md`):
 *
 *   copilot.tencent.com     the shipping default
 *   wb.tencentbuddy.com     what the desktop app's failover.json lists
 *   www.workbuddy.cn        the brand host
 *   www.codebuddy.cn        the sibling brand host, also the billing base
 *
 * Each is admitted by REGISTRABLE domain, so any subdomain of those brands
 * qualifies and a lookalike (`wb.tencentbuddy.com.evil.example`) cannot —
 * the same rule `knownRegionOf` already applies to credential domains.
 *
 * ## What an override does NOT change
 *
 * `Origin` / `Referer` stay on the billing base (see `originReferer`): they
 * describe which web app the request comes from, not which socket it reaches.
 * Rewriting them from the override would make the identity claim disagree with
 * itself for no benefit — the gateway reads them as "this is the CN web app".
 *
 * @module dsh-connect-workbuddy/cn-gateway
 */

/** The CN chat gateway the plugin has always used. */
export const CN_GATEWAY_DEFAULT = 'https://copilot.tencent.com'

/**
 * Environment override for `doctor`, mirroring the settings field.
 *
 * WHY THIS EXISTS. `dsh plugin exec … doctor` runs in its own process, which
 * never loads the plugin's settings — the same reason `WORKBUDDY_DEVICE_TOKEN_FILE`
 * already exists as the CLI's way to see what the plugin sees. Without it, a
 * user who fixed their network via the card's field would run `doctor` and get a
 * report measured against the gateway their network RESETS: a diagnostics tool
 * that lies about which host it probed is worse than no tool.
 *
 * The plugin reads the settings field; `doctor` reads this. Both go through
 * `resolveCnGateway`, so the allowlist cannot diverge between them.
 */
export const WORKBUDDY_CN_BASE_ENV = 'WORKBUDDY_CN_BASE'

/**
 * Hosts an override may name, as registrable domains.
 *
 * A closed set is the security boundary described in this module's header. Adding
 * a host here is a deliberate act that must come with a measurement showing it
 * answers the CN routes, not with a guess about the brand.
 */
const ALLOWED_CN_DOMAINS = [
  'copilot.tencent.com',
  'tencentbuddy.com',
  'workbuddy.cn',
  'codebuddy.cn',
] as const

/**
 * Whether `hostname` belongs to one of the CN brands above.
 *
 * Matched on the registrable domain (`host === domain` or `host.endsWith('.' +
 * domain)`), so `wb.tencentbuddy.com` and `copilot.internal.tencentbuddy.com`
 * both qualify while `tencentbuddy.com.evil.example` does not.
 */
export function isKnownCnHost(hostname: string): boolean {
  const lowered = hostname.trim().toLowerCase()
  if (lowered === '') return false
  return ALLOWED_CN_DOMAINS.some(domain => lowered === domain || lowered.endsWith(`.${domain}`))
}

/** Why a configured value was rejected, for the caller to word. */
export type CnGatewayRejection =
  /** Not parseable as an absolute http(s) URL. */
  | 'malformed'
  /** Parsed, but the scheme is not https. */
  | 'insecure'
  /** A well-formed https URL whose host is not one of this module's domains. */
  | 'unknown-host'

export type CnGatewayResolution =
  | {
    ok: true
    /** Base URL with no trailing slash, e.g. `https://wb.tencentbuddy.com`. */
    base: string
    /** The host that was accepted, for display. */
    host: string
    /** Whether this came from the override rather than the default. */
    overridden: boolean
  }
  | { ok: false; reason: CnGatewayRejection; /** The raw value, echoed for the message. */ value: string }

/**
 * Resolve the CN gateway base from an optional user-supplied value.
 *
 * An ABSENT or blank value is the normal case and yields the default with
 * `overridden: false`. A non-blank value must pass every check or the caller
 * gets `ok: false` and is expected to say so rather than silently falling back:
 * a user who typed a host and got the default anyway has no way to tell the
 * setting was ignored, and would keep debugging a network they already fixed.
 */
export function resolveCnGateway(value: string | undefined | null): CnGatewayResolution {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') {
    return { ok: true, base: CN_GATEWAY_DEFAULT, host: 'copilot.tencent.com', overridden: false }
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, reason: 'malformed', value: raw }
  }
  // https only. A plaintext base would put a Bearer token on the wire in clear
  // text, which is a worse outcome than the timeout this setting exists to fix —
  // and a corporate filter that resets TLS is exactly the environment where an
  // http fallback would look tempting.
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'insecure', value: raw }
  if (!isKnownCnHost(parsed.hostname)) return { ok: false, reason: 'unknown-host', value: raw }
  // Path, query and hash are dropped rather than preserved: every CN route is
  // appended to this base (`${base}/v2/chat/completions`), so a value carrying a
  // path would silently produce `.../some/path/v2/...` and 404 everywhere.
  return { ok: true, base: `https://${parsed.hostname.toLowerCase()}`, host: parsed.hostname.toLowerCase(), overridden: true }
}
