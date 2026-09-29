export type XlsPreviewResult = {
  sheets: Array<{
    name: string;
    rows: string[][];
    rowCount: number;
    columnCount: number;
    truncated: boolean;
  }>;
  truncated: boolean;
};

export type DocPreviewResult = {
  blocks: Array<
    | { type: 'paragraph'; text: string }
    | { type: 'list'; ordered: boolean; items: Array<{ level: number; text: string }> }
    | { type: 'table'; rows: Array<Array<{ text: string }>> }
  >;
  truncated: boolean;
};

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS;
}

function isSheetName(value: unknown): value is string {
  return isBoundedString(value) && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

export function validateXlsPreviewResult(value: unknown): XlsPreviewResult | null {
  if (typeof value !== 'object' || value == null) return null;
  if (!hasExactKeys(value, ['sheets', 'truncated'])) return null;
  const record = value as { sheets?: unknown; truncated?: unknown };
  if (
    !Array.isArray(record.sheets) ||
    record.sheets.length === 0 ||
    record.sheets.length > LEGACY_OFFICE_MAX_SHEETS ||
    typeof record.truncated !== 'boolean'
  )
    return null;
  const sheets: XlsPreviewResult['sheets'] = [];
  let cells = 0;
  let text = 0;
  for (const sheet of record.sheets) {
    if (typeof sheet !== 'object' || sheet == null) return null;
    if (!hasExactKeys(sheet, ['name', 'rows', 'rowCount', 'columnCount', 'truncated'])) return null;
    const item = sheet as Partial<XlsPreviewResult['sheets'][number]>;
    if (
      !isSheetName(item.name) ||
      !Array.isArray(item.rows) ||
      typeof item.rowCount !== 'number' ||
      !Number.isInteger(item.rowCount) ||
      typeof item.columnCount !== 'number' ||
      !Number.isInteger(item.columnCount) ||
      item.rowCount < 0 ||
      item.columnCount < 0 ||
      item.rowCount > LEGACY_OFFICE_BIFF8_MAX_ROWS ||
      item.columnCount > LEGACY_OFFICE_BIFF8_MAX_COLUMNS ||
      typeof item.truncated !== 'boolean' ||
      item.rows.length > LEGACY_OFFICE_MAX_ROWS
    )
      return null;
    const rows: string[][] = [];
    for (const row of item.rows) {
      if (
        !Array.isArray(row) ||
        row.length > LEGACY_OFFICE_MAX_COLUMNS ||
        !row.every(isBoundedString)
      )
        return null;
      cells += row.filter((cell) => cell !== '').length;
      text += row.reduce((total, cell) => total + cell.length, 0);
      if (cells > LEGACY_OFFICE_MAX_CELLS || text > LEGACY_OFFICE_MAX_TEXT_CODE_UNITS) return null;
      rows.push(row);
    }
    sheets.push({
      name: item.name,
      rows,
      rowCount: item.rowCount,
      columnCount: item.columnCount,
      truncated: item.truncated,
    });
  }
  return { sheets, truncated: record.truncated };
}

export function validateDocPreviewResult(value: unknown): DocPreviewResult | null {
  if (typeof value !== 'object' || value == null) return null;
  if (!hasExactKeys(value, ['blocks', 'truncated'])) return null;
  const record = value as { blocks?: unknown; truncated?: unknown };
  if (
    !Array.isArray(record.blocks) ||
    record.blocks.length > LEGACY_OFFICE_MAX_DOC_BLOCKS ||
    typeof record.truncated !== 'boolean'
  )
    return null;
  let text = 0;
  let runs = 0;
  let cells = 0;
  const blocks: DocPreviewResult['blocks'] = [];
  for (const block of record.blocks) {
    if (typeof block !== 'object' || block == null) return null;
    const item = block as Record<string, unknown>;
    if (
      item.type === 'paragraph' &&
      hasExactKeys(item, ['type', 'text']) &&
      isBoundedString(item.text)
    ) {
      text += item.text.length;
      runs += 1;
      blocks.push({ type: 'paragraph', text: item.text });
    } else if (
      item.type === 'list' &&
      hasExactKeys(item, ['type', 'ordered', 'items']) &&
      typeof item.ordered === 'boolean' &&
      Array.isArray(item.items) &&
      item.items.length > 0
    ) {
      const items: Array<{ level: number; text: string }> = [];
      for (const listItem of item.items) {
        if (typeof listItem !== 'object' || listItem == null) return null;
        if (!hasExactKeys(listItem, ['level', 'text'])) return null;
        const listRecord = listItem as { level?: unknown; text?: unknown };
        if (
          !Number.isInteger(listRecord.level) ||
          (listRecord.level as number) < 0 ||
          (listRecord.level as number) > LEGACY_OFFICE_MAX_LIST_NESTING ||
          !isBoundedString(listRecord.text)
        )
          return null;
        text += listRecord.text.length;
        runs += 1;
        items.push({ level: listRecord.level as number, text: listRecord.text });
      }
      blocks.push({ type: 'list', ordered: item.ordered, items });
    } else if (
      item.type === 'table' &&
      hasExactKeys(item, ['type', 'rows']) &&
      Array.isArray(item.rows) &&
      item.rows.length > 0
    ) {
      const rows: Array<Array<{ text: string }>> = [];
      for (const row of item.rows) {
        if (!Array.isArray(row) || row.length === 0) return null;
        const cellsInRow: Array<{ text: string }> = [];
        for (const cell of row) {
          if (
            typeof cell !== 'object' ||
            cell == null ||
            !hasExactKeys(cell, ['text']) ||
            !isBoundedString((cell as { text?: unknown }).text)
          )
            return null;
          const cellText = (cell as { text: string }).text;
          text += cellText.length;
          runs += 1;
          cells += 1;
          cellsInRow.push({ text: cellText });
        }
        rows.push(cellsInRow);
      }
      blocks.push({ type: 'table', rows });
    } else return null;
    if (
      text > LEGACY_OFFICE_MAX_TEXT_CODE_UNITS ||
      runs > LEGACY_OFFICE_MAX_DOC_RUNS ||
      cells > LEGACY_OFFICE_MAX_DOC_TABLE_CELLS
    )
      return null;
  }
  return { blocks, truncated: record.truncated };
}
import {
  LEGACY_OFFICE_BIFF8_MAX_COLUMNS,
  LEGACY_OFFICE_BIFF8_MAX_ROWS,
  LEGACY_OFFICE_MAX_CELLS,
  LEGACY_OFFICE_MAX_COLUMNS,
  LEGACY_OFFICE_MAX_DOC_BLOCKS,
  LEGACY_OFFICE_MAX_DOC_RUNS,
  LEGACY_OFFICE_MAX_DOC_TABLE_CELLS,
  LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS,
  LEGACY_OFFICE_MAX_LIST_NESTING,
  LEGACY_OFFICE_MAX_ROWS,
  LEGACY_OFFICE_MAX_SHEETS,
  LEGACY_OFFICE_MAX_TEXT_CODE_UNITS,
} from './legacy-office-limits';
