import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import PersonOutlineOutlinedIcon from '@mui/icons-material/PersonOutlineOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import type { InboxMessage, Tag } from '../../../../../Bindings';
import type { TagsLayoutVariant } from '../../rer-duty-neo/utils';
import { buildMessageCardTagRows } from './MessageCardTags.helpers';
import type { MessageCardTagRow } from './MessageCardTags.helpers';

const TAG_CHIP_GAP_PX = 4;
const COMPACT_EXPAND_BTN_RESERVE_PX = 116;
/** MUI spacing 1.75 → 14px; room for contribution badges above the chip. */
const TAG_CHIP_BADGE_TOP_PADDING_PX = 14;

function estimateTagChipWidthPx(label: string, showBadge?: boolean): number {
  const base = Math.round(label.length * 8.5 + 28);
  const withBadge = showBadge ? base + 22 : base;
  return Math.min(240, Math.max(36, withBadge));
}

export function buildSelectedFirstTagOrder(rows: MessageCardTagRow[]): number[] {
  return [...rows.filter((row) => row.isSet), ...rows.filter((row) => !row.isSet)].map(
    (row) => row.tagId,
  );
}

const MessageCardTagChip = memo(function MessageCardTagChip({
  row,
  interactive,
  onToggleTag,
}: {
  row: MessageCardTagRow;
  interactive: boolean;
  onToggleTag?: (tagId: number) => void;
}) {
  const canToggle = interactive && onToggleTag != null;
  const chipClassName = 'message-card-tag-chip';
  const chipLabel = <span className="message-card-tag-chip__label">{row.label}</span>;

  return (
    <span
      data-message-card-tag-id={row.tagId}
      className="inline-flex max-w-full items-start align-top"
      style={{ paddingTop: TAG_CHIP_BADGE_TOP_PADDING_PX }}
      title={row.tip ?? undefined}
    >
      <span className="relative inline-flex max-w-full shrink-0">
        {canToggle ? (
          <button
            type="button"
            className={chipClassName}
            data-selected={row.isSet ? 'true' : 'false'}
            data-interactive="true"
            onClick={() => onToggleTag(Number(row.tagId))}
          >
            {chipLabel}
          </button>
        ) : (
          <span
            className={chipClassName}
            data-selected={row.isSet ? 'true' : 'false'}
            data-interactive="false"
          >
            {chipLabel}
          </span>
        )}
        {row.showBadge && (
          <span
            className="absolute -top-[12px] -right-1 flex items-center gap-1 rounded-full border border-border bg-card px-1.5 py-0.5 text-[10px] shadow-sm"
            aria-hidden
          >
            {row.botContribsLen > 0 && (
              <span className="flex items-center gap-0.5" title="Боти">
                <SmartToyOutlinedIcon sx={{ fontSize: 11 }} aria-hidden />
                <span>{row.botContribsLen}</span>
              </span>
            )}
            {row.humanContribsLen > 0 && (
              <span className="flex items-center gap-0.5" title="Користувачі">
                <PersonOutlineOutlinedIcon sx={{ fontSize: 11 }} aria-hidden />
                <span>{row.humanContribsLen}</span>
              </span>
            )}
          </span>
        )}
      </span>
    </span>
  );
});

function MessageCardTagsComponent({
  msg,
  tagsMap,
  tagsOrder,
  tagContributionsOrganismId,
  onToggleTag,
  tagsLayout,
  interactive = true,
}: {
  msg: InboxMessage;
  tagsMap: Record<number, Tag>;
  tagsOrder?: number[];
  tagContributionsOrganismId?: number;
  onToggleTag?: (tagId: number) => void;
  tagsLayout: TagsLayoutVariant;
  interactive?: boolean;
}) {
  const [showCompactRest, setShowCompactRest] = useState(false);
  const compactMeasureRef = useRef<HTMLDivElement | null>(null);
  const rows = useMemo(
    () => buildMessageCardTagRows(msg, tagsMap, tagsOrder, tagContributionsOrganismId),
    [msg, tagsMap, tagsOrder, tagContributionsOrganismId],
  );
  const rowsById = useMemo(() => new Map(rows.map((row) => [row.tagId, row] as const)), [rows]);
  const rowIdKey = useMemo(
    () =>
      rows
        .map((row) => row.tagId)
        .slice()
        .sort((left, right) => left - right)
        .join(','),
    [rows],
  );
  const messageResetKey = msg.messageUid ?? `${msg.timestamp ?? ''}-${msg.text ?? ''}`;
  const [orderedTagIds, setOrderedTagIds] = useState<number[]>(() =>
    buildSelectedFirstTagOrder(rows),
  );

  useEffect(() => {
    setOrderedTagIds(buildSelectedFirstTagOrder(rows));
  }, [messageResetKey, rowIdKey]);

  const compactOrderedRows = useMemo(
    () =>
      orderedTagIds
        .map((tagId) => rowsById.get(tagId))
        .filter((row): row is MessageCardTagRow => row != null),
    [orderedTagIds, rowsById],
  );
  const [firstRowCount, setFirstRowCount] = useState(() => compactOrderedRows.length);

  useLayoutEffect(() => {
    if (tagsLayout !== 'compact') return;
    // Expanded rest chips live inside the measure root; remounting them must not re-pack
    // (DOM chip widths also change between wrap vs overflow-hidden and would oscillate).
    if (showCompactRest) return;
    const el = compactMeasureRef.current;
    if (!el) return;
    const packing = compactOrderedRows;
    const compute = () => {
      if (packing.length === 0) {
        setFirstRowCount(0);
        return;
      }
      const w = el.getBoundingClientRect().width;
      if (w <= 0) return;

      // Estimates only: measured widths differ between the all-chips wrap pass and the
      // packed overflow-hidden row, which previously caused firstRowCount to thrash.
      const getWidth = (row: MessageCardTagRow) => estimateTagChipWidthPx(row.label, row.showBadge);

      let usedWithoutBtn = 0;
      let fitsWithoutBtn = true;
      for (let i = 0; i < packing.length; i++) {
        const gap = i > 0 ? TAG_CHIP_GAP_PX : 0;
        const nextWidth = usedWithoutBtn + gap + getWidth(packing[i]);
        if (nextWidth > w) {
          fitsWithoutBtn = false;
          break;
        }
        usedWithoutBtn = nextWidth;
      }
      if (fitsWithoutBtn) {
        setFirstRowCount((c) => (c === packing.length ? c : packing.length));
        return;
      }

      const btnNode = el.querySelector<HTMLElement>('button.message-card-tag-expand');
      const btnReserve = Math.max(
        COMPACT_EXPAND_BTN_RESERVE_PX,
        btnNode ? Math.ceil(btnNode.getBoundingClientRect().width) + 20 : 0,
      );
      const availableWidthForRow1 = Math.max(0, w - btnReserve);
      let count = 0;
      let usedWidth = 0;
      for (let i = 0; i < packing.length; i++) {
        const chipW = getWidth(packing[i]);
        const gap = i > 0 ? TAG_CHIP_GAP_PX : 0;
        if (usedWidth + gap + chipW > availableWidthForRow1) {
          break;
        }
        usedWidth += gap + chipW;
        count = i + 1;
      }

      const atLeastOne = count === 0 && packing.length > 0 ? 1 : count;
      const next = atLeastOne >= packing.length ? packing.length : atLeastOne;
      setFirstRowCount((c) => (c === next ? c : next));
    };
    compute();
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(compute);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [tagsLayout, compactOrderedRows, showCompactRest]);

  const row1Chips = useMemo(
    () => compactOrderedRows.slice(0, firstRowCount),
    [compactOrderedRows, firstRowCount],
  );
  const row1IdSet = useMemo(() => new Set(row1Chips.map((r) => Number(r.tagId))), [row1Chips]);
  const restRows = useMemo(
    () => compactOrderedRows.filter((r) => !row1IdSet.has(Number(r.tagId))),
    [compactOrderedRows, row1IdSet],
  );
  const hasRest = restRows.length > 0;

  useEffect(() => {
    if (!hasRest) {
      setShowCompactRest((open) => (open ? false : open));
    }
  }, [hasRest]);

  if (tagsLayout === 'full') {
    return (
      <div className="flex w-full min-w-0 flex-wrap items-start gap-x-1 gap-y-2.5">
        {rows.map((row) => (
          <MessageCardTagChip
            key={row.tagId}
            row={row}
            interactive={interactive}
            onToggleTag={onToggleTag}
          />
        ))}
      </div>
    );
  }

  const expandToggleButton = hasRest ? (
    <button
      type="button"
      className="message-card-tag-expand"
      onClick={() => setShowCompactRest((v) => !v)}
      aria-expanded={showCompactRest}
      aria-label={showCompactRest ? 'Згорнути додаткові теги' : 'Показати додаткові теги'}
    >
      {showCompactRest ? 'згорнути' : 'розгорнути'}
      {showCompactRest ? (
        <ExpandLessIcon fontSize="inherit" aria-hidden />
      ) : (
        <ExpandMoreIcon fontSize="inherit" aria-hidden />
      )}
    </button>
  ) : null;

  if (!hasRest) {
    return (
      <div
        ref={compactMeasureRef}
        className="flex w-full min-w-0 flex-wrap items-start gap-x-1 gap-y-2.5"
      >
        {compactOrderedRows.map((row) => (
          <MessageCardTagChip
            key={row.tagId}
            row={row}
            interactive={interactive}
            onToggleTag={onToggleTag}
          />
        ))}
      </div>
    );
  }

  return (
    <div ref={compactMeasureRef} className="flex w-full min-w-0 flex-col gap-y-1.5">
      <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-1">
        <div className="flex min-h-[27px] min-w-0 flex-1 items-center gap-1 overflow-x-hidden">
          {row1Chips.map((row) => (
            <MessageCardTagChip
              key={row.tagId}
              row={row}
              interactive={interactive}
              onToggleTag={onToggleTag}
            />
          ))}
        </div>
        <div
          className="shrink-0 justify-self-end"
          style={{ paddingTop: TAG_CHIP_BADGE_TOP_PADDING_PX }}
        >
          {expandToggleButton}
        </div>
      </div>
      {showCompactRest && (
        <div className="flex w-full min-w-0 flex-wrap items-start gap-x-1 gap-y-2.5">
          {restRows.map((row) => (
            <MessageCardTagChip
              key={row.tagId}
              row={row}
              interactive={interactive}
              onToggleTag={onToggleTag}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export const MessageCardTags = memo(MessageCardTagsComponent);
