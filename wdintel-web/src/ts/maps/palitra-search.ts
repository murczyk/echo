/**
 * Palitra point search: strict match by default, * for prefix/suffix/contains.
 * Aligned with LabelPattern in wdintel-rs palitra/bl.rs.
 * - "40" → exact (only label "40")
 * - "40*" → prefix (40, 400, 401, ...)
 * - "*40" → suffix (40, 540, 840, ...)
 * - "*40*" → contains (label contains "40")
 */

export type SearchTerm =
  | { kind: 'exact'; value: string }
  | { kind: 'prefix'; value: string }
  | { kind: 'suffix'; value: string }
  | { kind: 'contains'; value: string };

export function parseSearchTerm(token: string): SearchTerm {
  const lower = token.toLowerCase();
  const hasPrefixStar = lower.startsWith('*');
  const hasSuffixStar = lower.endsWith('*');
  const trimmed = lower.replace(/^\*+/, '').replace(/\*+$/, '').trim();

  if (hasPrefixStar && hasSuffixStar) {
    return trimmed.length > 0
      ? { kind: 'contains', value: trimmed }
      : { kind: 'exact', value: lower };
  }
  if (hasPrefixStar && trimmed.length > 0) {
    return { kind: 'suffix', value: trimmed };
  }
  if (hasSuffixStar && trimmed.length > 0) {
    return { kind: 'prefix', value: trimmed };
  }
  return { kind: 'exact', value: lower };
}

/**
 * Parse full query into search terms (split by comma, then parse each token).
 */
export function parseSearchQuery(query: string): SearchTerm[] {
  const tokens = query
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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
    case 'contains':
      return label.includes(term.value);
  }
}

/** Encode term for backend API: exact "40", prefix "40*", suffix "*40", contains "*40*". */
export function termToApiString(term: SearchTerm): string {
  switch (term.kind) {
    case 'exact':
      return term.value;
    case 'prefix':
      return term.value + '*';
    case 'suffix':
      return '*' + term.value;
    case 'contains':
      return '*' + term.value + '*';
  }
}
