import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';

import {
  DEVICE_FILE_TABLE_COLUMNS,
  DEVICE_FILE_TABLE_COLUMN_KEYBOARD_STEP_PX,
  DEVICE_FILE_TABLE_COLUMN_MAX_WIDTH_REM,
  DEVICE_FILE_TABLE_WIDTHS_STORAGE_KEY,
  type DeviceFileTableColumnId,
  type DeviceFileTableColumnWidths,
} from './device-file-table-config';

function readWidths(): DeviceFileTableColumnWidths | null {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(DEVICE_FILE_TABLE_WIDTHS_STORAGE_KEY) ?? 'null',
    );
    if (!value || typeof value !== 'object') return null;
    const saved = value as Record<string, unknown>;
    if (
      !DEVICE_FILE_TABLE_COLUMNS.every(
        ({ id, minWidth }) =>
          typeof saved[id] === 'number' &&
          Number.isFinite(saved[id]) &&
          saved[id] >= minWidth &&
          saved[id] <= DEVICE_FILE_TABLE_COLUMN_MAX_WIDTH_REM,
      )
    )
      return null;
    return Object.fromEntries(
      DEVICE_FILE_TABLE_COLUMNS.map(({ id }) => [id, saved[id]]),
    ) as DeviceFileTableColumnWidths;
  } catch {
    return null;
  }
}

function remSize() {
  return typeof document === 'undefined'
    ? 16
    : Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

export function useDeviceFileColumnWidths() {
  const tableRef = useRef<HTMLTableElement>(null);
  const [widths, setWidths] = useState(readWidths);
  const [resizing, setResizing] = useState(false);
  const [defaultWidths, setDefaultWidths] = useState<DeviceFileTableColumnWidths | null>(null);
  const drag = useRef<{
    pointerId: number;
    x: number;
    rem: number;
    widths: DeviceFileTableColumnWidths;
  } | null>(null);

  useEffect(() => {
    if (!widths || resizing) return;
    try {
      localStorage.setItem(DEVICE_FILE_TABLE_WIDTHS_STORAGE_KEY, JSON.stringify(widths));
    } catch {
      // Column resizing remains available when browser storage is disabled.
    }
  }, [widths, resizing]);

  useEffect(() => {
    const table = tableRef.current;
    if (!table || widths) return;
    let previousGeometry = '';
    const update = () => {
      const geometry = `${table.getBoundingClientRect().width}:${remSize()}`;
      if (geometry === previousGeometry) return;
      previousGeometry = geometry;
      setDefaultWidths(measuredWidths());
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(table);
    return () => observer.disconnect();
  }, [widths]);

  function measuredWidths(): DeviceFileTableColumnWidths {
    const headers = tableRef.current?.querySelectorAll('thead th');
    const rem = remSize();
    return Object.fromEntries(
      DEVICE_FILE_TABLE_COLUMNS.map((column, index) => [
        column.id,
        Math.max(
          column.minWidth,
          Math.min(
            DEVICE_FILE_TABLE_COLUMN_MAX_WIDTH_REM,
            headers?.[index] ? headers[index].getBoundingClientRect().width / rem : column.width,
          ),
        ),
      ]),
    ) as DeviceFileTableColumnWidths;
  }

  function resize(id: DeviceFileTableColumnId, width: number, current = measuredWidths()) {
    const column = DEVICE_FILE_TABLE_COLUMNS.find((column) => column.id === id)!;
    setWidths({
      ...current,
      [id]: Math.max(column.minWidth, Math.min(DEVICE_FILE_TABLE_COLUMN_MAX_WIDTH_REM, width)),
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>, id: DeviceFileTableColumnId) {
    const current = measuredWidths();
    const column = DEVICE_FILE_TABLE_COLUMNS.find((column) => column.id === id)!;
    const step = DEVICE_FILE_TABLE_COLUMN_KEYBOARD_STEP_PX / remSize();
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = current[id] - step;
        break;
      case 'ArrowRight':
        next = current[id] + step;
        break;
      case 'Home':
        next = column.minWidth;
        break;
      case 'End':
        next = DEVICE_FILE_TABLE_COLUMN_MAX_WIDTH_REM;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    resize(id, next, current);
  }

  function finishResize(event: PointerEvent<HTMLSpanElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function resizeHandleProps(id: DeviceFileTableColumnId) {
    const column = DEVICE_FILE_TABLE_COLUMNS.find((column) => column.id === id)!;
    return {
      'aria-valuemin': column.minWidth,
      'aria-valuemax': DEVICE_FILE_TABLE_COLUMN_MAX_WIDTH_REM,
      'aria-valuenow': (widths ?? defaultWidths)?.[id] ?? column.width,
      'aria-valuetext': `${Math.round(((widths ?? defaultWidths)?.[id] ?? column.width) * remSize())} px`,
      onPointerDown(event: PointerEvent<HTMLSpanElement>) {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        const current = measuredWidths();
        drag.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          rem: remSize(),
          widths: current,
        };
        setWidths(current);
        setResizing(true);
      },
      onPointerMove(event: PointerEvent<HTMLSpanElement>) {
        const start = drag.current;
        if (start?.pointerId === event.pointerId)
          resize(id, start.widths[id] + (event.clientX - start.x) / start.rem, start.widths);
      },
      onPointerUp: finishResize,
      onPointerCancel: finishResize,
      onLostPointerCapture() {
        drag.current = null;
        setResizing(false);
      },
      onKeyDown: (event: KeyboardEvent<HTMLSpanElement>) => onKeyDown(event, id),
      onClick: (event: MouseEvent<HTMLSpanElement>) => event.stopPropagation(),
      onDoubleClick(event: MouseEvent<HTMLSpanElement>) {
        event.preventDefault();
        event.stopPropagation();
        resize(id, column.width);
      },
    };
  }

  return { tableRef, widths, resizing, resizeHandleProps };
}
