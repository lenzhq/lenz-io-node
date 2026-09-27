/**
 * Fills the review body's citation keys when the server did not send them,
 * so a body from an API without the citation check reads like one from an
 * API with it and the check not asked for: `[]` for the lists, `null` for
 * the counts, `0` for `citation_issues`, `false` / `null` for the policy.
 * Keys the server sent are never touched. Returns a copy.
 */
export function withReviewDefaults<T>(body: T): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = { ...(body as Record<string, unknown>) };
  b["citation_issues"] ??= [];
  b["citation_failures"] ??= [];
  // Only the full view carries rows: `citations` sits beside `claims`.
  if (Array.isArray(b["claims"])) b["citations"] ??= [];
  const summary = b["summary"];
  if (summary && typeof summary === "object" && !Array.isArray(summary)) {
    const s = { ...(summary as Record<string, unknown>) };
    for (const key of [
      "citations_found",
      "citations_selected",
      "citation_limit",
      "citation_limit_reached",
      "citation_checks",
      "citations_skipped",
    ]) {
      if (s[key] === undefined) s[key] = null;
    }
    s["citation_issues"] ??= 0;
    b["summary"] = s;
  }
  const policy = b["policy"];
  if (policy && typeof policy === "object" && !Array.isArray(policy)) {
    const p = { ...(policy as Record<string, unknown>) };
    p["check_citations"] ??= false;
    if (p["max_citations"] === undefined) p["max_citations"] = null;
    b["policy"] = p;
  }
  return b as T;
}
