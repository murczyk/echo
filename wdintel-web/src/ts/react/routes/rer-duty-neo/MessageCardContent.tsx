import { Box, Button, Tooltip } from '@mui/material';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ContentNode, InboxMessage, Network, Tag } from '../../../../Bindings';
import { PowerChip } from '../../components/PowerChip';
import {
  getPointEtalonsFromMessage,
  messageHasPalitraTag,
  messageRenderDistance,
  type TagsLayoutVariant,
} from './utils';
import { renderMarkedText } from './MarkedText';

function networkNeedsInvestigationBadge(network: Network | undefined): boolean {
  if (network == null) return false;
  const ids = network.unitIds;
  if (ids == null) return true;
  return ids.length === 0;
}

function ResolvedNetworkEtalonRows({
  networkIds,
  networkDisplayMap,
  networkMap,
}: {
  networkIds: number[];
  networkDisplayMap: Record<number, string>;
  networkMap: Record<number, Network>;
}) {
  return (
    <span className="flex flex-col gap-1 items-start w-full min-w-0">
      {networkIds.map((networkId) => {
        const network = networkMap[networkId];
        const label = networkDisplayMap[networkId] ?? (network != null ? `р/м ${network.name}` : 'Невідома мережа');
        const badge = networkNeedsInvestigationBadge(network);
        const hasNetworkLink = network != null;
        return (
          <span key={networkId} className="flex items-center gap-1 group w-full min-w-0">
            <span className="min-w-0">
              <span className="inline-grid shrink-0 mr-1 place-items-start" title="Еталонна прив'язка">
                <i className="bi bi-people text-icons col-start-1 row-start-1 group-hover:hidden" aria-hidden />
                <i
                  className="bi bi-people-fill text-icons col-start-1 row-start-1 hidden group-hover:inline"
                  aria-hidden
                />
              </span>

              {badge ? (
                <span className="ml-1 shrink-0 rounded border border-border bg-[var(--color-bg-inactive)] px-1.5 py-0.5 text-[10px] leading-none opacity-90">
                  в дорозвідці
                </span>
              ) : null}
              {hasNetworkLink ? (
                <a
                  href={`/rer-networks/${networkId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="items-baseline gap-1 min-w-0 cursor-pointer shrink-0"
                  title="Відкрити мережу в новій вкладці"
                >
                  <span className="min-w-0 break-words font-bold">{label}</span>
                  <i
                    className="bi bi-box-arrow-up-right text-sm ml-1 shrink-0 text-icons/60 transition-[color,transform] duration-150 group-hover:text-action group-hover:scale-110"
                    aria-hidden
                  />
                </a>
              ) : (
                <span className="min-w-0 break-words font-normal">{label}</span>
              )}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function NetworkSection({
  networkIds,
  networkDisplayMap,
  networkMap,
  etalonNoNetworkLabel,
}: {
  networkIds: number[];
  networkDisplayMap: Record<number, string>;
  networkMap: Record<number, Network>;
  etalonNoNetworkLabel: string | null;
}) {
  return (
    <>
      {networkIds.length > 0 ? (
        <ResolvedNetworkEtalonRows
          networkIds={networkIds}
          networkDisplayMap={networkDisplayMap}
          networkMap={networkMap}
        />
      ) : etalonNoNetworkLabel != null ? (
        <span className="inline-flex items-center gap-1">
          <i className="bi bi-people text-icons shrink-0 mt-0.5" title="Еталонна прив'язка" />
          <span className="ml-1">{etalonNoNetworkLabel}</span>
        </span>
      ) : (
        <span className="flex items-center gap-1" aria-hidden>
          <i className="bi bi-people text-icons shrink-0 mt-0.5" title="Еталонна прив'язка" />
          <span aria-hidden>{' '}</span>
        </span>
      )}
    </>
  );
}

export function MessageCardWatermark({ authUserName }: { authUserName: string }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: '10%',
          top: '20%',
          transform: 'rotate(-28deg)',
          fontSize: 'clamp(1.5rem, 4vw, 2.25rem)',
          fontWeight: 600,
          opacity: 0.08,
          color: 'currentColor',
          whiteSpace: 'nowrap',
        }}
      >
        {authUserName}
      </span>
      <span
        style={{
          position: 'absolute',
          right: '5%',
          bottom: '15%',
          transform: 'rotate(-28deg)',
          fontSize: 'clamp(1.5rem, 4vw, 2.25rem)',
          fontWeight: 600,
          opacity: 0.08,
          color: 'currentColor',
          whiteSpace: 'nowrap',
        }}
      >
        {authUserName}
      </span>
    </div>
  );
}

const TAG_CHIP_GAP_PX = 4;
/** Reserve width for expand/collapse text button + chevron (collapsed row). */
const COMPACT_EXPAND_BTN_RESERVE_PX = 72;

function estimateTagChipWidthPx(label: string): number {
  return Math.min(180, Math.max(28, label.length * 6 + 24));
}

function MessageCardTagChips({
  msg,
  tagsMap,
  onToggleTag,
  tagsLayout,
}: {
  msg: InboxMessage;
  tagsMap: Record<number, Tag>;
  onToggleTag: (tagId: number) => void;
  tagsLayout: TagsLayoutVariant;
}) {
  const [showCompactRest, setShowCompactRest] = useState(false);
  const compactMeasureRef = useRef<HTMLDivElement | null>(null);
  const rows = useMemo(
    () =>
      Object.keys(tagsMap).map((tagId) => {
        const tag = tagsMap[tagId];
        const label = tag.label ?? `#${tagId}`;
        const inboxTagList = msg.inboxTags ?? [];
        const isSet =
          inboxTagList.length > 0
            ? inboxTagList.some((t) => t.tagId === Number(tagId))
            : (msg.tags ?? []).includes(Number(tagId));
        const contribs = inboxTagList.filter((t) => t.tagId === Number(tagId));
        const humanContribs = contribs.filter((t) => !t.model);
        const botContribs = contribs.filter((t) => t.model);
        const humanLogins = humanContribs.map((t) => t.login).filter(Boolean) as string[];
        const bots = botContribs.map((t) => `${t.model} (${Math.round((t.confidence ?? 0) * 100)}%)`);
        const tip =
          isSet &&
          (humanContribs.length > 0 || botContribs.length > 0) &&
          [
            ...(humanLogins.length > 0
              ? [`Користувачі: ${humanLogins.join(', ')}`]
              : humanContribs.length > 0
                ? ['Користувачі: (ваш вибір)']
                : []),
            ...(bots.length > 0 ? [`Боти: ${bots.join(', ')}`] : []),
          ].join('\n');
        const showBadge = isSet && (humanContribs.length > 0 || botContribs.length > 0);
        return {
          tagId,
          label,
          isSet,
          tip,
          showBadge,
          humanContribsLen: humanContribs.length,
          botContribsLen: botContribs.length,
        };
      }),
    [msg.inboxTags, msg.tags, tagsMap],
  );
  const selectedRows = useMemo(() => rows.filter((r) => r.isSet), [rows]);
  const unselectedRows = useMemo(() => rows.filter((r) => !r.isSet), [rows]);
  /** Selected first — packing fills the row by priority. */
  const compactOrderedRows = useMemo(() => [...selectedRows, ...unselectedRows], [selectedRows, unselectedRows]);

  const [firstRowCount, setFirstRowCount] = useState(() => compactOrderedRows.length);

  useLayoutEffect(() => {
    if (tagsLayout !== 'compact' || showCompactRest) return;
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

      let totalNoBtn = 0;
      for (let i = 0; i < packing.length; i++) {
        const add = (i > 0 ? TAG_CHIP_GAP_PX : 0) + estimateTagChipWidthPx(packing[i].label);
        if (totalNoBtn + add > w) {
          totalNoBtn = Infinity;
          break;
        }
        totalNoBtn += add;
      }
      if (totalNoBtn <= w) {
        setFirstRowCount((c) => (c === packing.length ? c : packing.length));
        return;
      }

      const btn = COMPACT_EXPAND_BTN_RESERVE_PX;
      let used = 0;
      let count = 0;
      for (let i = 0; i < packing.length; i++) {
        const add = (count > 0 ? TAG_CHIP_GAP_PX : 0) + estimateTagChipWidthPx(packing[i].label);
        if (used + add + btn > w) break;
        used += add;
        count++;
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

  const row1Chips = useMemo(() => compactOrderedRows.slice(0, firstRowCount), [compactOrderedRows, firstRowCount]);
  const row1IdSet = useMemo(() => new Set(row1Chips.map((r) => Number(r.tagId))), [row1Chips]);
  const restRows = useMemo(
    () => compactOrderedRows.filter((r) => !row1IdSet.has(Number(r.tagId))),
    [compactOrderedRows, row1IdSet],
  );
  const hasRest = restRows.length > 0;

  useEffect(() => {
    if (!hasRest) setShowCompactRest(false);
  }, [hasRest]);

  const renderOneChip = (row: (typeof rows)[0]) => {
    const botContribsLen = row.botContribsLen;
    const humanContribsLen = row.humanContribsLen;
    return (
      <Tooltip key={row.tagId} title={row.tip} placement="top">
        <Box component="span" className="relative inline-flex shrink-0 max-w-full">
          <PowerChip
            label={row.label}
            selected={row.isSet}
            onClick={() => onToggleTag(Number(row.tagId))}
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
              {botContribsLen > 0 && (
                <span className="flex items-center gap-0.5" title="Боти">
                  <i className="bi bi-robot" />
                  <span>{botContribsLen}</span>
                </span>
              )}
              {humanContribsLen > 0 && (
                <span className="flex items-center gap-0.5" title="Користувачі">
                  <i className="bi bi-person-fill" />
                  <span>{humanContribsLen}</span>
                </span>
              )}
            </span>
          )}
        </Box>
      </Tooltip>
    );
  };

  if (tagsLayout !== 'compact') {
    return <Box className="flex flex-wrap gap-1">{rows.map((row) => renderOneChip(row))}</Box>;
  }

  const expandToggleButton = hasRest ? (
    <Button
      size="small"
      color="primary"
      variant="text"
      onClick={() => setShowCompactRest((v) => !v)}
      aria-expanded={showCompactRest}
      aria-label={showCompactRest ? 'Згорнути додаткові теги' : 'Показати додаткові теги'}
      endIcon={<i className={showCompactRest ? 'bi bi-chevron-up' : 'bi bi-chevron-down'} aria-hidden />}
      sx={{
        flexShrink: 0,
        minHeight: 27,
        py: 0,
        px: 0.5,
        fontSize: '0.875rem',
        fontWeight: 400,
        textTransform: 'none',
        '& .MuiButton-endIcon': { ml: 1, mr: 0, '& i': { fontSize: '0.875rem' } },
      }}
    >
      {showCompactRest ? 'згорнути' : 'розгорнути'}
    </Button>
  ) : null;

  if (showCompactRest && hasRest) {
    return (
      <Box className="flex w-full min-w-0 flex-wrap items-start gap-1">
        {compactOrderedRows.map((row) => renderOneChip(row))}
        {expandToggleButton}
      </Box>
    );
  }

  if (!hasRest) {
    return (
      <Box ref={compactMeasureRef} className="flex w-full min-w-0 flex-wrap gap-1">
        {compactOrderedRows.map((row) => renderOneChip(row))}
      </Box>
    );
  }

  return (
    <Box ref={compactMeasureRef} className="w-full min-w-0">
      <Box className="flex w-full min-w-0 items-center gap-1">
        <Box className="flex min-h-[27px] min-w-0 flex-1 items-center gap-1">
          {row1Chips.map((row) => renderOneChip(row))}
        </Box>
        <Box sx={{ flexShrink: 0, alignSelf: 'flex-center' }}>{expandToggleButton}</Box>
      </Box>
    </Box>
  );
}

export function MessageCardEtalonLocationTime({
  networkIds,
  networkDisplayMap,
  networkMap,
  etalonNoNetworkLabel,
  msg,
  relativeTimeMs,
}: {
  networkIds: number[];
  networkDisplayMap: Record<number, string>;
  networkMap: Record<number, Network>;
  etalonNoNetworkLabel: string | null;
  msg: InboxMessage;
  relativeTimeMs: number | null;
}) {
  return (
    <div className="inline-flex gap-x-3">
      <div className="flex flex-col items-baseline gap-x-2 gap-y-1">
        <span className="inline-flex shrink-1 items-start gap-1 w-full min-w-0">
          <NetworkSection
            networkIds={networkIds}
            networkDisplayMap={networkDisplayMap}
            networkMap={networkMap}
            etalonNoNetworkLabel={etalonNoNetworkLabel}
          />
        </span>
      </div>

      <span className="inline-flex break-words items-baseline gap-1 font-medium shrink-2">
        <i className="bi bi-geo text-icons shrink-0" title="Локація" />
        {msg.location ?? 'Не встановлена'}
      </span>
      {msg.timestamp != null && relativeTimeMs != null && (
        <div className="shrink-0 mr-0 ml-auto" style={{ color: 'var(--bs-secondary-color)' }}>
          {messageRenderDistance(msg.timestamp, relativeTimeMs)}
        </div>
      )}
    </div>
  );
}

export function MessageCardMessageBody({
  msg,
  tagsMap,
  onToggleTag,
  tagsLayout = 'full',
}: {
  msg: InboxMessage;
  tagsMap: Record<number, Tag>;
  onToggleTag: (tagId: number) => void;
  tagsLayout?: TagsLayoutVariant;
}) {
  const showPointLinks = messageHasPalitraTag(msg, tagsMap);
  const textPrimary =
    msg.textMarked && msg.textMarked.length > 0
      ? renderMarkedText(msg.textMarked, msg.text ?? '', getPointEtalonsFromMessage(msg, tagsMap), {
          showPointLinks,
        })
      : msg.text || '—';

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-5 min-w-0">
      <span className="whitespace-pre-wrap break-words text-marked min-w-0">{textPrimary}</span>
      {msg.extendedForm != null && msg.extendedForm.trim() !== '' && (
        <span className="inline-flex items-center gap-1 shrink-0" style={{ fontSize: '.75rem' }}>
          <i className="bi bi-chat-text text-icons shrink-0" title="Коментар" />
          <span className="font-semibold text-xs">{msg.extendedForm}</span>
        </span>
      )}
      {tagsLayout !== 'hidden' && (
        <span className="inline-flex flex-wrap gap-1 min-w-0 w-full">
          <MessageCardTagChips msg={msg} tagsMap={tagsMap} onToggleTag={onToggleTag} tagsLayout={tagsLayout} />
        </span>
      )}
    </div>
  );
}
