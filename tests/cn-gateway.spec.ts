// @vitest-environment node
/**
 * The CN gateway override (issue #220) — `src/cn-gateway.ts`.
 *
 * WHY AN ALLOWLIST AND NOT "ANY URL". The resolved base is prefixed onto every
 * CN request, each of which carries `Authorization: Bearer <token>`, plus the
 * refresh-token exchange. A free-form base therefore turns the settings file
 * into a credential-exfiltration primitive: whoever can edit it (a synced
 * profile, a shared dotfile, a "fix" pasted from a forum) redirects a live
 * WorkBuddy token to a host they control, and nothing looks broken — the
 * requests keep succeeding.
 *
 * So the tests below are not about string parsing. The load-bearing ones are the
 * lookalike cases: `tencentbuddy.com.evil.example` must be refused, and that is
 * exactly the shape a hand-rolled `endsWith('tencentbuddy.com')` check would
 * accept.
 */
import { describe, expect, it } from 'vitest'
import { CN_GATEWAY_DEFAULT, isKnownCnHost, resolveCnGateway } from '../src/cn-gateway.ts'

describe('an absent or blank value keeps the built-in gateway', () => {
  // The overwhelmingly common case, and it must be indistinguishable from the
  // behaviour before #220: every existing profile has no `cnBase` at all.
  for (const value of [undefined, null, '', '   ', '\n\t ']) {
    it(`treats ${JSON.stringify(value)} as "not configured"`, () => {
      const resolved = resolveCnGateway(value)
      expect(resolved.ok).toBe(true)
      if (!resolved.ok) return
      expect(resolved.base).toBe(CN_GATEWAY_DEFAULT)
      expect(resolved.overridden).toBe(false)
    })
  }
})

describe('the hosts the issue is about are accepted', () => {
  const accepted = [
    // What the desktop app's failover.json lists — the reported workaround.
    'https://wb.tencentbuddy.com',
    // The shipping default, spelled out explicitly.
    'https://copilot.tencent.com',
    // The two brand hosts the reporter measured as same-answering.
    'https://www.workbuddy.cn',
    'https://www.codebuddy.cn',
    // A subdomain of a brand domain is admitted by the registrable-domain rule,
    // e.g. the SAN entry on the certificate the reporter inspected.
    'https://copilot.internal.tencentbuddy.com',
  ]
  for (const value of accepted) {
    it(`accepts ${value}`, () => {
      const resolved = resolveCnGateway(value)
      expect(resolved.ok).toBe(true)
      if (!resolved.ok) return
      expect(resolved.base).toBe(value)
      expect(resolved.overridden).toBe(true)
    })
  }

  it('normalises the host to lower case', () => {
    const resolved = resolveCnGateway('https://WB.TencentBuddy.COM')
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.base).toBe('https://wb.tencentbuddy.com')
  })

  it('drops a trailing slash, so the route join cannot double it', () => {
    // Every call site is `${base}${path}` with `path` already starting with `/`.
    // Keeping the slash would produce `...//v2/chat/completions` on some
    // gateways that then 404 — a failure that looks like the override "not
    // working" rather than like a URL bug.
    const resolved = resolveCnGateway('https://wb.tencentbuddy.com/')
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.base).toBe('https://wb.tencentbuddy.com')
  })

  it('drops a path, which would otherwise be spliced into every route', () => {
    // `https://host/mirror` + `/v2/chat/completions` = `/mirror/v2/...`, which is
    // not a gateway route at all. Rejecting the whole value would be defensible,
    // but the host is what the user meant, so the path is dropped.
    const resolved = resolveCnGateway('https://wb.tencentbuddy.com/mirror')
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.base).toBe('https://wb.tencentbuddy.com')
  })
})

describe('everything else is refused, with a reason the card can word', () => {
  it('refuses a lookalike domain — the case a naive suffix check accepts', () => {
    // `tencentbuddy.com` appears in the string, so `includes`/loose `endsWith`
    // logic would admit it. The registrable-domain rule is what refuses it.
    for (const value of [
      'https://tencentbuddy.com.evil.example',
      'https://wb.tencentbuddy.com.evil.example',
      'https://evil-example.com/?h=wb.tencentbuddy.com',
      'https://copilot.tencent.com.evil.example',
    ]) {
      const resolved = resolveCnGateway(value)
      expect(resolved.ok, `accepted ${value}`).toBe(false)
      if (resolved.ok) return
      expect(resolved.reason).toBe('unknown-host')
    }
  })

  it('refuses plaintext http, because the token would travel in the clear', () => {
    const resolved = resolveCnGateway('http://wb.tencentbuddy.com')
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason).toBe('insecure')
  })

  it('refuses a value that is not an absolute URL', () => {
    for (const value of ['wb.tencentbuddy.com', 'tencentbuddy', '://x', 'https://']) {
      const resolved = resolveCnGateway(value)
      expect(resolved.ok, `accepted ${value}`).toBe(false)
      if (resolved.ok) return
      // `https://` alone parses in some engines and not others; either way it is
      // not a usable base, and both rejections are worded as "not a full URL".
      expect(['malformed', 'unknown-host']).toContain(resolved.reason)
    }
  })

  it('refuses a non-http scheme', () => {
    for (const value of ['ftp://wb.tencentbuddy.com', 'file:///etc/passwd', 'ws://wb.tencentbuddy.com']) {
      const resolved = resolveCnGateway(value)
      expect(resolved.ok, `accepted ${value}`).toBe(false)
    }
  })

  it('refuses a credential-bearing URL, which would leak the token in a log', () => {
    // `https://user:pass@host` parses fine and the host IS allowed — but the
    // userinfo segment ends up in error messages and logs. The base is rebuilt
    // from the hostname alone, so the credentials are dropped rather than sent.
    const resolved = resolveCnGateway('https://user:secret@wb.tencentbuddy.com')
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.base).toBe('https://wb.tencentbuddy.com')
    expect(resolved.base).not.toContain('secret')
  })

  it('echoes the raw value on rejection, so the message can quote it', () => {
    const resolved = resolveCnGateway('  https://evil.example  ')
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.value).toBe('https://evil.example')
  })
})

describe('isKnownCnHost matches registrable domains, not substrings', () => {
  it('accepts a bare domain and any subdomain', () => {
    for (const host of ['tencentbuddy.com', 'wb.tencentbuddy.com', 'a.b.tencentbuddy.com', 'workbuddy.cn']) {
      expect(isKnownCnHost(host), host).toBe(true)
    }
  })

  it('refuses a domain that merely contains an allowed name', () => {
    for (const host of ['tencentbuddy.com.evil.example', 'nottencentbuddy.com', 'evil.workbuddy.cn.example']) {
      expect(isKnownCnHost(host), host).toBe(false)
    }
  })

  it('refuses the empty host', () => {
    expect(isKnownCnHost('')).toBe(false)
    expect(isKnownCnHost('   ')).toBe(false)
  })
})
