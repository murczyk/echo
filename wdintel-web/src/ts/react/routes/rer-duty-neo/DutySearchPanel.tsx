import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import RefreshIcon from '@mui/icons-material/Refresh';
import { IconButton, LinearProgress, linearProgressClasses, useTheme } from '@mui/material';
import { useEffect, useLayoutEffect, useRef } from 'react';
import dayjs from 'dayjs';
import { PowerButton } from '../../components/PowerButton';
import { APP_TIME_ZONE } from '../../utils/misc';
import { DutySearchControls } from './DutySearchControls';
import { useDutyResultAppearance } from './duty-panel-motion';
import { DUTY_SEARCH_PANEL_WIDTH_PX } from './duty-layout';
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
  fullWidth = false,
}: { search: DutySearchColumn; fullWidth?: boolean } & ResultLabels) {
  const theme = useTheme();
  const { state } = search;
  const autoFocus = !fullWidth || state.search.trim() === '';
  const listRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
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
  const identity = JSON.stringify([state.signature, state.search, state.searchMode, state.period]);
  useDutyResultAppearance(resultsRef, listRef, state.items, identity);
  useEffect(() => {
    if (search.open) {
      if (autoFocus)
        listRef.current?.closest('section')?.querySelector<HTMLInputElement>('input')?.focus();
    } else rememberPositionRef.current();
  }, [search.open, autoFocus]);
  useEffect(() => {
    if (!search.open) return;
    const onEscape = (event: KeyboardEvent) => {
      const trigger = listRef.current
        ?.closest('[data-duty-feed-column]')
        ?.querySelector('[id^="duty-search-trigger-"]');
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        (event.target === document.body || event.target === trigger)
      ) {
        event.preventDefault();
        search.onClose();
      }
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [search.open, search.onClose]);
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
    <section
      aria-label="Пошук у стрічці"
      data-duty-search-panel
      className="flex h-full w-full min-h-0 min-w-0 flex-col bg-none text-echo-text"
      style={{
        width: fullWidth ? '100%' : DUTY_SEARCH_PANEL_WIDTH_PX,
        flexShrink: 0,
        backgroundColor: theme.palette.background.paper,
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          search.onClose();
        }
      }}
    >
      <div className="relative shrink-0 border-b border-solid border-echo-text/15 p-echo-md">
        <DutySearchControls
          queryState={state}
          updateQueryState={search.onChange}
          autoFocus={autoFocus}
          panel
          blurOnEnter={fullWidth}
        />
        <div className="mt-echo-sm flex items-center justify-between gap-echo-xs">
          <div
            className="relative min-w-0 flex-1 text-[length:var(--echo-typography-font-size-sm)]"
            aria-live="polite"
          >
            <span className={state.pendingItems.length ? 'invisible' : 'opacity-75'}>
              {state.total === null ? 'Результати' : `Знайдено: ${state.total}`}
            </span>
            {state.pendingItems.length ? (
              <PowerButton
                className="duty-search-pending absolute! inset-y-0! left-0! max-w-full! min-w-0! normal-case! tabular-nums"
                size="small"
                title={`Знайдено: ${state.total ?? state.items.length + state.pendingItems.length}`}
                aria-label={`Нові результати: ${state.pendingItems.length}`}
                onClick={() => {
                  search.onShowNew();
                  if (listRef.current) listRef.current.scrollTop = 0;
                }}
              >
                <span className="truncate">Нові результати: {state.pendingItems.length}</span>
              </PowerButton>
            ) : null}
          </div>
          <div className="flex items-center">
            <IconButton
              size="small"
              aria-label="Оновити результати пошуку"
              title="Оновити результати пошуку"
              disabled={!state.search.trim() || state.loading || state.loadingOlder}
              onClick={search.onRefresh}
            >
              <RefreshIcon fontSize="small" />
            </IconButton>
            <IconButton
              size="small"
              aria-label="Попередній результат"
              disabled={selectedIndex <= 0}
              onClick={() => navigate(selectedIndex - 1)}
            >
              <ArrowUpwardIcon fontSize="small" />
            </IconButton>
            <IconButton
              size="small"
              aria-label="Наступний результат"
              disabled={state.items.length === 0 || selectedIndex >= state.items.length - 1}
              onClick={() => navigate(selectedIndex + 1)}
            >
              <ArrowDownwardIcon fontSize="small" />
            </IconButton>
          </div>
        </div>
        {state.loading || state.loadingOlder ? (
          <LinearProgress
            aria-label="Завантаження результатів пошуку"
            sx={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              '@media (prefers-reduced-motion: reduce)': {
                [`& .${linearProgressClasses.bar}`]: {
                  animation: 'none',
                  transform: 'none',
                  width: '50%',
                },
              },
            }}
          />
        ) : null}
      </div>
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
        {!state.search.trim() ? (
          <p className="m-0 px-echo-md py-echo-lg text-center text-echo-text/50">
            Введіть запит для пошуку
          </p>
        ) : null}
        {state.search.trim() &&
        state.total === 0 &&
        state.items.length === 0 &&
        !state.loading &&
        !state.error ? (
          <p className="p-echo-sm">Нічого не знайдено</p>
        ) : null}
        <div ref={resultsRef} className="shrink-0 divide-y divide-solid divide-echo-text/15">
          {state.items.map((item) => (
            <div key={item[0]} data-duty-search-row={item[0]} className="py-echo-xs">
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
    </section>
  );
}
