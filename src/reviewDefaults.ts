function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function withNull(v: unknown, key: string): unknown {
  if (!isObject(v) || v[key] !== undefined) return v;
  return { ...v, [key]: null };
}

/**
 * Fills the citation keys a review body does not carry, so it reads like a
 * review that did not ask for the check: `[]` for the lists, `null` for the
 * counts, `0` for `citation_issues`, `false` / `null` for the policy. Keys
 * the server sent are never touched. Returns a copy.
 */
export function withReviewDefaults<T>(body: T): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = { ...(body as Record<string, unknown>) };
  b["citation_issues"] ??= [];
  b["citation_failures"] ??= [];
  // Only the full view carries rows: `citations` sits beside `claims`.
  if (Array.isArray(b["claims"])) b["citations"] ??= [];
  // A row key the body does not carry reads as null.
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
    p["check_citations"] ??= false;
    if (p["max_citations"] === undefined) p["max_citations"] = null;
    b["policy"] = p;
  }
  return b as T;
}
