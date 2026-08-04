import ClearAllIcon from '@mui/icons-material/ClearAll';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { IconButton, Paper, Tooltip } from '@mui/material';
import { useMemo } from 'react';
import type { MessageFeedState } from './utils';
import type { FeedColumnModel } from './types';
import {
  clearDutyScrollDebugEvents,
  setDutyScrollDebugEnabled,
  useDutyScrollDebugEnabled,
  useDutyScrollDebugFeed,
} from './duty-scroll-debug';

type DutyScrollDebugPanelProps = {
  feed: MessageFeedState;
  view: FeedColumnModel['view'];
};

function formatNumber(value: number | null | undefined): string {
  return value == null ? '—' : value.toFixed(1);
}

function formatBoolean(value: boolean | null | undefined): string {
  return value == null ? '—' : value ? 'yes' : 'no';
}

function formatTime(atMs: number): string {
  return new Date(atMs).toISOString().slice(11, 23);
}

export function DutyScrollDebugPanel({ feed, view }: DutyScrollDebugPanelProps) {
  const debugEnabled = useDutyScrollDebugEnabled();
  const debug = useDutyScrollDebugFeed(feed.id);
  const metrics = debug.metrics;
  const events = useMemo(() => [...debug.events].reverse(), [debug.events]);

  if (!debugEnabled) return null;

  const copySnapshot = () => {
    const payload = {
      capturedAt: new Date().toISOString(),
      page: {
        visibility: document.visibilityState,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        devicePixelRatio: window.devicePixelRatio,
      },
      feed: {
        id: feed.id,
        itemCount: feed.items.length,
        firstItemId: feed.items[0]?.[0] ?? null,
        lastItemId: feed.items.at(-1)?.[0] ?? null,
        unreadCount: feed.unreadCount,
        readIdCount: feed.readIds.size,
        windowedUnreadCount: feed.windowedUnreadItems.size,
        loading: feed.loading,
        loadingOlder: feed.loadingOlder,
        hasReachedStart: feed.hasReachedStart,
      },
      view,
      debug,
    };
    void navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
  };

  const activityCount = debug.activities.unreadCount + debug.activities.tailCount;
  const newerActivityCount = debug.activities.newerMessages;
  const anchor =
    metrics?.anchorId == null
      ? '—'
      : `${metrics.anchorId}@${formatNumber(metrics.anchorOffsetTop)}`;

  return (
    <Paper
      data-duty-scroll-debug-panel
      elevation={12}
      sx={{
        position: 'absolute',
        top: 40,
        right: 8,
        zIndex: 5,
        width: 'min(420px, calc(100% - 16px))',
        maxHeight: 'min(560px, calc(100% - 48px))',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        border: '1px solid',
        borderColor: 'divider',
        backgroundColor: 'background.paper',
        fontFamily: 'monospace',
        fontSize: 10,
        lineHeight: 1.25,
      }}
    >
      <div className="flex items-center gap-1 border-b border-solid border-[var(--color-divider)] px-2 py-1">
        <strong className="min-w-0 flex-1 truncate">scroll debug · {feed.id}</strong>
        <Tooltip title="Copy snapshot">
          <IconButton size="small" aria-label="Copy debug snapshot" onClick={copySnapshot}>
            <ContentCopyIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Clear events">
          <IconButton
            size="small"
            aria-label="Clear debug events"
            onClick={() => clearDutyScrollDebugEvents(feed.id)}
          >
            <ClearAllIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Close all debug panels">
          <IconButton
            size="small"
            aria-label="Close debug panels"
            onClick={() => setDutyScrollDebugEnabled(false)}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 px-2 py-1.5">
        <span>counter HTTP</span>
        <strong data-duty-debug-counter-status>
          {activityCount > 0 ? `LOADING (${activityCount})` : 'idle'}
        </strong>
        <span>newer messages HTTP</span>
        <strong data-duty-debug-newer-messages-status>
          {newerActivityCount > 0 ? `LOADING (${newerActivityCount})` : 'idle'}
        </strong>
        <span>older messages HTTP</span>
        <strong>
          {debug.activities.olderMessages > 0
            ? `LOADING (${debug.activities.olderMessages})`
            : 'idle'}
        </strong>
        <span>initial/reload</span>
        <strong>{feed.loading ? 'LOADING' : 'idle'}</strong>
        <span>older UI / newer UI</span>
        <strong>{`${feed.loadingOlder ? 'yes' : 'no'} / ${view.loadingNewer ? 'yes' : 'no'}`}</strong>
        <span>tail / watch / tracking</span>
        <strong>{`${view.tailAvailability ?? '—'} / ${formatBoolean(view.isWatchMode)} / ${formatBoolean(view.scrollTrackingEnabled ?? true)}`}</strong>
        <span>items / id range</span>
        <strong>{`${feed.items.length} / ${feed.items[0]?.[0] ?? '—'}→${feed.items.at(-1)?.[0] ?? '—'}`}</strong>
        <span>unread raw / shown</span>
        <strong>{`${feed.unreadCount} / ${view.bottomUnreadCount ?? 0}`}</strong>
        <span>read / evicted unread</span>
        <strong>{`${feed.readIds.size} / ${feed.windowedUnreadItems.size}`}</strong>
        <span>scroll top / Δ</span>
        <strong>{`${formatNumber(metrics?.scrollTop)} / ${formatNumber(metrics?.scrollDelta)}`}</strong>
        <span>height / viewport</span>
        <strong>{`${formatNumber(metrics?.scrollHeight)} / ${formatNumber(metrics?.clientHeight)}`}</strong>
        <span>distance / load buffer</span>
        <strong>{`${formatNumber(metrics?.bottomDistance)} / ${formatNumber(metrics?.bottomLoadBufferPx)}`}</strong>
        <span>near / at / physical</span>
        <strong>{`${formatBoolean(metrics?.nearBottom)} / ${formatBoolean(metrics?.atBottom)} / ${formatBoolean(metrics?.physicallyAtBottom)}`}</strong>
        <span>follow / settle</span>
        <strong>{`${formatBoolean(metrics?.liveBottomFollow)} / ${formatBoolean(metrics?.bottomSettleActive)}`}</strong>
        <span>load flags old / new</span>
        <strong>{`${formatBoolean(metrics?.loadOlderTriggered)} / ${formatBoolean(metrics?.loadNewerTriggered)}`}</strong>
        <span>visible / anchor</span>
        <strong>{`${metrics?.firstVisibleId ?? '—'}→${metrics?.lastVisibleId ?? '—'} (${metrics?.visibleAnchorCount ?? 0}) / ${anchor}`}</strong>
        <span>overflow anchor / behavior</span>
        <strong>{`${metrics?.overflowAnchor ?? '—'} / ${metrics?.scrollBehavior ?? '—'}`}</strong>
        <span>page / viewport / DPR</span>
        <strong>{`${document.visibilityState} / ${window.innerWidth}x${window.innerHeight} / ${window.devicePixelRatio}`}</strong>
      </div>

      <div className="border-t border-solid border-[var(--color-divider)] px-2 py-1 font-semibold">
        events ({debug.events.length})
      </div>
      <div
        data-duty-scroll-debug-events
        className="min-h-20 flex-1 overflow-y-auto overscroll-contain px-2 pb-2"
      >
        {events.length === 0 ? (
          <div className="opacity-60">No events yet</div>
        ) : (
          events.map((event) => (
            <div
              key={event.sequence}
              className="border-b border-dotted border-[var(--color-divider)] py-0.5"
            >
              <span className="opacity-60">{formatTime(event.atMs)}</span>{' '}
              <strong>{event.name}</strong>
              {event.detail ? ` · ${event.detail}` : ''}
            </div>
          ))
        )}
      </div>
    </Paper>
  );
}
