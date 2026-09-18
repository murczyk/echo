import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import type { InboxMessage, Tag } from '../../../../../Bindings';
import { EchoChip } from '../../../components/EchoChip';
import type { TagsLayoutVariant } from '../../rer-duty-neo/utils';
import { buildMessageCardTagRows } from './MessageCardTags.helpers';
import type { MessageCardTagProvenance, MessageCardTagRow } from './MessageCardTags.helpers';
import { MessageCardBotTagPrompt } from './MessageCardBotTagPrompt';
import type { MessageCardBotTagAction } from './message-card.types';

const TAG_CHIP_GAP_PX = 8;
const COMPACT_EXPAND_BUTTON_FALLBACK_WIDTH_PX = 80;

/** Fallback when a chip has not been measured yet. No upper cap — native chips grow with the label. */
export function estimateTagChipWidthPx(
  label: string,
  provenance: MessageCardTagProvenance = 'none',
): number {
  const dotWidth = provenance === 'none' ? 0 : 13;
  return Math.max(32, Math.round(label.length * 7 + 14 + dotWidth));
}

export function buildSelectedFirstTagOrder(rows: MessageCardTagRow[]): number[] {
  const selectedFirst = (groupRows: MessageCardTagRow[]) => [
    ...groupRows.filter((row) => row.isSet),
    ...groupRows.filter((row) => !row.isSet),
  ];
  return [
    ...selectedFirst(rows.filter((row) => row.isOrganismTag)),
    ...selectedFirst(rows.filter((row) => !row.isOrganismTag)),
  ].map((row) => row.tagId);
}

function getFirstGlobalTagId(rows: MessageCardTagRow[]): number | null {
  if (!rows.some((row) => row.isOrganismTag)) return null;
  return rows.find((row) => !row.isOrganismTag)?.tagId ?? null;
}

const MessageCardTagChip = memo(function MessageCardTagChip({
  row,
  showGroupDivider,
  interactive,
  onToggleTag,
  chipRef,
}: {
  row: MessageCardTagRow;
  showGroupDivider: boolean;
  interactive: boolean;
  onToggleTag?: (tagId: number) => void;
  chipRef?: (element: HTMLElement | null) => void;
}) {
  const tipInstanceId = useId();
  const canToggle = interactive && onToggleTag != null;
  const tipText = row.tip?.trim() ? row.tip : null;
  const tipId = tipText != null ? `message-card-tag-${row.tagId}-tip-${tipInstanceId}` : undefined;
  const tipProps =
    tipId != null
      ? {
          title: tipText ?? undefined,
          'aria-describedby': tipId,
        }
      : {};

  return (
    <span
      data-message-card-tag-id={row.tagId}
      className="inline-flex max-w-full items-start align-top"
    >
      <span
        className={`inline-flex max-w-full shrink-0${showGroupDivider ? ' message-card-tag--with-divider' : ''}`}
      >
        <EchoChip
          label={
            <>
              {row.provenance !== 'none' ? (
                <span
                  className={`message-card-tag-provenance message-card-tag-provenance--${row.provenance}`}
                  aria-hidden
                />
              ) : null}
              {row.label}
            </>
          }
          tone="tag"
          selected={row.isSet}
          className="message-card-tag-chip"
          ref={chipRef}
          onClick={canToggle ? () => onToggleTag(Number(row.tagId)) : undefined}
          {...tipProps}
        />
        {tipId != null && tipText != null ? (
          <span id={tipId} className="sr-only">
            {tipText}
          </span>
        ) : null}
      </span>
    </span>
  );
});

function MessageCardTagsComponent({
  msg,
  tagsMap,
  tagsOrder,
  tagContributionsOrganismId,
  hideBotTags = false,
  onToggleTag,
  tagsLayout,
  interactive = true,
  botTagAction,
  onCancelBotTagAction,
  onMarkBotTagWrong,
}: {
  msg: InboxMessage;
  tagsMap: Record<number, Tag>;
  tagsOrder?: number[];
  tagContributionsOrganismId?: number;
  hideBotTags?: boolean;
  onToggleTag?: (tagId: number) => void;
  tagsLayout: TagsLayoutVariant;
  interactive?: boolean;
  botTagAction?: MessageCardBotTagAction | null;
  onCancelBotTagAction?: () => void;
  onMarkBotTagWrong?: (messageId: number, tagId: number) => void | Promise<void>;
}) {
  const [botAnchor, setBotAnchor] = useState<HTMLElement | null>(null);
  const chipRefs = useRef<Map<number, HTMLElement>>(new Map());
  const chipRefCallbacks = useRef<Map<number, (element: HTMLElement | null) => void>>(new Map());
  const activeBotTagIdRef = useRef<number | null>(botTagAction?.tagId ?? null);
  activeBotTagIdRef.current = botTagAction?.tagId ?? null;
  const getChipRef = useCallback((tagId: number) => {
    const cached = chipRefCallbacks.current.get(tagId);
    if (cached != null) return cached;
    const callback = (element: HTMLElement | null) => {
      const previous = chipRefs.current.get(tagId) ?? null;
      if (element == null) chipRefs.current.delete(tagId);
      else chipRefs.current.set(tagId, element);
      if (activeBotTagIdRef.current !== tagId || previous === element) return;
      setBotAnchor((current) => (current === element ? current : element));
    };
    chipRefCallbacks.current.set(tagId, callback);
    return callback;
  }, []);
  const [showCompactRest, setShowCompactRest] = useState(false);
  const compactMeasureRef = useRef<HTMLDivElement | null>(null);
  /** Natural chip widths from a full (unpacked) render; never update from the overflow-hidden row. */
  const measuredChipWidthsRef = useRef<Map<number, number>>(new Map());
  const rows = useMemo(
    () => buildMessageCardTagRows(msg, tagsMap, tagsOrder, tagContributionsOrganismId, hideBotTags),
    [msg, tagsMap, tagsOrder, tagContributionsOrganismId, hideBotTags],
  );
  const rowsById = useMemo(() => new Map(rows.map((row) => [row.tagId, row] as const)), [rows]);
  const activeBotTagId = botTagAction?.tagId ?? null;
  const activeBotTagExists = activeBotTagId != null && rowsById.has(activeBotTagId);
  const rowIdKey = useMemo(
    () =>
      rows
        .map((row) => `${row.tagId}:${row.isOrganismTag ? 'organism' : 'global'}`)
        .slice()
        .sort()
        .join(','),
    [rows],
  );
  const messageResetKey = msg.messageUid ?? `${msg.timestamp ?? ''}-${msg.text ?? ''}`;
  const [orderedTagIds, setOrderedTagIds] = useState<number[]>(() =>
    buildSelectedFirstTagOrder(rows),
  );

  useEffect(() => {
    setOrderedTagIds(buildSelectedFirstTagOrder(rows));
    setShowCompactRest(false);
  }, [messageResetKey, rowIdKey]);

  useLayoutEffect(() => {
    const nextAnchor =
      activeBotTagExists && activeBotTagId != null
        ? (chipRefs.current.get(activeBotTagId) ?? null)
        : null;
    if (botAnchor !== nextAnchor) setBotAnchor(nextAnchor);
  }, [activeBotTagExists, activeBotTagId, botAnchor]);

  const compactOrderedRows = useMemo(
    () =>
      orderedTagIds
        .map((tagId) => rowsById.get(tagId))
        .filter((row): row is MessageCardTagRow => row != null),
    [orderedTagIds, rowsById],
  );
  const fullFirstGlobalTagId = getFirstGlobalTagId(rows);
  const compactFirstGlobalTagId = getFirstGlobalTagId(compactOrderedRows);
  const packingKey = useMemo(
    () => compactOrderedRows.map((row) => `${row.tagId}:${row.label}:${row.provenance}`).join('|'),
    [compactOrderedRows],
  );
  const [firstRowCount, setFirstRowCount] = useState(() => compactOrderedRows.length);

  useLayoutEffect(() => {
    measuredChipWidthsRef.current = new Map();
    setFirstRowCount((count) =>
      count === compactOrderedRows.length ? count : compactOrderedRows.length,
    );
  }, [packingKey, compactOrderedRows.length]);

  useLayoutEffect(() => {
    if (tagsLayout !== 'compact') return;
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

      const chipNodes = Array.from(el.querySelectorAll<HTMLElement>('[data-message-card-tag-id]'));
      const hasFullNaturalMount = chipNodes.length === packing.length;

      if (hasFullNaturalMount) {
        const nextMap = new Map<number, number>();
        chipNodes.forEach((node) => {
          const idStr = node.getAttribute('data-message-card-tag-id');
          if (!idStr) return;
          const rect = node.getBoundingClientRect();
          if (rect.width > 0) nextMap.set(Number(idStr), rect.width);
        });
        if (nextMap.size === packing.length) {
          measuredChipWidthsRef.current = nextMap;
        }
      } else if (measuredChipWidthsRef.current.size !== packing.length) {
        // Wait for the full natural-size pass before packing decisions.
        setFirstRowCount((count) => (count === packing.length ? count : packing.length));
        return;
      }

      const getWidth = (row: MessageCardTagRow) =>
        measuredChipWidthsRef.current.get(Number(row.tagId)) ??
        estimateTagChipWidthPx(row.label, row.provenance);

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
      const btnReserve =
        (btnNode
          ? Math.ceil(btnNode.getBoundingClientRect().width)
          : COMPACT_EXPAND_BUTTON_FALLBACK_WIDTH_PX) + TAG_CHIP_GAP_PX;
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
  }, [tagsLayout, compactOrderedRows, showCompactRest, packingKey, firstRowCount]);

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
  const botPrompt =
    botTagAction != null &&
    onCancelBotTagAction != null &&
    onMarkBotTagWrong != null &&
    botAnchor != null ? (
      <MessageCardBotTagPrompt
        anchorEl={botAnchor}
        botTagAction={botTagAction}
        tagLabel={rowsById.get(botTagAction.tagId)?.label ?? ''}
        onCancelBotTagAction={onCancelBotTagAction}
        onMarkBotTagWrong={onMarkBotTagWrong}
      />
    ) : null;

  if (tagsLayout === 'full') {
    return (
      <div
        data-message-card-tags="true"
        className="flex w-full min-w-0 flex-wrap items-start gap-2"
      >
        {rows.map((row) => (
          <MessageCardTagChip
            key={row.tagId}
            row={row}
            showGroupDivider={row.tagId === fullFirstGlobalTagId}
            interactive={interactive}
            onToggleTag={onToggleTag}
            chipRef={getChipRef(Number(row.tagId))}
          />
        ))}
        {botPrompt}
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
        <ExpandLessIcon className="message-card-tag-expand__icon" aria-hidden />
      ) : (
        <ExpandMoreIcon className="message-card-tag-expand__icon" aria-hidden />
      )}
    </button>
  ) : null;

  if (!hasRest) {
    return (
      <div
        ref={compactMeasureRef}
        data-message-card-tags="true"
        className="flex w-full min-w-0 flex-nowrap items-start gap-2 overflow-hidden"
      >
        {compactOrderedRows.map((row) => (
          <MessageCardTagChip
            key={row.tagId}
            row={row}
            showGroupDivider={row.tagId === compactFirstGlobalTagId}
            interactive={interactive}
            onToggleTag={onToggleTag}
            chipRef={getChipRef(Number(row.tagId))}
          />
        ))}
        {botPrompt}
      </div>
    );
  }

  if (showCompactRest) {
    return (
      <div
        ref={compactMeasureRef}
        data-message-card-tags="true"
        className="flex w-full min-w-0 flex-wrap items-start gap-2"
      >
        {compactOrderedRows.map((row) => (
          <MessageCardTagChip
            key={row.tagId}
            row={row}
            showGroupDivider={row.tagId === compactFirstGlobalTagId}
            interactive={interactive}
            onToggleTag={onToggleTag}
            chipRef={getChipRef(Number(row.tagId))}
          />
        ))}
        {expandToggleButton}
        {botPrompt}
      </div>
    );
  }

  return (
    <div
      ref={compactMeasureRef}
      data-message-card-tags="true"
      className="flex w-full min-w-0 flex-col gap-y-1.5"
    >
      <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <div className="flex min-h-6 min-w-0 flex-1 items-center gap-2 overflow-x-hidden">
          {row1Chips.map((row) => (
            <MessageCardTagChip
              key={row.tagId}
              row={row}
              showGroupDivider={row.tagId === compactFirstGlobalTagId}
              interactive={interactive}
              onToggleTag={onToggleTag}
              chipRef={getChipRef(Number(row.tagId))}
            />
          ))}
        </div>
        <div className="message-card-tag-expand-wrapper shrink-0 justify-self-end">
          {expandToggleButton}
        </div>
      </div>
      {botPrompt}
    </div>
  );
}

export const MessageCardTags = memo(MessageCardTagsComponent);
