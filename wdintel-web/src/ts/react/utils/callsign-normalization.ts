export function normalizeCallsignLookupValue(value: string): string {
  return value.toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ').trim();
}
