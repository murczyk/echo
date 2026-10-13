export function normalizeMessageUnitName(name: string): string {
  return name.trim().replace(/\s+/gu, ' ').toLowerCase();
}
