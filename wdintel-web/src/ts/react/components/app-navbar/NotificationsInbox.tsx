import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';
import {
  Alert,
  Badge,
  Button,
  CircularProgress,
  Popover,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import dayjs from 'dayjs';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NotificationItem } from '../../../../Bindings';
import { getSummaryDisplayText } from '../../routes/shared/message-card/MessageCardIntelligenceReports';
import { buildMessageLinkHref } from '../../routes/shared/message-card/message-card.utils';
import { APP_TIME_ZONE } from '../../utils/misc';
import {
  listNotifications,
  NOTIFICATION_POLL_INTERVAL_MS,
  notificationUnreadCount,
  readAllNotifications,
  readNotification,
} from '../../services/api/notifications';
import { useOptionalPowerSnackbar } from '../PowerSnackbar';
import { NavbarToolbarIconButton } from './NavbarToolbarIconButton';

function notificationTime(createdAt: number) {
  const value = dayjs(createdAt).tz(APP_TIME_ZONE);
  return value.isSame(dayjs().tz(APP_TIME_ZONE), 'day')
    ? value.format('HH:mm')
    : value.format('DD.MM.YYYY HH:mm');
}

function avatarColor(actorId: string) {
  let hash = 0;
  for (const character of actorId) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 45% 42%)`;
}

function notificationSummaryText(item: NotificationItem) {
  return getSummaryDisplayText({
    id: item.quote.messageId,
    isAccessible: true,
    isDeleted: false,
    text: item.quote.text,
    attachmentsCount: item.quote.attachmentsCount,
    timestamp: null,
    date: null,
    time: null,
    isTimeNull: null,
    groupName: item.groupName,
    groupMasterKey: null,
    coords: item.quote.coords,
    mediaFileNames: item.quote.mediaFileNames,
  });
}

function notificationQuoteText(item: NotificationItem) {
  const lines = item.quote.text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return notificationSummaryText(item);

  const previewLines = lines.slice(0, 3);
  if (lines.length > previewLines.length) {
    const lastIndex = previewLines.length - 1;
    previewLines[lastIndex] = `${previewLines[lastIndex]} …`;
  }
  return previewLines.join('\n');
}

function unreadCountLabel(count: number) {
  return count > 99 ? '99+' : String(count);
}

function loadErrorMessage(error: unknown) {
  const details = error instanceof Error ? error.message : null;
  return details
    ? `Не вдалося оновити Вхідні: ${details}`
    : 'Не вдалося оновити Вхідні. Спробуйте ще раз.';
}

type ErrorSource = 'count' | 'list' | 'mutation';

export function NotificationsInbox({ identity }: { identity: string }) {
  const theme = useTheme();
  const { notify } = useOptionalPowerSnackbar();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const mutationVersion = useRef(0);
  const listResponseVersion = useRef(0);
  const countVersion = useRef(0);
  const listRequestVersion = useRef(0);
  const identityVersion = useRef(0);
  const wasHidden = useRef(false);
  const panelId = useRef(crypto.randomUUID());
  const openRef = useRef(false);
  const boundaryRef = useRef<string | null>(null);
  const readingReceiptIds = useRef(new Set<string>());
  const pendingCountMutations = useRef(0);
  const lastNotifiedError = useRef<string | null>(null);
  const errorSource = useRef<ErrorSource | null>(null);
  const itemsRef = useRef<NotificationItem[]>([]);
  const reconciliationOffset = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [boundary, setBoundary] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState<'refresh' | 'more' | null>(null);
  const [hasLoadedList, setHasLoadedList] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listViewportHeight, setListViewportHeight] = useState<number | null>(null);
  const showError = (
    source: ErrorSource,
    message: string,
    severity: 'error' | 'warning' = 'error',
  ) => {
    errorSource.current = source;
    setError(message);
    if (lastNotifiedError.current === message) return;
    lastNotifiedError.current = message;
    notify({ severity, message });
  };
  const clearError = (source?: ErrorSource) => {
    if (source && errorSource.current !== source) return;
    errorSource.current = null;
    setError(null);
    lastNotifiedError.current = null;
  };
  const updateItems = (updater: (current: NotificationItem[]) => NotificationItem[]) => {
    setItems((current) => {
      const next = updater(current);
      itemsRef.current = next;
      return next;
    });
  };

  const refreshCount = async () => {
    if (pendingCountMutations.current > 0) return;
    const version = identityVersion.current;
    const requestVersion = ++countVersion.current;
    try {
      const count = await notificationUnreadCount();
      if (
        version === identityVersion.current &&
        requestVersion === countVersion.current &&
        pendingCountMutations.current === 0
      ) {
        setUnreadCount(count);
        clearError('count');
      }
    } catch (requestError) {
      if (version !== identityVersion.current || requestVersion !== countVersion.current) return;
      const message = loadErrorMessage(requestError);
      showError('count', message);
    }
  };
  const refreshList = async (preserveError = false) => {
    const identityRequestVersion = identityVersion.current;
    const version = mutationVersion.current;
    const responseVersion = listResponseVersion.current;
    const requestVersion = ++listRequestVersion.current;
    const knownItems = itemsRef.current;
    const knownStart = knownItems.length ? reconciliationOffset.current % knownItems.length : 0;
    const knownReceiptIds = [...knownItems.slice(knownStart), ...knownItems.slice(0, knownStart)]
      .slice(0, 100)
      .map((item) => item.receiptId);
    reconciliationOffset.current = knownItems.length
      ? (knownStart + knownReceiptIds.length) % knownItems.length
      : 0;
    setLoading('refresh');
    try {
      const response = await listNotifications({
        cursor: null,
        boundaryId: boundaryRef.current,
        panelId: panelId.current,
        knownReceiptIds,
      });
      if (
        identityRequestVersion !== identityVersion.current ||
        version !== mutationVersion.current ||
        responseVersion !== listResponseVersion.current ||
        requestVersion !== listRequestVersion.current
      )
        return;
      setHasLoadedList(true);
      updateItems((current) => {
        if (response.items.length === 0) return [];
        const refreshed = new Set(response.items.map((item) => item.receiptId));
        const removed = new Set(response.removedReceiptIds ?? []);
        return [
          ...response.items,
          ...current.filter(
            (item) => !refreshed.has(item.receiptId) && !removed.has(item.receiptId),
          ),
        ].sort(
          (left, right) =>
            right.createdAt - left.createdAt || right.eventId.localeCompare(left.eventId),
        );
      });
      if (pendingCountMutations.current === 0) setUnreadCount(response.unreadCount);
      setBoundary(response.markAllBoundary);
      boundaryRef.current = response.markAllBoundary;
      setNextCursor(response.nextCursor);
      if (!preserveError && errorSource.current !== 'count') clearError();
    } catch (requestError) {
      if (
        identityRequestVersion !== identityVersion.current ||
        version !== mutationVersion.current ||
        responseVersion !== listResponseVersion.current ||
        requestVersion !== listRequestVersion.current
      )
        return;
      const message = loadErrorMessage(requestError);
      showError('list', message);
    } finally {
      if (
        identityRequestVersion === identityVersion.current &&
        version === mutationVersion.current &&
        requestVersion === listRequestVersion.current
      ) {
        setLoading(null);
      }
    }
  };
  useEffect(() => {
    identityVersion.current += 1;
    listRequestVersion.current += 1;
    updateItems(() => []);
    reconciliationOffset.current = 0;
    setBoundary(null);
    boundaryRef.current = null;
    setNextCursor(null);
    setUnreadCount(null);
    clearError();
    setLoading(null);
    setHasLoadedList(false);
    readingReceiptIds.current.clear();
    void refreshCount();
  }, [identity]);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      if (openRef.current) void refreshList();
      else void refreshCount();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        wasHidden.current = true;
      } else if (wasHidden.current) {
        wasHidden.current = false;
        refresh();
      }
    };
    const onFocus = () => {
      if (wasHidden.current) wasHidden.current = false;
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const timer = window.setInterval(refresh, NOTIFICATION_POLL_INTERVAL_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(timer);
    };
  }, [identity]);
  useEffect(() => {
    if (open) void refreshList();
  }, [open, identity]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !list || items.length === 0) return;

    let frame = 0;
    const measure = () => {
      const rows = Array.from(
        list.querySelectorAll<HTMLElement>('[data-testid="notification-inbox-item"]'),
      ).slice(0, 3);
      if (rows.length === 0) return;

      const preferredHeight = rows.reduce((height, row) => height + row.offsetHeight, 0);
      if (preferredHeight <= 0) return;
      const availableHeight = Math.floor(window.innerHeight - list.getBoundingClientRect().top - 8);
      if (availableHeight <= 0) return;
      const nextHeight = Math.min(Math.ceil(preferredHeight), availableHeight);
      setListViewportHeight((current) =>
        current != null && Math.abs(current - nextHeight) < 1 ? current : nextHeight,
      );
    };
    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(list);
    for (const row of list.querySelectorAll<HTMLElement>(
      '[data-testid="notification-inbox-item"]',
    )) {
      resizeObserver?.observe(row);
    }
    window.addEventListener('resize', scheduleMeasure);
    measure();
    const delayedMeasure = window.setTimeout(scheduleMeasure, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(delayedMeasure);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, [items, open]);
  const onOpenItem = async (item: NotificationItem) => {
    const identityRequestVersion = identityVersion.current;
    if (item.readAt != null || markingAll || readingReceiptIds.current.has(item.receiptId)) return;
    readingReceiptIds.current.add(item.receiptId);
    listResponseVersion.current += 1;
    pendingCountMutations.current += 1;
    countVersion.current += 1;
    try {
      await readNotification({ receiptId: item.receiptId });
      if (identityRequestVersion !== identityVersion.current) return;
      listResponseVersion.current += 1;
      updateItems((current) =>
        current.map((entry) =>
          entry.receiptId === item.receiptId ? { ...entry, readAt: Date.now() } : entry,
        ),
      );
    } catch (requestError) {
      if (identityRequestVersion !== identityVersion.current) return;
      const message =
        requestError instanceof Error
          ? requestError.message
          : 'Не вдалося позначити згадку прочитаною.';
      showError('mutation', message);
    } finally {
      readingReceiptIds.current.delete(item.receiptId);
      pendingCountMutations.current = Math.max(0, pendingCountMutations.current - 1);
      if (pendingCountMutations.current === 0) void refreshCount();
    }
  };
  const markAll = async () => {
    if (!boundary) return;
    const identityRequestVersion = identityVersion.current;
    const version = ++mutationVersion.current;
    listResponseVersion.current += 1;
    pendingCountMutations.current += 1;
    countVersion.current += 1;
    setMarkingAll(true);
    try {
      const response = await readAllNotifications({ boundaryReceiptId: boundary });
      if (identityRequestVersion !== identityVersion.current || version !== mutationVersion.current)
        return;
      if (response.outcome === 'NotificationReadAllBoundaryExpired') {
        setBoundary(null);
        boundaryRef.current = null;
        const message =
          'Вхідні змінилися, тому позначення всіх згадок не виконано. Оновіть список.';
        showError('mutation', message, 'warning');
        void refreshList(true);
        return;
      }
      setUnreadCount(response.unreadCount);
      const receiptIds = new Set(response.receiptIds);
      updateItems((current) =>
        current.map((item) =>
          receiptIds.has(item.receiptId) ? { ...item, readAt: item.readAt ?? Date.now() } : item,
        ),
      );
      setBoundary(null);
      boundaryRef.current = null;
      listResponseVersion.current += 1;
    } catch (requestError) {
      if (identityRequestVersion !== identityVersion.current || version !== mutationVersion.current)
        return;
      const message =
        requestError instanceof Error
          ? requestError.message
          : 'Не вдалося позначити згадки прочитаними.';
      showError('mutation', message);
    } finally {
      if (
        identityRequestVersion === identityVersion.current &&
        version === mutationVersion.current
      ) {
        setMarkingAll(false);
      }
      pendingCountMutations.current -= 1;
    }
  };
  const loadMore = async () => {
    if (!nextCursor || loading) return;
    const identityRequestVersion = identityVersion.current;
    const version = mutationVersion.current;
    const responseVersion = listResponseVersion.current;
    const requestVersion = ++listRequestVersion.current;
    setLoading('more');
    try {
      const response = await listNotifications({
        cursor: nextCursor,
        boundaryId: null,
        panelId: panelId.current,
        knownReceiptIds: [],
      });
      if (
        identityRequestVersion !== identityVersion.current ||
        version !== mutationVersion.current ||
        responseVersion !== listResponseVersion.current ||
        requestVersion !== listRequestVersion.current
      )
        return;
      updateItems((current) => {
        const existing = new Set(current.map((item) => item.receiptId));
        return [...current, ...response.items.filter((item) => !existing.has(item.receiptId))];
      });
      setNextCursor(response.nextCursor);
      if (pendingCountMutations.current === 0) setUnreadCount(response.unreadCount);
    } catch (requestError) {
      if (
        identityRequestVersion !== identityVersion.current ||
        version !== mutationVersion.current ||
        responseVersion !== listResponseVersion.current ||
        requestVersion !== listRequestVersion.current
      )
        return;
      const message =
        requestError instanceof Error ? requestError.message : 'Не вдалося завантажити згадки.';
      showError('list', message);
    } finally {
      if (
        identityRequestVersion === identityVersion.current &&
        version === mutationVersion.current &&
        requestVersion === listRequestVersion.current
      ) {
        setLoading(null);
      }
    }
  };
  const count = unreadCount ?? 0;
  const countLabel = unreadCountLabel(count);
  const retry = () => {
    if (errorSource.current === 'count') {
      void refreshCount();
    } else {
      void refreshList();
    }
  };
  return (
    <>
      <Tooltip title="Вхідні">
        <NavbarToolbarIconButton
          ref={buttonRef}
          color="inherit"
          aria-label="Вхідні"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Badge
            badgeContent={countLabel}
            color="warning"
            invisible={count === 0}
            sx={{
              '& .MuiBadge-badge': {
                backgroundColor: 'warning.main',
                color: 'warning.contrastText',
              },
            }}
          >
            <InboxOutlinedIcon sx={{ fontSize: 24 }} />
          </Badge>
        </NavbarToolbarIconButton>
      </Tooltip>
      <Popover
        open={open}
        transitionDuration={0}
        anchorEl={buttonRef.current}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <section
          className="bg-(--color-card)"
          aria-label="Вхідні"
          style={{ width: 'min(480px, calc(100vw - 16px))' }}
        >
          <header className="flex items-center justify-between gap-2 border-b border-(--color-border) p-[16px]">
            <div className="flex min-w-0 items-center gap-3">
              <h2
                className="m-0 text-[var(--color-text)]"
                style={{ fontSize: '16px', fontWeight: 400, lineHeight: '24px' }}
              >
                Вхідні
              </h2>
              {count > 0 ? (
                <span
                  className="inline-flex min-w-[28px] items-center justify-center rounded-full px-[4px] py-[4px] text-[14px] font-normal leading-5"
                  style={{
                    backgroundColor: theme.palette.warning.main,
                    color: theme.palette.warning.contrastText,
                  }}
                >
                  {countLabel}
                </span>
              ) : null}
            </div>
            <Button
              size="small"
              disabled={count === 0 || markingAll || !boundary}
              onClick={() => void markAll()}
              sx={(theme) => ({
                minWidth: 0,
                textAlign: 'right',
                whiteSpace: 'nowrap',
                '&.Mui-disabled, &.Mui-disabled:hover': {
                  backgroundColor: 'transparent',
                  boxShadow: 'none',
                  color: theme.palette.action.disabled,
                },
                '&.Mui-disabled .MuiTouchRipple-root': {
                  display: 'none',
                },
              })}
            >
              Позначити всі як прочитані
            </Button>
          </header>
          {error ? (
            <Alert
              severity="error"
              className="m-3"
              action={
                <Button color="inherit" size="small" onClick={retry}>
                  Повторити
                </Button>
              }
            >
              {error}
            </Alert>
          ) : null}
          {count === 0 && items.length > 0 ? (
            <Typography component="p" color="text.secondary" className="m-4 text-sm">
              Немає непрочитаних згадок
            </Typography>
          ) : null}
          {loading === 'refresh' && !hasLoadedList ? (
            <div className="flex justify-center p-6">
              <CircularProgress size={24} />
            </div>
          ) : items.length === 0 ? (
            error ? null : (
              <Typography component="p" color="text.secondary" className="m-4">
                Поки що немає згадок. Тут з’являтимуться повідомлення, у яких вас згадали.
              </Typography>
            )
          ) : (
            <div
              ref={listRef}
              className="overflow-y-auto"
              data-testid="notification-list"
              style={listViewportHeight == null ? undefined : { maxHeight: listViewportHeight }}
              onScroll={(event) => {
                const node = event.currentTarget;
                if (node.scrollTop + node.clientHeight >= node.scrollHeight - 96) void loadMore();
              }}
            >
              {items.map((item) => (
                <a
                  key={item.receiptId}
                  data-testid="notification-inbox-item"
                  className={`flex gap-3 border-b border-(--color-border) !p-[16px] no-underline hover:bg-black/5 dark:hover:bg-white/5 ${item.readAt == null ? 'bg-[var(--color-bg-muted)]' : ''}`}
                  href={buildMessageLinkHref(item.quote, 'analysis', item.quote.messageId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    void onOpenItem(item);
                  }}
                  onAuxClick={(event) => {
                    if (event.button === 1) void onOpenItem(item);
                  }}
                >
                  <span
                    className="flex !h-[32px] !w-[32px] shrink-0 items-center justify-center rounded-full text-[16px] text-white"
                    style={{ backgroundColor: avatarColor(item.actorId) }}
                  >
                    {(item.actorLogin ?? '?').slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1" style={{ color: theme.palette.text.primary }}>
                    <span className="flex justify-between gap-2">
                      <span
                        className="truncate text-[14px] leading-[20px]"
                        data-testid="notification-mention"
                        title={`${item.actorLogin ?? 'Невідомий'} згадав вас у групі ${item.groupName}`}
                      >
                        <span className="font-medium">{item.actorLogin ?? 'Невідомий'}</span>
                        <span style={{ color: theme.palette.text.secondary }}>
                          {' згадав вас у групі '}
                        </span>
                        <span className="font-medium">{item.groupName}</span>
                      </span>
                      <time
                        className="flex shrink-0 items-center gap-[8px] text-xs font-normal leading-5"
                        style={{ color: theme.palette.text.secondary }}
                        title={dayjs(item.createdAt).tz(APP_TIME_ZONE).format('DD.MM.YYYY HH:mm')}
                      >
                        {notificationTime(item.createdAt)}
                        {item.readAt == null ? (
                          <span
                            className="size-2 rounded-full bg-[var(--color-action)]"
                            data-testid="notification-unread-dot"
                          />
                        ) : null}
                      </time>
                    </span>
                    <span
                      className="mt-2 block rounded border-l-2 px-[8px] py-[12px] text-sm font-normal leading-5"
                      style={{
                        backgroundColor: theme.palette.background.paper,
                        borderLeftColor:
                          item.readAt == null ? theme.palette.primary.dark : theme.palette.divider,
                        color: theme.palette.text.secondary,
                      }}
                    >
                      <span
                        className="line-clamp-3 whitespace-pre-wrap wrap-break-word overflow-hidden"
                        data-testid="notification-quote"
                      >
                        {notificationQuoteText(item)}
                      </span>
                    </span>
                  </span>
                </a>
              ))}
              {loading === 'more' ? (
                <div className="flex justify-center p-3">
                  <CircularProgress size={18} />
                </div>
              ) : null}
            </div>
          )}
        </section>
      </Popover>
    </>
  );
}
