/**
 * Palitra point search: strict match by default, * for prefix/suffix.
 * - "40" → exact (only label "40")
 * - "40*" → prefix (40, 400, 401, ...)
 * - "*40" → suffix (40, 540, 840, ...)
 */

export type SearchTerm =
  | { kind: 'exact'; value: string }
  | { kind: 'prefix'; value: string }
  | { kind: 'suffix'; value: string };

export function parseSearchTerm(token: string): SearchTerm {
  const lower = token.toLowerCase();
  if (lower.startsWith('*') && lower.length > 1) {
    return { kind: 'suffix', value: lower.slice(1) };
  }
  if (lower.endsWith('*') && lower.length > 1) {
    return { kind: 'prefix', value: lower.slice(0, -1) };
  }
  return { kind: 'exact', value: lower };
}

/**
 * Parse full query into search terms (split by comma/space, then parse each token).
 */
export function parseSearchQuery(query: string): SearchTerm[] {
  const tokens = query.trim().split(/[,\s]+/).filter(Boolean);
  return tokens.map(parseSearchTerm);
}

export function labelMatchesTerm(label: string, term: SearchTerm): boolean {
  switch (term.kind) {
    case 'exact':
      return label === term.value;
    case 'prefix':
      return label.startsWith(term.value);
    case 'suffix':
      return label.endsWith(term.value);
  }
}

/** Encode term for backend API: exact "40", prefix "40*", suffix "*40". */
export function termToApiString(term: SearchTerm): string {
  switch (term.kind) {
    case 'exact':
      return term.value;
    case 'prefix':
      return term.value + '*';
    case 'suffix':
      return '*' + term.value;
  }
}
