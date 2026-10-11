/**
 * Small readers for a deep check's verdict. They need no crypto, so the
 * browser entry exports them too.
 */

/**
 * `true` when the deep check completed with `verdict: "No Public Record"`:
 * no public record would show this claim, so the sources found do not settle it.
 * Such a check has no `lenz_score`. Accepts a verification, a list item or a
 * review row's `verification` (anything with a `verdict`).
 */
export function isNoPublicRecord(v: { verdict?: string | null } | null | undefined): boolean {
  return v?.verdict === "No Public Record";
}

/**
 * `true` when the check carries a `lenz_score` (an integer from 1 to 10), and
 * narrows it to a number. A check that is `"No Public Record"` has none, and
 * neither has a quick check: read the score through this rather than
 * assuming it is there.
 */
export function hasScore<T extends { lenz_score?: number | null }>(
  v: T | null | undefined,
): v is T & { lenz_score: number } {
  return typeof v?.lenz_score === "number";
}
