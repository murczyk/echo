const MAX_ROWS = 5000;
const MAX_COLUMNS = 100;

export function previewXlsxRows(rawRows: unknown[][]) {
  const rowCount = rawRows.length;
  const rawColumnCount = rawRows.reduce((max, row) => Math.max(max, row.length), 0);
  const rows = rawRows.slice(0, MAX_ROWS).map((row) => row.slice(0, MAX_COLUMNS).map(normalizeCellValue));

  return {
    rows,
    rowCount,
    columnCount: rawColumnCount,
    truncated: rowCount > MAX_ROWS || rawColumnCount > MAX_COLUMNS,
  };
}

function normalizeCellValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
