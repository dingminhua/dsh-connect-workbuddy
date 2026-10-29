/**
 * Opportunistic pruning of the generated-media temp directories (issue #174).
 *
 * ## The defect this exists for
 *
 * `writeTempImage` (`src/image-tool.ts`, `%TEMP%\workbuddy-image-gen\`) and the
 * video downloader (`src/upstream.ts`, `%TEMP%\workbuddy-video-gen\`) both did
 * `mkdir` + `writeFile` and nothing else. Nothing in the plugin ever removed
 * one, so every generated image and every downloaded video stayed on disk
 * forever — a directory that grows by one multi-megabyte file per use, with no
 * UI that mentions it and no cleanup on upgrade or uninstall.
 *
 * ## Why pruning is triggered by a WRITE, not by startup
 *
 * The plugin can live for days inside a host nobody restarts, which is exactly
 * when the directory grows. A startup-only sweep would therefore run during the
 * one period when nothing is being generated and never during the period that
 * matters. Attaching it to the write that CREATED a new file keeps the bound
 * honest: the directory is pruned every time it is about to grow.
 *
 * ## Why every failure is swallowed
 *
 * This is housekeeping, not a feature. A read-only directory, a file held open
 * by another process, a directory removed by a cleaner mid-scan — none of those
 * may turn a SUCCESSFUL image or video generation into an error, because the
 * caller already has a usable file (or bytes on disk) at that point. So the
 * whole routine is best-effort and returns a count for tests rather than
 * throwing.
 *
 * @module dsh-connect-workbuddy/temp-files
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** How many generated files each temp directory keeps, newest first. */
export const TEMP_MEDIA_KEEP = 20

/**
 * Delete the oldest files in `dir`, keeping the newest `keep`.
 *
 * Ordering is by mtime, not filename: the image name embeds an ISO timestamp
 * and the video name embeds one plus a URL tail, so neither sorts reliably as a
 * string once more than one generator writes into the directory.
 *
 * @returns how many files were removed (for tests and for callers that want to
 *   log a real number); `0` when the directory is absent, unreadable, small
 *   enough, or when every removal failed.
 */
export async function pruneTempDir(
  dir: string,
  keep: number = TEMP_MEDIA_KEEP,
  extensions: readonly string[] = ['.png', '.mp4'],
): Promise<number> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter(name => extensions.some(ext => name.endsWith(ext)))
  } catch {
    // Absent or unreadable: there is nothing to prune, and that is not an error.
    return 0
  }
  if (names.length <= keep) return 0
  const dated = await Promise.all(names.map(async name => {
    const path = join(dir, name)
    try {
      return { path, mtimeMs: (await stat(path)).mtimeMs }
    } catch {
      // Vanished between readdir and stat, or never statable: treat as oldest so
      // it is the first candidate for removal.
      return { path, mtimeMs: 0 }
    }
  }))
  dated.sort((a, b) => b.mtimeMs - a.mtimeMs)
  let removed = 0
  for (const entry of dated.slice(Math.max(0, keep))) {
    try {
      await rm(entry.path, { force: true })
      removed += 1
    } catch {
      // Held open, or permission: leave it for the next write to retry.
    }
  }
  return removed
}
