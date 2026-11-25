/**
 * Sub-path-safe request URLs for the browser half (issue #314).
 *
 * The plugin's routes are registered on the HOST webserver as absolute paths
 * (`/plugins/dsh-connect-workbuddy/...`). When DSH is reached through a reverse
 * proxy that mounts it under a SUB-PATH — e.g. a NAS gateway serving the app at
 * `/app/dsh/` — `fetch('/plugins/...')` resolves against the SITE ROOT, drops
 * the mount prefix, and the proxy answers its own HTML page instead. The card
 * then does `response.json()` on `<!doctype html>` and shows
 * `Unexpected token '<'` at the login click.
 *
 * DSH itself solves this exact problem by resolving its own API paths against
 * `document.baseURI` (see the host's `stream-client.ts` / `socket.ts`:
 * `new URL(path.slice(1), document.baseURI)`). `document.baseURI` is the URL the
 * user actually loaded — `/` for a direct/desktop deployment, `/app/dsh/` under
 * the NAS gateway — so resolving relatively keeps the mount prefix WITHOUT any
 * configuration. This module applies the same rule to the plugin's fetch calls.
 *
 * SAFETY:
 * - Only origin-relative (`pathname + search`) is returned; the origin is never
 *   changed, so `credentials: 'same-origin'` keeps its meaning and no request
 *   can be redirected off-box by a hostile base.
 * - At `/` (direct `127.0.0.1:28000`) and under the desktop `dsh-app://app/`
 *   scheme the pathname is `/`, so the result is byte-for-byte the old URL.
 * - No `document` (Node tests / SSR) and unparseable input fall back to the
 *   logical path unchanged — the old behaviour — so nothing new can break.
 *
 * Kept out of `status-paths.ts`: that module is the node-free host/client bridge
 * and must not reference `document`. Call sites wrap the final URL instead.
 *
 * @module dsh-connect-workbuddy/client/request-url
 */

/**
 * Read `document.baseURI` without a hard DOM reference, so this module also
 * type-checks in the node-side tsconfig (which has no DOM lib). In Node there
 * is no `document`, so the fallback is `undefined` and `resolveRequestUrl`
 * returns the path unchanged — exactly the old behaviour.
 */
function defaultBase(): string | undefined {
  const doc = (globalThis as { document?: { baseURI?: string } }).document
  return doc?.baseURI
}

/**
 * Resolve a plugin-relative request path against the page's base URL.
 *
 * @param logical path (and optional query) beginning with `/plugins/...`
 * @param base document.baseURI, injected for testability
 */
export function resolveRequestUrl(
  logical: string,
  base: string | undefined = defaultBase(),
): string {
  if (base === undefined) return logical
  try {
    // Strip leading slashes exactly as the host's stream/socket clients do: a
    // relative URL against `/app/dsh/` yields `/app/dsh/plugins/...`; against
    // `/` it yields `/plugins/...` — unchanged.
    const url = new URL(logical.replace(/^\/+/u, ''), base)
    return `${url.pathname}${url.search}`
  } catch {
    // An unparseable base or path must not turn a working request into a crash.
    return logical
  }
}
