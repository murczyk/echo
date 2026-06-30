import type { XlsxGridRange } from './xlsx-grid-utils';

export function copyXlsxSelection(rows: string[][], selection: XlsxGridRange | null): string {
  if (selection == null) return '';

  const output: string[] = [];
  for (let rowIndex = selection.startRow; rowIndex <= selection.endRow; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const values: string[] = [];
    for (let columnIndex = selection.startColumn; columnIndex <= selection.endColumn; columnIndex += 1) {
      values.push((row[columnIndex] ?? '').replace(/\r?\n/g, ' '));
    }
    output.push(values.join('\t'));
  }

  return output.join('\n');
}

