import { describe, expect, it } from 'vitest'
import { assertTrustedAuthority, hostIsLoopback, hostMatchesListener, hostnameOfHost, LOOPBACK_HOSTS, originIsLoopback } from '../src/loopback.ts'

/**
 * The gate both HTTP surfaces share.
 *
 * These are unit tests rather than route tests because the decisions are made
 * here and only *reported* by the routes: a bug in `hostnameOfHost` shows up as
 * "one route accepted a rebinding request", which is nearly impossible to
 * diagnose from the route level. `tests/web-status.spec.ts` covers that the
 * routes actually call it; this file covers what it answers.
 */

describe('hostnameOfHost', () => {
  it('strips a numeric port', () => {
    expect(hostnameOfHost('127.0.0.1:62283')).toBe('127.0.0.1')
    expect(hostnameOfHost('localhost:80')).toBe('localhost')
  })

  it('keeps the brackets on an IPv6 host, because the set stores them that way', () => {
    // `[::1]:62283` must reduce to `[::1]`, not `::1` — `LOOPBACK_HOSTS` holds
    // the bracketed form, so a stripper that returned the bare address would
    // report every IPv6 loopback request as foreign.
    expect(hostnameOfHost('[::1]:62283')).toBe('[::1]')
    expect(hostnameOfHost('[::1]')).toBe('[::1]')
  })

  it('lowercases and trims, so a case-mangled Host still matches', () => {
    expect(hostnameOfHost('  127.0.0.1:62283  ')).toBe('127.0.0.1')
    expect(hostnameOfHost('LOCALHOST:62283')).toBe('localhost')
  })

  it('leaves a non-numeric suffix alone rather than truncating at the colon', () => {
    // A hostname containing a colon that is NOT a port: truncating blindly would
    // turn an attacker's `evil:example` into `evil` and — worse — could turn a
    // near-miss into a loopback name.
    expect(hostnameOfHost('evil.example:notaport')).toBe('evil.example:notaport')
  })

  it('handles an unterminated IPv6 bracket without throwing', () => {
    expect(hostnameOfHost('[::1')).toBe('[::1')
  })

  it('refuses to read a bracketed loopback prefix followed by junk as loopback', () => {
    // Found while writing this file: a naive `slice(0, end + 1)` turns
    // `[::1]evil.example` into `[::1]`, i.e. it reports a FOREIGN host as this
    // machine. Browsers never send such a Host, but this is a security boundary,
    // so the parser must fail closed rather than salvage a prefix.
    for (const host of ['[::1]evil.example', '[::1]evil.example:62283', '[::1]@evil', '[::1].evil.com']) {
      expect(hostIsLoopback(host), host).toBe(false)
    }
  })

  it('still accepts a bracket followed by a real port', () => {
    expect(hostIsLoopback('[::1]:62283')).toBe(true)
    expect(hostnameOfHost('[::1]:62283')).toBe('[::1]')
  })
})

describe('hostIsLoopback', () => {
  it('accepts every spelling of this machine', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]', '127.0.0.1:62283', 'localhost:62283', '[::1]:62283']) {
      expect(hostIsLoopback(host), host).toBe(true)
    }
  })

  it('accepts the whole IPv4 loopback /8, not just .0.1', () => {
    // The host harness treats all of 127/8 as loopback and 127.0.0.2 is a real
    // second loopback address on Unix. Rejecting it here would refuse a request
    // the host itself considers local.
    for (const host of ['127.0.0.2:3000', '127.1.2.3:3000', '127.255.255.254']) {
      expect(hostIsLoopback(host), host).toBe(true)
    }
  })

  it('refuses octal-looking and out-of-range IPv4 forms', () => {
    // `0177.0.0.1` is octal to some resolvers; accepting it would widen the
    // check for a shape no browser sends.
    expect(hostIsLoopback('0177.0.0.1:3000')).toBe(false)
    expect(hostIsLoopback('127.0.0.256:3000')).toBe(false)
    expect(hostIsLoopback('2130706433')).toBe(false)
  })

  it('treats a single trailing dot as the same name', () => {
    // `localhost.` is the absolute-DNS spelling. Both Host and Origin carry it
    // verbatim, so both paths must agree about it.
    expect(hostIsLoopback('127.0.0.1.:3000')).toBe(true)
    expect(hostIsLoopback('localhost.:3000')).toBe(true)
    expect(hostIsLoopback('evil.example.:3000')).toBe(false)
    expect(originIsLoopback('http://127.0.0.1.:3000')).toBe(true)
    expect(originIsLoopback('http://localhost.')).toBe(true)
    expect(originIsLoopback('http://evil.example.')).toBe(false)
  })

  it('refuses a foreign host, which is the DNS-rebinding case', () => {
    // The attack page is served from the attacker's domain and the browser sends
    // that domain in Host; the socket still lands on 127.0.0.1. This is the
    // header the Origin-only check never looked at.
    for (const host of ['evil.example.com', 'evil.example.com:62283', '127.0.0.1.evil.example']) {
      expect(hostIsLoopback(host), host).toBe(false)
    }
  })

  it('refuses 0.0.0.0 and the container name, which are not loopback addresses', () => {
    // `0.0.0.0` in a Host header means "whatever this box is", not "this box".
    expect(hostIsLoopback('0.0.0.0:62283')).toBe(false)
    expect(hostIsLoopback('host.docker.internal:62283')).toBe(false)
  })

  it('refuses a MISSING or blank Host rather than defaulting to trusted', () => {
    // The deliberate direction: HTTP/1.1 requires the header, so its absence is
    // either malformed or an attempt to slip past the check. Treating "absent"
    // as trusted would make the guard removable by deleting a header.
    expect(hostIsLoopback(undefined)).toBe(false)
    expect(hostIsLoopback('')).toBe(false)
    expect(hostIsLoopback('   ')).toBe(false)
  })
})

describe('originIsLoopback', () => {
  it('passes an ABSENT Origin, because that is a non-browser client', () => {
    // The opposite direction from Host, and deliberately so: the plugin's own
    // fetch calls and curl send no Origin, and refusing them would break the
    // plugin's own traffic.
    expect(originIsLoopback(undefined)).toBe(true)
    expect(originIsLoopback('')).toBe(true)
  })

  it('accepts a loopback origin, in each spelling', () => {
    for (const origin of ['http://127.0.0.1:62283', 'http://localhost', 'http://[::1]:62283']) {
      expect(originIsLoopback(origin), origin).toBe(true)
    }
  })

  it('accepts a LAN origin when the connection arrived on that interface', () => {
    // A real browser on the LAN sends `Origin: http://192.168.1.5:3000` with every
    // same-origin POST. Refusing it while the Host gate admitted the request was
    // the split that made all ten write routes 403 for such a deployment.
    expect(originIsLoopback('http://192.168.1.5:3000', '192.168.1.5')).toBe(true)
    // Port is irrelevant to the comparison: Origin always carries the page port,
    // localAddress never does.
    expect(originIsLoopback('http://192.168.1.5:8080', '192.168.1.5')).toBe(true)
    // A DIFFERENT interface is still foreign.
    expect(originIsLoopback('http://192.168.1.6:3000', '192.168.1.5')).toBe(false)
    // And a hostname is never accepted as an arrival address.
    expect(originIsLoopback('http://evil.example', 'evil.example')).toBe(false)
  })

  it('still refuses a foreign origin when no localAddress is known', () => {
    // Same behaviour as before this change: without an arrival interface, only
    // loopback is trusted.
    expect(originIsLoopback('http://192.168.1.5:3000')).toBe(false)
    expect(originIsLoopback('http://127.0.0.1:3000')).toBe(true)
  })

  it('refuses a foreign origin and an unparseable one', () => {
    expect(originIsLoopback('https://evil.example.com')).toBe(false)
    expect(originIsLoopback('not a url')).toBe(false)
    expect(originIsLoopback('null')).toBe(false)
  })

  it('does not confuse a lookalike hostname with loopback', () => {
    // `127.0.0.1.evil.example` parses fine and its hostname is the attacker's —
    // a suffix test would have accepted it.
    expect(originIsLoopback('http://127.0.0.1.evil.example')).toBe(false)
  })
})

describe('the shared host set', () => {
  it('stores the bracketed IPv6 form, which is what hostnameOfHost returns', () => {
    // The two functions are coupled by this string form; if either side changed
    // shape the IPv6 case would silently break.
    expect(LOOPBACK_HOSTS.has(hostnameOfHost('[::1]:62283'))).toBe(true)
  })
})

/**
 * The guard the routes actually call.
 *
 * `hostIsLoopback` alone was the wrong question: the host webserver accepts
 * `host: '0.0.0.0'` (`@deepseek-ai/dsh-host-webserver` README calls it
 * "deliberate network exposure"), and a user who binds it opens the GUI at
 * `http://192.168.1.5:3000` — a request that legitimately carries that LAN
 * address in Host. `hostMatchesListener` accepts it by comparing against the
 * interface the CONNECTION arrived on, which is a fact rebinding cannot forge.
 */
describe('hostMatchesListener', () => {
  it('accepts a loopback Host even when the listener reports another address', () => {
    // The loopback branch stays first so a 127.0.0.1 request is never rejected
    // because of how the socket is classified.
    expect(hostMatchesListener('127.0.0.1:62283', '192.168.1.5')).toBe(true)
    expect(hostMatchesListener('localhost:62283', undefined)).toBe(true)
    expect(hostMatchesListener('[::1]:62283', '192.168.1.5')).toBe(true)
  })

  it('accepts the LAN address the connection actually arrived on (the 0.0.0.0 case)', () => {
    // Binding 0.0.0.0 then visiting via the LAN IP: the host is not loopback, but
    // it IS the interface the socket landed on, so this is a genuine request.
    expect(hostMatchesListener('192.168.1.5:3000', '192.168.1.5')).toBe(true)
    expect(hostMatchesListener('10.0.0.7', '10.0.0.7')).toBe(true)
  })

  it('REFUSES a forged Host that differs from the arrival interface (rebinding)', () => {
    // The attack: a page on evil.example resolves to 127.0.0.1, so the socket
    // lands on loopback while Host says the attacker's domain. Also covered for
    // the LAN variant, where the socket lands on a real interface.
    expect(hostMatchesListener('evil.example:62283', '127.0.0.1')).toBe(false)
    expect(hostMatchesListener('evil.example:3000', '192.168.1.5')).toBe(false)
    // A near-miss: right shape, wrong address.
    expect(hostMatchesListener('192.168.1.6:3000', '192.168.1.5')).toBe(false)
  })

  it('refuses a missing Host, and refuses the empty-interface case', () => {
    expect(hostMatchesListener(undefined, '127.0.0.1')).toBe(false)
    expect(hostMatchesListener('', '127.0.0.1')).toBe(false)
    // No localAddress to compare against: the loopback branch is the only way in,
    // so a non-loopback host must be refused rather than assumed good.
    expect(hostMatchesListener('192.168.1.5:3000', undefined)).toBe(false)
  })

  it('never accepts a HOSTNAME as the arrival address', () => {
    // `localAddress` comes from the socket and is always an IP literal in
    // production. Treating it as a trusted string would make this accept any
    // hostname that happened to equal it, so a caller that ever passed a name
    // through (a proxy header, a test double) would silently widen the gate.
    // Requiring the right-hand side to parse as an address keeps the answer a
    // statement about addresses.
    expect(hostMatchesListener('evil.example', 'evil.example')).toBe(false)
    expect(hostMatchesListener('EVIL.EXAMPLE', 'evil.example')).toBe(false)
    expect(hostMatchesListener('localhost', 'localhost')).toBe(true) // via the loopback branch, not the comparison
  })

  it('does not mistake a bracketed non-address for an IP literal', () => {
    // A loose "looks like hex" test labelled `[deadbeef]` and `[abc]` addresses.
    // It cannot open the gate alone (both sides must still be equal), but a
    // predicate that says "yes" to a non-address erodes the property the check
    // is meant to have, so the answer goes through node:net's parser.
    expect(hostMatchesListener('[deadbeef]', '[deadbeef]')).toBe(false)
    expect(hostMatchesListener('[abc]', '[abc]')).toBe(false)
    expect(hostMatchesListener('[evil.example]', '[evil.example]')).toBe(false)
    // A genuine IPv6 literal still compares equal in both spellings.
    expect(hostMatchesListener('[::ffff:127.0.0.1]', '[::ffff:127.0.0.1]')).toBe(true)
  })

  it('does not let a bracketed IPv4 match an unbracketed one', () => {
    // Brackets are an IPv6 spelling. `[192.168.1.5]` is not a value any browser
    // sends, but allowing it to compare equal would break the invariant and
    // quietly widen what counts as "the arrival address".
    expect(hostMatchesListener('[192.168.1.5]:3000', '192.168.1.5')).toBe(false)
    // The genuine IPv6 case still works.
    expect(hostMatchesListener('[fe80::1]:3000', 'fe80::1')).toBe(true)
    expect(hostMatchesListener('[::1]:3000', '[::1]')).toBe(true)
  })

  it('accepts a bracketed IPv6 arrival address, since that is how Host spells it', () => {
    expect(hostMatchesListener('[fe80::1]:3000', '[fe80::1]')).toBe(true)
    expect(hostMatchesListener('[fe80::1]:3000', 'fe80::1')).toBe(true)
  })

  it('does not treat 0.0.0.0 in Host as an arrival address', () => {
    // `0.0.0.0` in a Host header means "whatever this box is", not "this box",
    // and it never equals a real localAddress.
    expect(hostMatchesListener('0.0.0.0:3000', '0.0.0.0')).toBe(false)
  })
})

/**
 * Issue #261: a reverse proxy forwards `Host` unchanged while the harness's
 * webserver is bound to loopback. `req.socket.localAddress` is ALWAYS 127.0.0.1,
 * so `Host: <public authority>` can never equal it. The deployer-declared trust
 * list is the only way in, and it must drive BOTH halves: a request that gets
 * past the Host gate with `Origin: https://192.168.1.250:8443` must not then be
 * refused by an Origin gate that still compares a bare hostname.
 *
 * The socket in every case below is 127.0.0.1 — that is the whole deployment.
 */
describe('trustedHosts (issue #261, reverse proxy)', () => {
  const list = (...entries: string[]) => () => entries
  const PROXY_HOST = '192.168.1.250:8443'
  const PROXY_ORIGIN = 'https://192.168.1.250:8443'

  it('accepts a declared authority on BOTH halves when the socket lands on loopback', () => {
    const trusted = list(PROXY_HOST)
    expect(hostMatchesListener(PROXY_HOST, '127.0.0.1', trusted)).toBe(true)
    expect(originIsLoopback(PROXY_ORIGIN, '127.0.0.1', trusted)).toBe(true)
  })

  it('refuses the same request when the trust list is empty (pre-#261 fence)', () => {
    // Positive control for "a declared authority is what opens the gate": with
    // no list the answer must still be 403, or a test that always returns true
    // would pass every case above.
    expect(hostMatchesListener(PROXY_HOST, '127.0.0.1', list())).toBe(false)
    expect(originIsLoopback(PROXY_ORIGIN, '127.0.0.1', list())).toBe(false)
  })

  it('refuses an authority that is not the one declared', () => {
    const trusted = list('192.168.1.251:8443')
    expect(hostMatchesListener(PROXY_HOST, '127.0.0.1', trusted)).toBe(false)
    expect(originIsLoopback(PROXY_ORIGIN, '127.0.0.1', trusted)).toBe(false)
  })

  it('still refuses an attacker domain (rebinding) even with a trust list', () => {
    const trusted = list(PROXY_HOST)
    expect(hostMatchesListener('evil.example:8443', '127.0.0.1', trusted)).toBe(false)
    expect(originIsLoopback('https://evil.example:8443', '127.0.0.1', trusted)).toBe(false)
  })

  it('a port-less entry matches the hostname on any port', () => {
    const trusted = list('192.168.1.250')
    expect(hostMatchesListener(PROXY_HOST, '127.0.0.1', trusted)).toBe(true)
    expect(originIsLoopback(PROXY_ORIGIN, '127.0.0.1', trusted)).toBe(true)
    expect(hostMatchesListener('192.168.1.250:9443', '127.0.0.1', trusted)).toBe(true)
  })

  it('an explicit-port entry matches ONLY that authority', () => {
    const trusted = list(PROXY_HOST)
    expect(hostMatchesListener('192.168.1.250:9443', '127.0.0.1', trusted)).toBe(false)
  })

  it('normalizes case, IPv6 brackets and a scheme-default port on both halves', () => {
    // WHATWG strips :443 from an https Origin but keeps it when the same text is
    // parsed as a Host under http:. Both halves must still agree, so an entry
    // with an explicit default port must be parsed under the Origin's scheme.
    expect(hostMatchesListener('dsh.example.com:443', '127.0.0.1', list('dsh.example.com:443'))).toBe(true)
    expect(originIsLoopback('https://dsh.example.com:443', '127.0.0.1', list('dsh.example.com:443'))).toBe(true)
    expect(originIsLoopback('https://dsh.example.com', '127.0.0.1', list('dsh.example.com:443'))).toBe(true)
    expect(hostMatchesListener('DSH.EXAMPLE.COM:8443', '127.0.0.1', list('dsh.example.com:8443'))).toBe(true)
    expect(hostMatchesListener('[fe80::1]:8443', '127.0.0.1', list('[fe80::1]:8443'))).toBe(true)
  })

  it('a non-http(s) Origin cannot be trusted by the list', () => {
    expect(originIsLoopback('ftp://192.168.1.250:8443', '127.0.0.1', list(PROXY_HOST))).toBe(false)
  })

  it('keeps the existing loopback and wildcard rules in front of the trust list', () => {
    const trusted = list('0.0.0.0:3000', '[::]:3000')
    // A wildcard is never a legitimate Host, and a loopback Host passes without
    // any list — the trust list must not change either answer.
    expect(hostMatchesListener('0.0.0.0:3000', '127.0.0.1', trusted)).toBe(false)
    expect(hostMatchesListener('127.0.0.1:62283', '127.0.0.1', list())).toBe(true)
  })

  it('an absent getter leaves the pre-#261 answer', () => {
    expect(hostMatchesListener(PROXY_HOST, '127.0.0.1')).toBe(false)
    expect(originIsLoopback(PROXY_ORIGIN, '127.0.0.1')).toBe(false)
  })
})

describe('assertTrustedAuthority', () => {
  it('accepts canonical bare host[:port] authorities', () => {
    for (const entry of ['192.168.1.250', '192.168.1.250:8443', 'dsh.example.com', '[::1]:8443']) {
      expect(() => assertTrustedAuthority(entry), entry).not.toThrow()
    }
  })

  it('REFUSES a value that WHATWG would rewrite or that hides a hostname', () => {
    // A typo must fail the LOAD, not sit in the list granting a hostname prefix
    // (the harness's own assertTrustedAuthority has the same boundary).
    for (const entry of ['harness.internal/path', 'user@host', 'host :80', '0x7f.0.0.1', '']) {
      expect(() => assertTrustedAuthority(entry), entry).toThrow(/not a bare host\[:port\] authority/)
    }
  })
})
