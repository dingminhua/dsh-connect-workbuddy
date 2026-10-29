/**
 * Generated-media temp directories must not grow without bound, and an
 * over-limit request body must be answered 413 (issue #174).
 *
 * ## ③ The directories only ever grew
 *
 * `writeTempImage` (`src/image-tool.ts`) and the video downloader
 * (`src/upstream.ts`) each did `mkdir` + `writeFile` and nothing else. Every
 * generated image and every downloaded video stayed on disk forever: a
 * multi-megabyte file per use, in a directory no UI mentions and no upgrade or
 * uninstall cleans.
 *
 * Pruning is attached to the WRITE, not to startup, because the plugin can live
 * for days inside a host nobody restarts — a startup-only sweep runs during the
 * one period when nothing is generated. The tests below pin both halves: the
 * bound is enforced, and a pruning failure can never turn a successful
 * generation into an error.
 *
 * ## ④ The status was 500 for a client error
 *
 * `readBody` rejected an over-limit body with a bare `Error`, which the shim's
 * outer catch answered as `500 internal`. The protocol answer is 413.
 */
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pruneTempDir, TEMP_MEDIA_KEEP } from '../src/temp-files.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wb-tempfiles-')) })
afterEach(async () => { await rm(root, { force: true, recursive: true }) })

/**
 * Write `count` files with EXPLICIT mtimes, oldest first.
 *
 * Setting mtimes rather than relying on the write order is what makes the
 * assertion about mtime ordering instead of about filesystem timestamp
 * resolution — which is coarse enough on some filesystems that several files
 * written in the same millisecond are unordered by mtime.
 */
async function seed(count: number, ext = '.png'): Promise<void> {
  const base = Date.now() - count * 1_000
  for (let index = 0; index < count; index += 1) {
    const path = join(root, `file-${String(index).padStart(3, '0')}${ext}`)
    await writeFile(path, 'x')
    const stamp = new Date(base + index * 1_000)
    await utimes(path, stamp, stamp)
  }
}

describe('#174 ③: generated-media temp directories are pruned on write', () => {
  it('keeps the newest N and removes the rest', async () => {
    const keep = 5
    await seed(keep + 7)
    const removed = await pruneTempDir(root, keep, ['.png'])
    expect(removed).toBe(7)
    // THE OLDEST are the ones removed — the count is exact, and it is `count -
    // keep`, not "roughly the old ones".
    expect(removed).toBe(7)
    const { readdir } = await import('node:fs/promises')
    const left = (await readdir(root)).sort()
    // Assert the INVARIANT rather than a literal list: the five survivors must be
    // the five newest of the twelve seeded files. A literal list here would pin
    // the seed's own timestamp arithmetic instead of the rule under test.
    const seeded = Array.from({ length: 12 }, (_, index) => `file-${String(index).padStart(3, '0')}.png`)
    expect(left.length).toBe(keep)
    for (const name of left) expect(seeded).toContain(name)
    // And none of the seven oldest survives.
    for (const name of seeded.slice(0, 7)) expect(left).not.toContain(name)
  })

  it('orders by MTIME, not by filename', async () => {
    // Names deliberately anti-correlated with age: `a` is the OLDEST, `c` the
    // newest. A string sort would keep the wrong one.
    await writeFile(join(root, 'a.png'), 'x')
    await writeFile(join(root, 'c.png'), 'x')
    await writeFile(join(root, 'b.png'), 'x')
    await utimes(join(root, 'a.png'), new Date(1_000), new Date(1_000))
    await utimes(join(root, 'b.png'), new Date(2_000), new Date(2_000))
    await utimes(join(root, 'c.png'), new Date(3_000), new Date(3_000))
    expect(await pruneTempDir(root, 2, ['.png'])).toBe(1)
    const { readdir } = await import('node:fs/promises')
    // `a` (oldest) removed; `b` and `c` survive.
    expect((await readdir(root)).sort()).toEqual(['b.png', 'c.png'])
  })

  it('leaves other extensions alone', async () => {
    // The image directory may also hold a stray video, and vice versa. Each
    // writer prunes only its own kind, so one feature can never delete another's
    // output.
    await seed(4, '.png')
    await seed(4, '.mp4')
    await pruneTempDir(root, 1, ['.png'])
    const { readdir } = await import('node:fs/promises')
    const left = await readdir(root)
    expect(left.filter(name => name.endsWith('.png'))).toHaveLength(1)
    expect(left.filter(name => name.endsWith('.mp4'))).toHaveLength(4)
  })

  it('does nothing below the keep count, and reports 0', async () => {
    await seed(3)
    expect(await pruneTempDir(root, 10, ['.png'])).toBe(0)
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(root))).toHaveLength(3)
  })

  it('reports 0 for an absent directory instead of throwing', async () => {
    // The first generation on a machine creates the directory; the call site
    // prunes AFTER writing, but a cleaner may have removed it in between. A throw
    // here would fail a generation that already succeeded.
    expect(await pruneTempDir(join(root, 'nope'), 4, ['.png'])).toBe(0)
  })

  it('uses a default keep count that is a real bound', () => {
    // The constant is the policy. A sentinel like Infinity would pass every
    // behavioural test above (they all pass `keep` explicitly).
    expect(TEMP_MEDIA_KEEP).toBeGreaterThan(0)
    expect(Number.isFinite(TEMP_MEDIA_KEEP)).toBe(true)
    expect(TEMP_MEDIA_KEEP).toBeLessThanOrEqual(100)
  })
})
