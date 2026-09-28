/**
 * The same for a citation check's body: `[]` for the three lists, `null` for
 * `more_citations`. Keys the server sent are never touched. Returns a copy.
 */
export function withCitecheckDefaults<T>(body: T): T {
  if (!isObject(body)) return body;
  const b: Record<string, unknown> = { ...body };
  for (const key of ["citations", "citation_issues", "citation_failures"]) b[key] ??= [];
  if (b["more_citations"] === undefined) b["more_citations"] = null;
  return b as T;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function withNull(v: unknown, key: string): unknown {
  if (!isObject(v) || v[key] !== undefined) return v;
  return { ...v, [key]: null };
}

/**
 * Fills the citation keys a review body does not carry, so it reads like a
 * review that checks no citation: `[]` for the lists, `null` for the counts,
 * `more_claims`, `more_citations` and `policy.max_citations`, `0` for
 * `citation_issues`. The claim positions an older body lacks
 * (`more_claim_locations`, each claim row's `positions`) read as `null`.
 * Keys the server sent are never touched. Returns a copy.
 */
export function withReviewDefaults<T>(body: T): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = { ...(body as Record<string, unknown>) };
  b["citation_issues"] ??= [];
  b["citation_failures"] ??= [];
  // Only the full view carries rows: `citations` sits beside `claims`.
  if (Array.isArray(b["claims"])) b["citations"] ??= [];
  for (const key of ["more_claims", "more_claim_locations", "more_citations"]) {
    if (b[key] === undefined) b[key] = null;
  }
  // A row key the body does not carry reads as null.
  if (Array.isArray(b["claims"])) {
    b["claims"] = (b["claims"] as unknown[]).map((c) => withNull(c, "positions"));
  }
  if (Array.isArray(b["citation_issues"])) {
    b["citation_issues"] = (b["citation_issues"] as unknown[]).map((i) =>
      withNull(i, "missing_quote"),
    );
  }
  if (Array.isArray(b["citations"])) {
    b["citations"] = (b["citations"] as unknown[]).map((row) => {
      if (!isObject(row) || !isObject(row["check"])) return row;
      return { ...row, check: withNull(row["check"], "missing_quote") };
    });
  }
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
    if (p["max_citations"] === undefined) p["max_citations"] = null;
    b["policy"] = p;
  }
  return b as T;
}
