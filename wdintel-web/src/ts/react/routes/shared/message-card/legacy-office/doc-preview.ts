import './vendor/jsdoc/docToText.js';

import { validateCfbContainer } from './cfb-validation';
import { validateWordDocument } from './doc-validation';
import { LegacyOfficePreviewError, LegacyOfficePreviewErrorCode } from './legacy-office-errors';
import {
  LEGACY_OFFICE_MAX_DOC_BLOCKS,
  LEGACY_OFFICE_MAX_DOC_TABLE_CELLS,
  LEGACY_OFFICE_MAX_FILE_BYTES,
  LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS,
  LEGACY_OFFICE_MAX_LIST_MARKER_CODE_UNITS,
  LEGACY_OFFICE_MAX_TEXT_CODE_UNITS,
} from './legacy-office-limits';
import type { DocPreviewResult } from './legacy-office-preview.types';

type CandidateRun = { text?: unknown };
type CandidateParagraph = {
  kind?: unknown;
  list?: { ilvl?: unknown; kind?: unknown; marker?: unknown } | null;
  runs?: CandidateRun[];
};
type CandidateReader = {
  model?: (input: ArrayBuffer, maxBytes?: number) => { body?: unknown } | null;
};

function candidateReader(): CandidateReader | null {
  const candidate = (globalThis as typeof globalThis & { __echoLegacyDocToText?: unknown })
    .__echoLegacyDocToText;
  return typeof candidate === 'function' ? (candidate as CandidateReader) : null;
}

export function buildDocPreview(
  buffer: ArrayBuffer,
  maxBytes = LEGACY_OFFICE_MAX_FILE_BYTES,
): DocPreviewResult {
  if (buffer.byteLength > maxBytes) {
    throw new LegacyOfficePreviewError(LegacyOfficePreviewErrorCode.FileTooLarge);
  }
  const cfb = validateCfbContainer(buffer, maxBytes);
  if (
    cfb.directory.some(
      (entry) => entry.type === 1 && /^(?:vba|macros|_vba_project_cur)$/i.test(entry.name),
    )
  )
    throw new LegacyOfficePreviewError(LegacyOfficePreviewErrorCode.UnsupportedStructure);
  if (cfb.streams.has('EncryptedPackage') || cfb.streams.has('EncryptionInfo')) {
    throw new LegacyOfficePreviewError(LegacyOfficePreviewErrorCode.Encrypted);
  }
  if (
    !cfb.streams.has('WordDocument') ||
    (!cfb.streams.has('0Table') && !cfb.streams.has('1Table'))
  ) {
    throw new LegacyOfficePreviewError(LegacyOfficePreviewErrorCode.UnsupportedStructure);
  }
  const wordDocument = cfb.readStream('WordDocument');
  const preferredTable =
    new DataView(wordDocument.buffer, wordDocument.byteOffset).getUint16(10, true) & 0x0200
      ? '1Table'
      : '0Table';
  const table = cfb.readStream(
    cfb.streams.has(preferredTable)
      ? preferredTable
      : preferredTable === '0Table'
        ? '1Table'
        : '0Table',
  );
  validateWordDocument(wordDocument, table, maxBytes);
  const reader = candidateReader();
  if (reader == null)
    throw new LegacyOfficePreviewError(LegacyOfficePreviewErrorCode.UnsupportedStructure);
  const body = reader.model?.(buffer, maxBytes)?.body;
  if (!Array.isArray(body))
    throw new LegacyOfficePreviewError(LegacyOfficePreviewErrorCode.Malformed);
  const blocks: DocPreviewResult['blocks'] = [];
  let emittedText = 0;
  let tableCells = 0;
  let truncated = false;
  let pendingTableRows: Array<Array<{ text: string }>> = [];
  let pendingCellParagraphs: string[] = [];
  let pendingList: Extract<DocPreviewResult['blocks'][number], { type: 'list' }> | null = null;
  const flushTable = () => {
    const rows = pendingTableRows.filter((row) => row.length > 0);
    if (rows.length > 0) blocks.push({ type: 'table', rows });
    pendingTableRows = [];
  };
  const flushList = () => {
    if (pendingList != null && pendingList.items.length > 0) blocks.push(pendingList);
    pendingList = null;
  };
  for (const candidateParagraph of body as CandidateParagraph[]) {
    if (
      blocks.length >= LEGACY_OFFICE_MAX_DOC_BLOCKS ||
      emittedText >= LEGACY_OFFICE_MAX_TEXT_CODE_UNITS
    ) {
      truncated = true;
      break;
    }
    let text =
      candidateParagraph.runs
        ?.map((run) => (typeof run.text === 'string' ? run.text : ''))
        .join('') ?? '';
    const isTableCellPart = candidateParagraph.kind === 'cellPart';
    const isTableCell = candidateParagraph.kind === 'cell' || candidateParagraph.kind === 'rowEnd';
    if (!isTableCellPart && !isTableCell && text.length > LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS) {
      text = text.slice(0, LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS);
      truncated = true;
    }
    if (isTableCellPart) {
      pendingCellParagraphs.push(text);
      continue;
    }
    if (isTableCell) {
      flushList();
      let cellText = [...pendingCellParagraphs, text].join('\n');
      pendingCellParagraphs = [];
      if (cellText.length > LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS) {
        cellText = cellText.slice(0, LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS);
        truncated = true;
      }
      if (tableCells >= LEGACY_OFFICE_MAX_DOC_TABLE_CELLS) {
        truncated = true;
        break;
      }
      const remainingText = LEGACY_OFFICE_MAX_TEXT_CODE_UNITS - emittedText;
      if (remainingText <= 0) {
        truncated = true;
        break;
      }
      const stopAfterCell = cellText.length > remainingText;
      if (stopAfterCell) {
        cellText = cellText.slice(0, remainingText);
        truncated = true;
      }
      emittedText += cellText.length;
      const row = pendingTableRows.at(-1);
      if (row == null) pendingTableRows.push([{ text: cellText }]);
      else row.push({ text: cellText });
      tableCells += 1;
      if (candidateParagraph.kind === 'rowEnd') pendingTableRows.push([]);
      if (stopAfterCell) break;
    } else {
      pendingCellParagraphs = [];
      const list = candidateParagraph.list;
      let marker = typeof list?.marker === 'string' ? list.marker : '';
      if (marker.length > LEGACY_OFFICE_MAX_LIST_MARKER_CODE_UNITS) {
        marker = marker.slice(0, LEGACY_OFFICE_MAX_LIST_MARKER_CODE_UNITS);
        truncated = true;
      }
      const remainingText = LEGACY_OFFICE_MAX_TEXT_CODE_UNITS - emittedText;
      if (remainingText <= 0) {
        truncated = true;
        break;
      }
      const stopAfterBlock = marker.length + text.length > remainingText;
      if (stopAfterBlock) {
        marker = marker.slice(0, remainingText);
        text = text.slice(0, remainingText - marker.length);
        truncated = true;
      }
      emittedText += marker.length + text.length;
      flushTable();
      if (list != null) {
        const ordered = list.kind === 'number';
        const level = typeof list.ilvl === 'number' ? Math.min(Math.max(list.ilvl, 0), 9) : 0;
        if (pendingList == null || pendingList.ordered !== ordered) {
          flushList();
          pendingList = { type: 'list', ordered, items: [] };
        }
        pendingList.items.push({ level, marker, text });
      } else {
        flushList();
        blocks.push({ type: 'paragraph', text });
      }
      if (stopAfterBlock) break;
    }
  }
  flushTable();
  flushList();
  return { blocks, truncated };
}
