export function normalizeCallsignLookupValue(value: string): string {
  return value.toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ').trim();
}

export function normalizeCallsignFilterValues(
  values: readonly string[] | null | undefined,
): string[] {
  return Array.from(
    new Set((values ?? []).map(normalizeCallsignLookupValue).filter((value) => value !== '')),
  );
}
