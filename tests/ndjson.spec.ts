/**
 * The NDJSON reader that makes per-account progress possible.
 *
 * Chunk boundaries are the whole reason this module exists rather than a
 * `split('\n')` at the call site: a stream delivers bytes, not lines, so a JSON
 * object routinely straddles two chunks. The multi-byte case matters too — these
 * payloads carry Chinese account names, and decoding chunk-wise without
 * `stream: true` mangles a character split across the boundary.
 *
 * @module dsh-connect-workbuddy/tests/ndjson
 */
import { describe, expect, it } from 'vitest'
import { readNdjson } from '../src/client/ndjson.ts'

/** A stream that emits exactly the given chunks, byte-wise. */
function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(chunks: readonly string[]): Promise<Record<string, unknown>[]> {
  const seen: Record<string, unknown>[] = []
  await readNdjson(streamOf(chunks), line => { seen.push(line) })
  return seen
}

describe('readNdjson', () => {
  it('reassembles an object split across two chunks', async () => {
    // The normal case on a real socket: the boundary lands mid-JSON.
    const seen = await collect(['{"accountId":"a","out', 'come":"ok"}\n'])
    expect(seen).toEqual([{ accountId: 'a', outcome: 'ok' }])
  })

  it('emits one object per line, in order', async () => {
    const seen = await collect(['{"n":1}\n{"n":2}\n{"n":3}\n'])
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('emits a final line that has no trailing newline', async () => {
    // A truncated stream is a normal way for one to end, and that last object is
    // still a real measurement the user should see.
    const seen = await collect(['{"n":1}\n{"n":2}'])
    expect(seen).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('skips a malformed line instead of discarding the rest', async () => {
    // Live progress: throwing here would throw away rows already delivered.
    const seen = await collect(['{"n":1}\nnot json\n{"n":3}\n'])
    expect(seen).toEqual([{ n: 1 }, { n: 3 }])
  })

  it('skips blank lines and JSON that is not an object', async () => {
    const seen = await collect(['\n\n{"n":1}\n42\n"text"\nnull\n'])
    expect(seen).toEqual([{ n: 1 }])
  })

  it('does not mangle a multi-byte character split across chunks', async () => {
    // Decoding each chunk independently would replace 老丁 with U+FFFD.
    const bytes = new TextEncoder().encode('{"accountName":"老丁"}\n')
    const cut = 18
    const seen: Record<string, unknown>[] = []
    await readNdjson(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut))
        controller.enqueue(bytes.slice(cut))
        controller.close()
      },
    }), line => { seen.push(line) })
    expect(seen).toEqual([{ accountName: '老丁' }])
  })

  it('reports nothing for a missing body rather than throwing', async () => {
    const seen: Record<string, unknown>[] = []
    await readNdjson(undefined, line => { seen.push(line) })
    await readNdjson(null, line => { seen.push(line) })
    expect(seen).toEqual([])
  })

  it('reports nothing for an empty stream', async () => {
    expect(await collect([])).toEqual([])
    expect(await collect(['\n'])).toEqual([])
  })
})
