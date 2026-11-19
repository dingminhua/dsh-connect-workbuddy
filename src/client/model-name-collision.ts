/**
 * Same-name model rows in one region's roster (issue #280).
 *
 * The international catalog ships a free row and a paid row under the SAME
 * upstream `name`. The picker used to show them as two identical lines apart
 * from the price suffix, so a user could not tell which one they had selected
 * when the personal-centre bill showed the other one. Both DSH surfaces (the
 * host's model picker through `WorkBuddyModelLabel`, and this plugin's card
 * table) must qualify those rows with their ids.
 *
 * DATA-DRIVEN, not a hardcoded id pair: any two rows sharing a name are
 * ambiguous. A fixed id list would age with the next vendor rename and miss
 * the next collision — the same trap issue #281 found in the channel table.
 *
 * Client-safe by construction: this module imports nothing from the host
 * bundle, so it can be used from both client components without pulling
 * `src/adapter.ts` into the browser build.
 */

/** The two fields a row must carry to be checked for a name collision. */
export interface NameCollisionRow {
  id: string
  name: string
}

/**
 * Ids that share their `name` with a DIFFERENT id in `rows`.
 *
 * A single row with a name is never ambiguous even if it appears twice in the
 * input with the same id (that would be a duplicate row, not two models).
 */
export function ambiguousNameIds(rows: readonly NameCollisionRow[]): ReadonlySet<string> {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
  const ambiguous = new Set<string>()
  for (const row of rows) {
    if ((counts.get(row.name) ?? 0) > 1) ambiguous.add(row.id)
  }
  return ambiguous
}

/** Append the model id to a name that collides with another row. */
export function qualifyName(
  name: string,
  id: string,
  ambiguousIds: ReadonlySet<string> | undefined,
): string {
  return ambiguousIds?.has(id) === true ? `${name} (${id})` : name
}
