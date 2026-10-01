/**
 * Read a newline-delimited JSON body, one object at a time.
 *
 * NDJSON rather than SSE or a hand-rolled frame format because the pool's batch
 * is a list of INDEPENDENT results: one line per result needs no state machine,
 * survives a partially-delivered batch, and lets the reader act on account N
 * while account N+1 is still being tested.
 *
 * A malformed line is SKIPPED, not fatal. The stream carries live progress, so
 * discarding the rest of a batch because one frame did not parse would throw away
 * rows the user already watched arrive — and a truncated final line is a normal
 * way for a stream to end when something upstream misbehaves.
 *
 * @module dsh-connect-workbuddy/client/ndjson
 */

/** Hand each parsed object to `onLine`, in order, as it arrives. */
export async function readNdjson(
  body: ReadableStream<Uint8Array> | null | undefined,
  onLine: (line: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body?.getReader()
  // A missing body means there is nothing to report, not an error: the caller's
  // own status handling has already run by this point.
  if (reader === undefined) return
  const decoder = new TextDecoder()
  const emit = (line: string): void => {
    const trimmed = line.trim()
    if (trimmed === '') return
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null) onLine(parsed as Record<string, unknown>)
    } catch {
      // Skipped; see the module note.
    }
  }
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // `stream: true` so a multi-byte character split across two chunks is not
      // mangled — these payloads carry Chinese account names.
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // The last element is either an incomplete line or '' (the chunk ended on a
      // newline). Either way it belongs to the NEXT chunk.
      buffer = lines.pop() ?? ''
      for (const line of lines) emit(line)
    }
    // Flush: a well-formed stream ends with a newline, but a truncated one may
    // not, and that last line is still worth reporting.
    buffer += decoder.decode()
    emit(buffer)
  } finally {
    // The lock is released even when a read throws, so the caller can cancel the
    // body without tripping over a held reader.
    reader.releaseLock()
  }
}
