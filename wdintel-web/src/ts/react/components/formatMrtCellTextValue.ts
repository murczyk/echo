export function formatMrtCellTextValue(value: string | null | undefined): string {
  const normalized = value?.trim() ?? '';
  return normalized === '' ? '—' : normalized;
}
