export function normalizeCallsignDisplay(value: string | null | undefined): string {
  return (value?.trim() ?? '').toUpperCase();
}
