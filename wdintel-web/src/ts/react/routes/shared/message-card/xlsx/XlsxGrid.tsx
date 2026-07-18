import {
  createElement,
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { Box, Typography, useTheme } from '@mui/material';
import { TableVirtuoso, type TableComponents } from 'react-virtuoso';

import type { XlsxGridRange } from './xlsx-grid-utils';
import { columnLabel, isCellInRange, normalizeXlsxRange } from './xlsx-grid-utils';
import { copyXlsxSelection } from './copy-xlsx-selection';
import { MAX_XLSX_COLUMNS, MAX_XLSX_ROWS, MAX_XLSX_SHEETS } from './xlsx-preview-utils';

export function XlsxGrid({
  rows,
  zoom,
  truncated,
  truncationNotice,
  onSelectionChange,
}: {
  rows: string[][];
  zoom: number;
  truncated: boolean;
  truncationNotice?: string;
  onSelectionChange?: (selection: XlsxGridRange | null) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<XlsxGridRange | null>(null);
  const [dragAnchor, setDragAnchor] = useState<{
    row: number;
    column: number;
  } | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<number, number>>({});

  const columnCount = useMemo(
    () => rows.reduce((max, row) => Math.max(max, row.length), 0),
    [rows],
  );
  const scale = zoom / 100;
  const fontSize = Math.max(11, Math.round(12 * scale));
  const cellWidth = Math.max(80, Math.round(96 * scale));
  const cellHeight = Math.max(26, Math.round(28 * scale));
  const paddingX = Math.max(6, Math.round(8 * scale));
  const paddingY = Math.max(3, Math.round(4 * scale));
  const rowHeaderWidth = Math.max(44, Math.round(52 * scale));
  const getColumnWidth = (columnIndex: number) => columnWidths[columnIndex] ?? cellWidth;

  const theme = useTheme();

  useEffect(() => {
    onSelectionChange?.(selection);
  }, [onSelectionChange, selection]);

  useEffect(() => {
    const root = rootRef.current;
    if (root == null) return;

    const onKeyDown = async (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c') return;
      if (selection == null) return;
      event.preventDefault();
      await navigator.clipboard.writeText(copyXlsxSelection(rows, selection));
    };

    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, [rows, selection]);

  const updateSelection = (
    startRow: number,
    startColumn: number,
    endRow: number,
    endColumn: number,
  ) => {
    const nextSelection = normalizeXlsxRange({
      startRow,
      endRow,
      startColumn,
      endColumn,
    });
    setSelection(nextSelection);
  };

  const startColumnResize = (event: ReactPointerEvent<HTMLSpanElement>, columnIndex: number) => {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = getColumnWidth(columnIndex);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = Math.max(64, startWidth + moveEvent.clientX - startX);
      setColumnWidths((current) => ({ ...current, [columnIndex]: nextWidth }));
    };

    const stopResize = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  };

  const tableComponents = useMemo(
    () =>
      ({
        Scroller: forwardRefElement('div'),
        Table: forwardRefElement('table'),
        TableHead: forwardRefSection('thead'),
        TableBody: forwardRefSection('tbody'),
        TableRow: forwardRefElement('tr'),
      }) as unknown as TableComponents<string[], unknown>,
    [],
  );

  return (
    <Box
      ref={rootRef}
      tabIndex={0}
      sx={{
        flex: '1 1 auto',
        minHeight: 0,
        overflow: 'hidden',
        outline: 'none',
        backgroundColor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',

        '& table': {
          borderCollapse: 'collapse',
          width: 'max-content',
          minWidth: '100%',
          backgroundColor: 'background.paper',
          color: 'text.primary',
        },
      }}
      onMouseLeave={() => {
        if (dragAnchor == null) return;
        setDragAnchor(null);
      }}
    >
      {truncated ? (
        <Box
          sx={{
            px: 2,
            py: 1,
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {truncationNotice ??
              `Показано перші ${MAX_XLSX_ROWS} рядків, ${MAX_XLSX_COLUMNS} колонок або ${MAX_XLSX_SHEETS} аркушів.`}
          </Typography>
        </Box>
      ) : null}
      <TableVirtuoso
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          width: '100%',
          height: '100%',
        }}
        data={rows}
        fixedItemHeight={cellHeight}
        components={tableComponents}
        fixedHeaderContent={() => (
          <tr>
            <th
              style={{
                position: 'sticky',
                top: 0,
                left: 0,
                zIndex: 3,
                width: rowHeaderWidth,
                minWidth: rowHeaderWidth,
                background: theme.palette.action.hover,
                border: `1px solid ${theme.palette.divider}`,
                padding: `${paddingY}px ${paddingX}px`,
              }}
            />
            {Array.from({ length: columnCount }).map((_, columnIndex) => (
              <th
                key={`col-${columnIndex}`}
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 2,
                  width: getColumnWidth(columnIndex),
                  minWidth: getColumnWidth(columnIndex),
                  background: theme.palette.action.hover,
                  color: theme.palette.text.secondary,
                  border: `1px solid ${theme.palette.divider}`,
                  padding: `${paddingY}px ${paddingX}px`,
                  fontSize,
                }}
              >
                {columnLabel(columnIndex)}
                <span
                  onPointerDown={(event) => startColumnResize(event, columnIndex)}
                  title="Змінити ширину колонки"
                  style={{
                    position: 'absolute',
                    top: 0,
                    right: -3,
                    width: 7,
                    height: '100%',
                    cursor: 'col-resize',
                    touchAction: 'none',
                    zIndex: 4,
                  }}
                />
              </th>
            ))}
          </tr>
        )}
        itemContent={(rowIndex, row) => (
          <>
            <th
              style={{
                position: 'sticky',
                left: 0,
                zIndex: 1,
                width: rowHeaderWidth,
                minWidth: rowHeaderWidth,
                background: theme.palette.action.hover,
                color: theme.palette.text.secondary,
                border: `1px solid ${theme.palette.divider}`,
                padding: `${paddingY}px ${paddingX}px`,
                fontSize,
              }}
            >
              {rowIndex + 1}
            </th>
            {Array.from({ length: columnCount }).map((_, columnIndex) => {
              const value = row[columnIndex] ?? '';
              const selected = isCellInRange(rowIndex, columnIndex, selection);
              return (
                <td
                  key={`cell-${rowIndex}-${columnIndex}`}
                  onMouseDown={(event: ReactMouseEvent<HTMLTableCellElement>) => {
                    event.preventDefault();
                    rootRef.current?.focus();
                    setDragAnchor({ row: rowIndex, column: columnIndex });
                    updateSelection(rowIndex, columnIndex, rowIndex, columnIndex);
                  }}
                  onMouseEnter={() => {
                    if (dragAnchor == null) return;
                    updateSelection(dragAnchor.row, dragAnchor.column, rowIndex, columnIndex);
                  }}
                  onMouseUp={() => {
                    setDragAnchor(null);
                  }}
                  style={{
                    border: `1px solid ${theme.palette.divider}`,
                    width: getColumnWidth(columnIndex),
                    minWidth: getColumnWidth(columnIndex),
                    maxWidth: getColumnWidth(columnIndex),
                    height: cellHeight,
                    padding: `${paddingY}px ${paddingX}px`,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    backgroundColor: selected
                      ? theme.palette.action.selected
                      : theme.palette.background.paper,
                    color: theme.palette.text.primary,
                    cursor: 'default',
                    userSelect: 'none',
                    fontSize,
                  }}
                  title={value}
                >
                  {value}
                </td>
              );
            })}
          </>
        )}
      />
    </Box>
  );
}

function forwardRefElement(elementType: keyof HTMLElementTagNameMap) {
  return forwardRef<
    HTMLElement,
    { children?: ReactNode; style?: React.CSSProperties } & Record<string, unknown>
  >(function VirtuosoElement({ style, children, ...props }, ref) {
    return createElement(elementType, { ref, style, ...props }, children as ReactNode);
  });
}

function forwardRefSection(sectionType: 'thead' | 'tbody') {
  return forwardRef<
    HTMLTableSectionElement,
    { children?: ReactNode; style?: React.CSSProperties } & Record<string, unknown>
  >(function VirtuosoSection({ style, children, ...props }, ref) {
    return createElement(sectionType, { ref, style, ...props }, children as ReactNode);
  });
}
