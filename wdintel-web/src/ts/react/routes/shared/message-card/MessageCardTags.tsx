import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import PersonOutlineOutlinedIcon from '@mui/icons-material/PersonOutlineOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Box, Button, Tooltip } from '@mui/material';

import type { InboxMessage, Tag } from '../../../../../Bindings';
import { PowerChip } from '../../../components/PowerChip';
import type { TagsLayoutVariant } from '../../rer-duty-neo/utils';
import { buildMessageCardTagRows } from './MessageCardTags.helpers';
import type { MessageCardTagRow } from './MessageCardTags.helpers';

const TAG_CHIP_GAP_PX = 4;
const COMPACT_EXPAND_BTN_RESERVE_PX = 116;
const COMPACT_LAST_CHIP_BADGE_OVERFLOW_PX = 44;
const TAG_CHIP_BADGE_TOP_PADDING_THEME = 1.75;

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
    if (tagsLayout === 'hidden') return;
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

      let domWraps = false;
      if (chipNodes.length > 1) {
        const firstTop = chipNodes[0].getBoundingClientRect().top;
        const lastTop = chipNodes[chipNodes.length - 1].getBoundingClientRect().top;
        if (lastTop > firstTop + 6) {
          domWraps = true;
        }
      }

      if (!domWraps && chipNodes.length === packing.length && chipNodes.length > 0) {
        setFirstRowCount(packing.length);
        return;
      }

      const nodeWidthMap = new Map<number, number>();
      chipNodes.forEach((node) => {
        const idStr = node.getAttribute('data-message-card-tag-id');
        if (idStr) {
          const rect = node.getBoundingClientRect();
          if (rect.width > 0) {
            nodeWidthMap.set(Number(idStr), rect.width);
          }
        }
      });

      const getWidth = (row: MessageCardTagRow) => {
        return (
          nodeWidthMap.get(Number(row.tagId)) ?? estimateTagChipWidthPx(row.label, row.showBadge)
        );
      };

      const btnNode = el.querySelector<HTMLElement>('button');
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
  }, [tagsLayout, compactOrderedRows]);

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
    if (!hasRest) setShowCompactRest(false);
  }, [hasRest]);

  const renderOneChip = (row: MessageCardTagRow) => (
    <Tooltip key={row.tagId} title={row.tip} placement="top">
      <Box
        component="span"
        data-message-card-tag-id={row.tagId}
        sx={{
          display: 'inline-flex',
          alignItems: 'flex-start',
          maxWidth: '100%',
          verticalAlign: 'top',
          pt: TAG_CHIP_BADGE_TOP_PADDING_THEME,
        }}
      >
        <Box component="span" className="relative inline-flex shrink-0 max-w-full">
          <PowerChip
            label={row.label}
            selected={row.isSet}
            interactive={interactive}
            onClick={interactive && onToggleTag ? () => onToggleTag(Number(row.tagId)) : undefined}
            size="small"
            fontSize="0.875rem"
            unselectedBackgroundColor="var(--color-background)"
            unselectedBorderColor="var(--text-color)"
            unselectedTextColor="var(--text-color)"
            selectedBackgroundColor="var(--color-tag-selected)"
            selectedBorderColor="var(--color-border-selected)"
            selectedTextColor="var(--neutral-900)"
          />
          {row.showBadge && (
            <span
              className="absolute -top-[12px] -right-1 flex items-center gap-1 text-[10px] bg-card border border-border rounded-full px-1.5 py-0.5 shadow-sm"
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
                  <PersonOutlineOutlinedIcon className="text-[11px]!" aria-hidden />
                  <span>{row.humanContribsLen}</span>
                </span>
              )}
            </span>
          )}
        </Box>
      </Box>
    </Tooltip>
  );

  const expandToggleButton = hasRest ? (
    <Button
      size="small"
      color="inherit"
      variant="text"
      onClick={() => setShowCompactRest((v) => !v)}
      aria-expanded={showCompactRest}
      aria-label={showCompactRest ? 'Згорнути додаткові теги' : 'Показати додаткові теги'}
      endIcon={
        showCompactRest ? (
          <ExpandLessIcon fontSize="inherit" aria-hidden />
        ) : (
          <ExpandMoreIcon fontSize="inherit" aria-hidden />
        )
      }
      sx={{
        flexShrink: 0,
        minHeight: 27,
        py: 0,
        px: 0.5,
        fontSize: '0.875rem',
        fontWeight: 400,
        textTransform: 'none',
        color: 'var(--color-action)',
        '& .MuiButton-endIcon': { ml: 1, mr: 0, '& i': { fontSize: '0.875rem' } },
      }}
    >
      {showCompactRest ? 'згорнути' : 'розгорнути'}
    </Button>
  ) : null;

  if (!hasRest) {
    return (
      <Box
        ref={compactMeasureRef}
        className="flex w-full min-w-0 flex-wrap items-start gap-x-1 gap-y-2.5"
      >
        {compactOrderedRows.map((row) => renderOneChip(row))}
      </Box>
    );
  }

  return (
    <Box ref={compactMeasureRef} className="flex w-full min-w-0 flex-col gap-y-1.5">
      <Box className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-1">
        <Box className="flex min-h-[27px] min-w-0 flex-1 items-center gap-1 overflow-x-hidden">
          {row1Chips.map((row) => renderOneChip(row))}
        </Box>
        <Box sx={{ flexShrink: 0, justifySelf: 'end', pt: TAG_CHIP_BADGE_TOP_PADDING_THEME }}>
          {expandToggleButton}
        </Box>
      </Box>
      {showCompactRest && (
        <Box className="flex w-full min-w-0 flex-wrap items-start gap-x-1 gap-y-2.5">
          {restRows.map((row) => renderOneChip(row))}
        </Box>
      )}
    </Box>
  );
}

export const MessageCardTags = memo(MessageCardTagsComponent);
