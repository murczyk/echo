import InboxIcon from '@mui/icons-material/Inbox';
import {
  Alert,
  Badge,
  Button,
  CircularProgress,
  IconButton,
  Popover,
  Tooltip,
} from '@mui/material';
import dayjs from 'dayjs';
import { useEffect, useRef, useState } from 'react';
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

function notificationQuoteText(item: NotificationItem) {
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

export function NotificationsInbox({ identity }: { identity: string }) {
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
  const itemsRef = useRef<NotificationItem[]>([]);
  const reconciliationOffset = useRef(0);
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [boundary, setBoundary] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      }
    } catch (requestError) {
      if (version !== identityVersion.current || requestVersion !== countVersion.current) return;
      const message =
        requestError instanceof Error ? requestError.message : 'Не вдалося завантажити Вхідні.';
      setError(message);
      notify({ severity: 'error', message });
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
    setLoading(true);
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
      if (!preserveError) setError(null);
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : 'Не вдалося завантажити Вхідні.';
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      if (
        identityRequestVersion === identityVersion.current &&
        version === mutationVersion.current &&
        requestVersion === listRequestVersion.current
      ) {
        setLoading(false);
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
    setError(null);
    setLoading(false);
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
      setError(message);
      notify({ severity: 'error', message });
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
        setError(message);
        notify({ severity: 'warning', message });
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
      setError(message);
      notify({ severity: 'error', message });
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
    setLoading(true);
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
      const message =
        requestError instanceof Error ? requestError.message : 'Не вдалося завантажити згадки.';
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      if (
        identityRequestVersion === identityVersion.current &&
        version === mutationVersion.current &&
        requestVersion === listRequestVersion.current
      ) {
        setLoading(false);
      }
    }
  };
  const count = unreadCount ?? 0;
  return (
    <>
      <Tooltip title="Вхідні">
        <IconButton
          ref={buttonRef}
          color="inherit"
          aria-label="Вхідні"
          onClick={() => setOpen((value) => !value)}
        >
          <Badge badgeContent={count} color="warning" invisible={count === 0}>
            <InboxIcon />
          </Badge>
        </IconButton>
      </Tooltip>
      <Popover
        open={open}
        anchorEl={buttonRef.current}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <section className="w-[min(32rem,calc(100vw-1rem))] bg-(--color-card)" aria-label="Вхідні">
          <header className="flex items-center justify-between border-b border-(--color-border) px-5 py-4">
            <h2 className="m-0 text-xl">Вхідні{count > 0 ? ` (${count})` : ''}</h2>
            <Button
              size="small"
              disabled={count === 0 || markingAll || !boundary}
              onClick={() => void markAll()}
            >
              Позначити всі як прочитані
            </Button>
          </header>
          {error ? (
            <Alert severity="error" className="m-3">
              {error}
            </Alert>
          ) : null}
          {count === 0 && items.length > 0 ? (
            <p className="m-4 text-sm text-(--color-text-secondary)">Немає непрочитаних згадок</p>
          ) : null}
          {loading && items.length === 0 ? (
            <div className="flex justify-center p-6">
              <CircularProgress size={24} />
            </div>
          ) : items.length === 0 ? (
            error ? null : (
              <p className="m-4 text-(--color-text-secondary)">
                Поки що немає згадок. Тут з’являтимуться повідомлення, у яких вас згадали.
              </p>
            )
          ) : (
            <div
              className="max-h-[min(60vh,19rem)] overflow-y-auto"
              onScroll={(event) => {
                const node = event.currentTarget;
                if (node.scrollTop + node.clientHeight >= node.scrollHeight - 96) void loadMore();
              }}
            >
              {items.map((item) => (
                <a
                  key={item.receiptId}
                  className={`flex gap-3 border-b border-(--color-border) p-4 no-underline hover:bg-black/5 dark:hover:bg-white/5 ${item.readAt == null ? 'font-medium' : 'opacity-70'}`}
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
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white"
                    style={{ backgroundColor: avatarColor(item.actorId) }}
                  >
                    {(item.actorLogin ?? '?').slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex justify-between gap-2">
                      <span
                        className="truncate"
                        title={`${item.actorLogin ?? 'Невідомий'} згадав вас у групі ${item.groupName}`}
                      >
                        {item.actorLogin ?? 'Невідомий'} згадав вас у групі {item.groupName}
                      </span>
                      <time
                        className="shrink-0 text-sm font-normal text-(--color-text-secondary)"
                        title={dayjs(item.createdAt).tz(APP_TIME_ZONE).format('DD.MM.YYYY HH:mm')}
                      >
                        {notificationTime(item.createdAt)} {item.readAt == null ? '●' : ''}
                      </time>
                    </span>
                    <span className="mt-2 block line-clamp-3 whitespace-pre-wrap rounded border-l-4 border-sky-400 bg-black/5 p-2 font-normal dark:bg-white/5">
                      {notificationQuoteText(item)}
                    </span>
                  </span>
                </a>
              ))}
              {loading ? (
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
