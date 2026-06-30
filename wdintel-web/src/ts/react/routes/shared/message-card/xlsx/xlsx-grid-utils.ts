export type XlsxGridRange = {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
};

export function normalizeXlsxRange(range: XlsxGridRange): XlsxGridRange {
  return {
    startRow: Math.min(range.startRow, range.endRow),
    endRow: Math.max(range.startRow, range.endRow),
    startColumn: Math.min(range.startColumn, range.endColumn),
    endColumn: Math.max(range.startColumn, range.endColumn),
  };
}

export function isCellInRange(row: number, column: number, range: XlsxGridRange | null): boolean {
  if (range == null) return false;
  return row >= range.startRow && row <= range.endRow && column >= range.startColumn && column <= range.endColumn;
}

export function columnLabel(index: number): string {
  let value = index + 1;
  let label = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

