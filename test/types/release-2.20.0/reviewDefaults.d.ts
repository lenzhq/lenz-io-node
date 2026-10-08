/**
 * The same for a citation check's body: `[]` for the three lists, `null` for
 * `more_citations`. Keys the server sent are never touched. Returns a copy.
 */
export declare function withCitecheckDefaults<T>(body: T): T;
/**
 * Fills the citation keys a review body does not carry, so it reads like a
 * review that checks no citation: `[]` for the lists, `null` for the counts,
 * `more_claims`, `more_citations` and `policy.max_citations`, `0` for
 * `citation_issues`. The claim positions an older body lacks
 * (`more_claim_locations`, each claim row's `positions`) read as `null`, and
 * so do the suggested edits (each claim row's and issue's `suggested_edits`;
 * `policy.suggest_edits` reads as `false`) and the quick check's rewrite
 * (each claim row's `assessment.suggested_rewrite`).
 * Keys the server sent are never touched. Returns a copy.
 */
export declare function withReviewDefaults<T>(body: T): T;
