import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { Box, LinearProgress } from '@mui/material';
import { useLayoutEffect, useRef } from 'react';
import dayjs from 'dayjs';
import { PowerIconButton } from '../../components/PowerIconButton';
import { PowerButton } from '../../components/PowerButton';
import { APP_TIME_ZONE } from '../../utils/misc';
import { DutySearchControls } from './DutySearchControls';
import { dutyFeedPanelSurfaceSx } from './feed-panel-styles';
import type { DutySearchColumn } from './useDutySearch';
import type { FeedColumnModel } from './types';
import type { InboxMessage } from '../../../../Bindings';
import { buildMessageCardDisplayLabels } from '../shared/message-card/message-card-labels';
import '../../components/selectable-list.css';

type ResultLabels = Pick<FeedColumnModel['messageCard'], 'groupInfos' | 'profiles'>;

function resultPreview(message: InboxMessage, query: string) {
  const text = message.text || 'Повідомлення без тексту';
  const terms = [
    ...new Set([
      ...(message.textMarked ?? []).flatMap((node) =>
        typeof node !== 'string' && 'CNHighlightC' in node ? [node.CNHighlightC.text] : [],
      ),
      ...query.split(/\s+/).filter((term) => term && !/^(and|or)$/i.test(term)),
    ]),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const pattern = terms.length
    ? new RegExp(
        `(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
        'giu',
      )
    : null;
  const match = pattern?.exec(text);
  const start = Math.max(0, (match?.index ?? 0) - 24);
  const snippet = `${start ? '…' : ''}${text
    .slice(start, start + 320)
    .replace(/\s+/g, ' ')
    .trim()}${text.length > start + 320 ? '…' : ''}`;
  return pattern ? (
    snippet.split(pattern).map((part, index) =>
      index % 2 ? (
        <strong key={index} className="font-semibold text-echo-text">
          {part}
        </strong>
      ) : (
        <span key={index} className="opacity-85">
          {part}
        </span>
      ),
    )
  ) : (
    <span className="opacity-85">{snippet}</span>
  );
}

function DutySearchResult({
  item,
  search,
  groupInfos,
  profiles,
}: ResultLabels & {
  item: [number, InboxMessage];
  search: DutySearchColumn;
}) {
  const [id, message] = item;
  const labels = buildMessageCardDisplayLabels(message, { groupInfos, profiles });
  const created = dayjs(message.createdAt).tz(APP_TIME_ZONE);
  return (
    <button
      type="button"
      data-duty-search-result={id}
      aria-label={message.text || 'Повідомлення без тексту'}
      aria-pressed={search.state.selectedId === id}
      data-selected={search.state.selectedId === id ? 'true' : 'false'}
      className="echo-selectable-list-item relative block w-full shrink-0 cursor-pointer text-left"
      onClick={() => search.onSelect(item)}
    >
      <span className="flex min-w-0 items-center gap-echo-sm leading-[18px]">
        {labels.groupName ? (
          <span
            data-duty-search-result-group
            className="min-w-0 flex-1 truncate text-[length:var(--echo-typography-font-size-sm)] font-medium"
            title={labels.groupName}
          >
            {labels.groupName}
          </span>
        ) : null}
        <time
          dateTime={created.toISOString()}
          className="ml-auto w-[88px] shrink-0 text-right text-[length:var(--echo-typography-font-size-xs)] whitespace-nowrap opacity-65"
        >
          {created.format('DD.MM, HH:mm')}
        </time>
      </span>
      {labels.senderName ? (
        <span
          data-duty-search-result-sender
          className="block truncate text-[length:var(--echo-typography-font-size-sm)] leading-[18px] opacity-75"
          title={labels.senderName}
        >
          {labels.senderName}
        </span>
      ) : null}
      <span className="mt-echo-xs line-clamp-2 text-[length:var(--echo-typography-font-size-base)] leading-[20px] break-words">
        {resultPreview(message, search.state.search)}
      </span>
    </button>
  );
}

export function DutySearchPanel({
  search,
  groupInfos,
  profiles,
}: { search: DutySearchColumn } & ResultLabels) {
  const { state } = search;
  const listRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const selectedIndex = state.items.findIndex(([id]) => id === state.selectedId);
  const rememberPosition = () => {
    const list = listRef.current;
    if (!list) return;
    const top = list.getBoundingClientRect().top;
    const rows = list.querySelectorAll<HTMLElement>('[data-duty-search-result]');
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (rows[middle].offsetTop + rows[middle].offsetHeight <= list.scrollTop) low = middle + 1;
      else high = middle;
    }
    const anchors: typeof state.anchors = [];
    for (let index = low; index < Math.min(rows.length, low + 3); index += 1) {
      const row = rows[index];
      anchors.push({
        id: Number(row.dataset.dutySearchResult),
        offset: row.getBoundingClientRect().top - top,
      });
    }
    search.onScroll(list.scrollTop, anchors);
  };
  const rememberPositionRef = useRef(rememberPosition);
  rememberPositionRef.current = rememberPosition;
  useLayoutEffect(
    () => () => {
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
      rememberPositionRef.current();
    },
    [],
  );
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const anchor = state.anchors.find(({ id }) =>
      list.querySelector(`[data-duty-search-result="${id}"]`),
    );
    if (anchor) {
      const row = list.querySelector<HTMLElement>(`[data-duty-search-result="${anchor.id}"]`)!;
      const bounds = list.getBoundingClientRect();
      const cssScale = bounds.width > 0 ? list.offsetWidth / bounds.width : 1;
      list.scrollTop += (row.getBoundingClientRect().top - bounds.top - anchor.offset) * cssScale;
    } else list.scrollTop = state.scrollTop;
    rememberPosition();
  }, [state.items]);
  const navigate = (index: number) => {
    const item = state.items[index];
    if (item) {
      search.onSelect(item);
      listRef.current
        ?.querySelector<HTMLElement>(`[data-duty-search-result="${item[0]}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
  };
  return (
    <Box
      component="section"
      aria-label="Пошук у стрічці"
      data-duty-search-panel
      className="flex h-full w-full min-h-0 min-w-0 flex-col text-echo-text"
      sx={dutyFeedPanelSurfaceSx}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          search.onClose();
        }
      }}
    >
      <div className="shrink-0 border-b border-solid border-echo-text/15 p-echo-md">
        <DutySearchControls queryState={state} updateQueryState={search.onChange} autoFocus panel />
        <div className="mt-echo-sm flex items-center justify-between gap-echo-xs">
          <span
            className="text-[length:var(--echo-typography-font-size-sm)] opacity-75"
            aria-live="polite"
          >
            {state.total === null ? 'Результати' : `Знайдено: ${state.total}`}
          </span>
          <div className="flex items-center">
            <PowerIconButton
              size="small"
              aria-label="Попередній результат"
              disabled={selectedIndex <= 0}
              onClick={() => navigate(selectedIndex - 1)}
            >
              <ArrowUpwardIcon fontSize="small" />
            </PowerIconButton>
            <PowerIconButton
              size="small"
              aria-label="Наступний результат"
              disabled={state.items.length === 0 || selectedIndex >= state.items.length - 1}
              onClick={() => navigate(selectedIndex + 1)}
            >
              <ArrowDownwardIcon fontSize="small" />
            </PowerIconButton>
          </div>
        </div>
      </div>
      {state.loading || state.loadingOlder ? (
        <LinearProgress aria-label="Завантаження результатів пошуку" />
      ) : null}
      {state.pendingItems.length > 0 ? (
        <PowerButton
          size="small"
          onClick={() => {
            search.onShowNew();
            if (listRef.current) listRef.current.scrollTop = 0;
          }}
        >
          Нові результати: {state.pendingItems.length}
        </PowerButton>
      ) : null}
      <div
        ref={listRef}
        data-duty-search-list
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-echo-xs pb-echo-xs"
        onScroll={() => {
          if (scrollFrameRef.current !== null) return;
          scrollFrameRef.current = requestAnimationFrame(() => {
            scrollFrameRef.current = null;
            rememberPositionRef.current();
          });
        }}
      >
        {!state.search.trim() ? <p className="p-echo-sm">Введіть запит для пошуку</p> : null}
        {state.search.trim() &&
        state.total === 0 &&
        state.items.length === 0 &&
        !state.loading &&
        !state.error ? (
          <p className="p-echo-sm">Нічого не знайдено</p>
        ) : null}
        <div className="shrink-0 divide-y divide-solid divide-echo-text/15">
          {state.items.map((item) => (
            <div key={item[0]} className="py-echo-xs">
              <DutySearchResult
                item={item}
                search={search}
                groupInfos={groupInfos}
                profiles={profiles}
              />
            </div>
          ))}
        </div>
        {state.hasMore ? (
          <PowerButton
            fullWidth
            disabled={state.loading || state.loadingOlder}
            onClick={search.onLoadOlder}
          >
            Завантажити ще результати
          </PowerButton>
        ) : null}
      </div>
    </Box>
  );
}
