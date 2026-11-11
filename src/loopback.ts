/**
 * Who is allowed to talk to the plugin's own HTTP surfaces.
 *
 * There are two distinct questions and they stop two different attacks, so both
 * live here rather than being re-derived per route. A previous version kept the
 * Host check inside `shim.ts` and only the Origin check inside `web-status.ts`,
 * which meant the shim's chat route had both guards while the settings card's
 * routes had one — the asymmetry was invisible because each file looked
 * internally consistent.
 *
 * - **Host** answers "is this request addressed to the interface it landed on?".
 *   A DNS-rebinding page sends requests whose `Host` is the *attacker's* domain
 *   (that is the whole trick: the browser resolves the attacker name to
 *   127.0.0.1), so requiring the Host to match the arrival interface drops it.
 *   This is the guard an Origin-only check does **not** provide.
 * - **Origin** answers "did a page on a foreign origin cause this?". A
 *   non-browser client sends no `Origin` at all and must pass, or the plugin's
 *   own `fetch` calls would be refused.
 *
 * Neither is authentication: any local process can forge both headers. They are
 * the minimum for these surfaces, not a substitute for a secret when a route
 * spends credit.
 *
 * ## Two callers, two strictnesses (deliberate)
 *
 * - `src/web-status.ts` serves the settings card over the HOST's webserver, which
 *   the harness may configure to bind a concrete non-loopback address. It uses
 *   `hostMatchesListener` / `originIsLoopback(origin, localAddress)`, i.e. "is
 *   this addressed to / coming from the interface the connection landed on".
 * - `src/shim.ts` binds `listen(0, '127.0.0.1')` itself, so no LAN request can
 *   ever reach it. It uses the stricter `hostIsLoopback`, which is not a
 *   different notion of "local" but the same one narrowed to the only case that
 *   can occur.
 *
 * Keep that in mind before "unifying" the two: the strict form is not a bug in
 * the shim, and the loose form is not laxness in the card.
 *
 * @module dsh-connect-workbuddy/loopback
 */

/**
 * Hostnames that count as this machine without comparing against a bind address.
 *
 * `localhost` is here because it names this machine by definition. The IPv4
 * entries cover the loopback /8 rather than the single address 127.0.0.1: the
 * host harness itself treats the whole 127/8 as loopback (its own
 * `isLoopbackHostname` accepts it, and 127.0.0.2 is a usable second loopback
 * address on Linux), so refusing 127.0.0.2 here would reject a request the
 * host considers local.
 */
import { isIP } from 'node:net'

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '[::1]'])

/**
 * Whether a string is a bare IP literal (IPv4 dotted quad, or IPv6 with or
 * without the brackets a Host header puts around it).
 *
 * Deliberately narrow: this decides whether a value is an ADDRESS that may be
 * compared with a Host header, so it must reject hostnames and host:port forms.
 * A loose "looks like hex" check would label `[deadbeef]` an address, and while
 * that cannot open the gate on its own (both sides must still be equal), a
 * predicate that answers "yes" to a non-address erodes the property the check is
 * supposed to have. `node:net`'s own parser is the authority for IPv6.
 */
function isIpLiteral(value: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)) {
    return value.split('.').every(part => Number(part) <= 255 && !(part.length > 1 && part.startsWith('0')))
  }
  const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  // `isIP` returns 6 only for a complete IPv6 literal; `[abc]` and `[deadbeef]`
  // are rejected, which is the point.
  return isIP(inner) === 6
}

/** Whether a bare hostname is inside IPv4 loopback space (127.0.0.0/8). */
function isIpv4Loopback(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname)
  if (match === null) return false
  const octets = match.slice(1, 5).map(part => Number(part))
  if (octets.some(octet => octet > 255)) return false
  // No leading-zero forms: `0177.0.0.1` is octal to some resolvers and decimal
  // to none of the browsers, so accepting it would widen the check for a shape
  // no client sends.
  if (match.slice(1, 5).some(part => part.length > 1 && part.startsWith('0'))) return false
  return octets[0] === 127
}

/**
 * Strip the optional `:port` from a Host header value, IPv6-bracket aware.
 *
 * The bracketed form is returned WITH brackets, because {@link LOOPBACK_HOSTS}
 * stores it that way and the two must agree.
 *
 * A `]` that is not at the end of the value (or followed only by `:<digits>`)
 * makes the whole thing unparseable, and unparseable returns the input
 * unchanged so no caller can mistake it for a loopback name. That matters: a
 * naive `slice(0, end + 1)` turns `[::1]evil.example` into `[::1]` and reads a
 * foreign host as this machine. Browsers never send such a value, but this
 * function is a security boundary, so "never" is the wrong bet.
 */
export function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    if (end === -1) return hostname
    const after = hostname.slice(end + 1)
    // Everything after the bracket must be absent or a numeric port; anything
    // else is not a shape any real client sends.
    if (after !== '' && !/^:\d+$/.test(after)) return hostname
    return hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

/**
 * Whether a Host header names the loopback interface.
 *
 * An absent Host is treated as NOT loopback. HTTP/1.1 requires the header, so
 * its absence is either a malformed request or an attempt to dodge the check —
 * neither deserves the benefit of the doubt on a surface that can spend credit.
 */
export function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return isLocalHostname(hostnameOfHost(host))
}

/**
 * Whether a parsed hostname names this machine.
 *
 * The single definition both predicates use, so the Host and Origin paths cannot
 * disagree about what "local" means — they did before (`127.0.0.2` and a trailing
 * dot were treated differently by each), which is exactly the kind of split this
 * module exists to prevent.
 */
function isLocalHostname(hostname: string): boolean {
  // A single trailing dot is the DNS spelling of "this name is absolute"
  // (`localhost.`). Browsers preserve it in both Host and Origin, so dropping it
  // here is what makes the two paths agree — they disagreed before, judging the
  // same string differently depending on which header carried it.
  const name = hostname.endsWith('.') && !hostname.endsWith('..') ? hostname.slice(0, -1) : hostname
  return LOOPBACK_HOSTS.has(name) || name === '::1' || isIpv4Loopback(name)
}

/**
 * Whether a Host header names the address this connection actually arrived on.
 *
 * This is the guard the routes use, and "must be loopback" is the wrong question.
 * The host harness does NOT allow wildcard binds in the version this plugin runs
 * against (0.2.x rejects `0.0.0.0` outright: "bind one concrete IPv4 or IPv6
 * address of a local interface instead"), but it DOES allow binding one concrete
 * local address — including a LAN address. A user who binds their LAN IP and
 * opens the GUI at `http://192.168.1.5:3000` sends exactly that in Host, and the
 * harness itself considers such a request trusted (its own trust layer accepts
 * "the listener's bind IP literal on any port"). A loopback-only check would 403
 * that user's read routes while the rest of the harness works, which is a real
 * regression for a supported configuration.
 *
 * So the question is "was this request addressed to the socket it landed on?".
 * `localAddress` answers that: it is the interface the CONNECTION was accepted
 * on, not the bind literal. Comparing the two drops a rebinding request — whose
 * Host is the attacker's domain while the socket landed on 127.0.0.1 or a LAN
 * address — while accepting every genuine one, loopback or LAN.
 *
 * The local branch is not merely an optimisation: a loopback-bound listener
 * reports `127.0.0.1` from `localAddress`, so the comparison alone would accept
 * `Host: 127.0.0.1` anyway. It is stated first so the answer does not depend on
 * how the platform spells its own loopback, and so an undefined `localAddress`
 * (a proxy, a test double) still admits genuine local traffic.
 */
export function hostMatchesListener(
  host: string | undefined,
  localAddress: string | undefined,
): boolean {
  if (host === undefined || host.trim() === '') return false
  const hostname = hostnameOfHost(host)
  if (isLocalHostname(hostname)) return true
  // `0.0.0.0` / `::` are bind wildcards, never an address a client legitimately
  // puts in Host, and they would otherwise match a `localAddress` of the same
  // literal. Excluding them explicitly keeps the comparison from depending on
  // the platform never reporting a wildcard.
  if (hostname === '0.0.0.0' || hostname === '[::]') return false
  if (localAddress === undefined || localAddress.trim() === '') return false
  const local = localAddress.trim().toLowerCase()
  // The comparison is only meaningful between two ADDRESSES. `localAddress` comes
  // from the socket and is always an IP literal in production, but treating it as
  // a trusted string would make this function accept any hostname that happened
  // to equal it — so a caller that ever passed a name through (a test double, a
  // future proxy header) would silently widen the gate to "any name that matches
  // whatever I was told". Requiring the right-hand side to parse as an IP
  // literal keeps the answer a statement about addresses, not about strings.
  if (!isIpLiteral(local) && !isIpLiteral(`[${local}]`)) return false
  // Brackets are an IPv6 spelling, so they are only stripped when what is inside
  // really is IPv6. Without that guard `[192.168.1.5]` would compare equal to
  // `192.168.1.5` — no browser sends a bracketed IPv4 Host, but the invariant is
  // worth keeping.
  const bare = (value: string): string =>
    value.startsWith('[') && value.endsWith(']') && isIP(value.slice(1, -1)) === 6
      ? value.slice(1, -1)
      : value
  // A Host header spells IPv6 in brackets while `localAddress` does not, so both
  // spellings of the same address must compare equal.
  return bare(hostname) === bare(local)
}

/**
 * Whether a browser-sent Origin may drive this route.
 *
 * An ABSENT Origin passes: that is the shape of a non-browser client (the
 * plugin's own fetch, a curl, the tests), and refusing it would break the
 * plugin's own calls.
 *
 * A PRESENT Origin must name this machine — judged by the SAME rule as the Host
 * header, which is why this takes `localAddress` too. Leaving it loopback-only
 * while Host accepted any local interface was a real split: a LAN browser's
 * same-origin POST carries `Origin: http://192.168.1.5:3000`, so the Host gate
 * admitted it and this one then refused all ten write routes. The two predicates
 * use one definition now (see `isLocalHostname`), because a browser reaching the
 * server on its LAN address is exactly as legitimate as one reaching it on
 * loopback — the harness trusts the bind literal on any port either way.
 *
 * The comparison is over the HOSTNAME only. `localAddress` carries no port, and
 * the route's own port is what a same-origin page must already be using, so a
 * port comparison here would add nothing: a page on the same host but another
 * port is not a threat this gate is meant to stop (it would need code already
 * running on this machine), and treating it as one would break legitimate
 * setups behind a proxy that terminates on a different port than it forwards to.
 * That intentional limit is recorded rather than silently assumed.
 */
export function originIsLoopback(
  origin: string | undefined,
  localAddress?: string | undefined,
): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    // `new URL` canonicalizes for us: `http://[0:0:0:0:0:0:0:1]/` arrives as
    // `[::1]`, and a trailing dot is preserved (so `http://127.0.0.1./` stays
    // distinct and is judged by the same rule as the Host path).
    const { hostname } = new URL(origin)
    if (isLocalHostname(hostname)) return true
    // Same comparison the Host path makes: a present Origin naming the interface
    // this connection arrived on is a genuine same-origin request.
    return hostMatchesListener(hostname, localAddress)
  } catch {
    return false
  }
}
