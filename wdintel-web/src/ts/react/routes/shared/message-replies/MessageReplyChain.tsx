import { Popover } from '@mui/material';
import { useMemo, useRef, useState } from 'react';
import type { MessageTimeBasis } from '../../../services/api/user-settings';
import { CitedMessageCard } from './CitedMessageCard';
import {
  useReplyNavigation,
  useReplyFilterMatches,
  useReplyNewestFirst,
} from './MessageRepliesProvider';
import type { ReplySnapshot } from './reply-store';
import { threadAnalysisHref } from './thread-analysis-link';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';

export function MessageReplyChain({
  id,
  snapshot,
  timeBasis,
}: {
  id: number;
  snapshot: ReplySnapshot;
  timeBasis: MessageTimeBasis;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const sourceRef = useRef<HTMLElement>(null);
  const navigate = useReplyNavigation();
  const newestFirst = useReplyNewestFirst();
  const entries = useMemo(() => {
    const head = snapshot.relations[0];
    const entries = [
      ...(head
        ? [
            {
              key: `head-${head.threadId}`,
              messageId: head.originalSignalMessageId,
              deleted: head.originalDeleted,
              message: snapshot.messages.get(head.originalSignalMessageId ?? -1),
            },
          ]
        : []),
      ...snapshot.relations.map((relation) => ({
        key: `reply-${relation.id}`,
        messageId: relation.replySignalMessageId,
        deleted: relation.replyDeleted,
        message: snapshot.messages.get(relation.replySignalMessageId ?? -1),
      })),
    ];
    const available = entries
      .filter((entry) => entry.message && !entry.deleted)
      .sort((a, b) => a.message!.createdAt - b.message!.createdAt || a.message!.id - b.message!.id)
      .values();
    return entries.map((entry) =>
      entry.message && !entry.deleted ? (available.next().value ?? entry) : entry,
    );
  }, [snapshot]);
  const ids = useMemo(
    () => entries.flatMap((entry) => (entry.message && !entry.deleted ? [entry.message.id] : [])),
    [entries],
  );
  const excluded = useReplyFilterMatches(ids, sourceRef);
  const currentIndex = entries.findIndex((entry) => entry.messageId === id);
  const previews =
    currentIndex < 0 ? [] : entries.slice(Math.max(0, currentIndex - 1), currentIndex + 2);
  if (newestFirst) previews.reverse();
  const moreAbove = newestFirst ? currentIndex < entries.length - 2 : currentIndex > 1;
  const moreBelow = newestFirst ? currentIndex > 1 : currentIndex < entries.length - 2;
  if (!entries.length) return null;
  const renderList = (all: boolean) => (
    <ol className="m-0 flex list-none flex-col gap-echo-sm p-0">
      {(all ? entries : previews).map((entry, index) => (
        <li
          key={entry.key}
          aria-current={all && entry.messageId === id ? 'true' : undefined}
          role={!all && entry.messageId === id ? 'presentation' : undefined}
          className="min-w-0"
        >
          <div className={`relative flex min-w-0 gap-echo-sm ${all ? 'min-h-9' : ''}`}>
            <span
              aria-hidden="true"
              className={`relative flex w-5 shrink-0 justify-center ${!all ? 'items-center' : ''}`}
            >
              <span
                className={`relative z-1 size-2 rounded-full ${all ? 'mt-3.5' : ''} ${entry.messageId === id ? 'bg-(--color-action)' : 'bg-echo-divider'}`}
              />
              {!all && index === 0 && moreAbove ? (
                <span className="absolute bottom-1/2 h-5 w-px border-l border-dashed border-echo-divider" />
              ) : null}
              {all && index < entries.length - 1 ? (
                <span className="absolute top-4 -bottom-6 w-px bg-echo-divider" />
              ) : null}
              {!all && index > 0 ? (
                <span className="absolute top-0 bottom-1/2 w-px bg-echo-divider" />
              ) : null}
              {!all && index < previews.length - 1 ? (
                <span className="absolute top-1/2 -bottom-echo-sm w-px bg-echo-divider" />
              ) : null}
              {!all && index === previews.length - 1 && moreBelow ? (
                <span className="absolute top-1/2 h-5 w-px border-l border-dashed border-echo-divider" />
              ) : null}
            </span>
            {!all && entry.messageId === id ? (
              <div
                role="separator"
                aria-label="Поточне повідомлення"
                className="flex min-h-2 flex-1 items-center"
              >
                <span className="flex-1 border-t border-dashed border-echo-divider" />
              </div>
            ) : (
              <div className="min-w-0 flex-1">
                <CitedMessageCard
                  showTimestamp={all}
                  deleted={entry.deleted}
                  message={entry.message}
                  outsideFilters={entry.messageId != null && excluded.has(entry.messageId)}
                  timeBasis={timeBasis}
                  onNavigate={
                    navigate
                      ? (message, source) => {
                          const origin = sourceRef.current ?? source;
                          setAnchor(null);
                          navigate(message, origin);
                        }
                      : undefined
                  }
                />
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
  return (
    <section
      ref={sourceRef}
      aria-label="Відповіді"
      className="mt-echo-sm flex min-w-0 flex-col gap-echo-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-echo-sm">
        <div className="text-echo-text opacity-50">Ланцюжок</div>
        {entries.length <= 2 ? (
          <a
            href={threadAnalysisHref(id, snapshot.messages)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Відкрити в Аналізі"
            title="Відкрити в Аналізі"
            className="rounded-echo-sm p-echo-xs text-(--color-action) hover:bg-(--color-action)/10 focus-visible:outline-2 focus-visible:outline-echo-focus"
          >
            <OpenInNewOutlinedIcon fontSize="small" />
          </a>
        ) : null}
        {entries.length > 2 ? (
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={anchor != null}
            className="inline-flex items-center gap-echo-xs rounded-echo-sm! px-echo-sm py-echo-xs text-(--color-action) transition-colors hover:bg-(--color-action)/10 focus-visible:outline-2 focus-visible:outline-echo-focus"
            onClick={(event) => setAnchor(event.currentTarget)}
          >
            Усі повідомлення{' '}
            {entries.length > 2 ? (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-(--color-action)/20 px-1 text-echo-xs">
                {entries.length}
              </span>
            ) : null}
          </button>
        ) : null}
      </div>
      {renderList(false)}
      {anchor ? (
        <Popover
          open
          anchorEl={anchor}
          onClose={() => setAnchor(null)}
          disableScrollLock
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          slotProps={{
            paper: {
              role: 'dialog',
              'aria-label': 'Ланцюжок повідомлень',
              sx: { width: 420, maxWidth: 'calc(100vw - 32px)', overflow: 'hidden' },
            },
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-echo-sm border-b border-echo-divider p-echo-sm text-echo-text">
            <span>Ланцюжок</span>
            <a
              href={threadAnalysisHref(id, snapshot.messages)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-echo-xs rounded-echo-sm p-echo-xs text-echo-sm text-(--color-action) no-underline hover:bg-(--color-action)/10 focus-visible:outline-2 focus-visible:outline-echo-focus"
            >
              Відкрити в Аналізі <OpenInNewOutlinedIcon fontSize="small" />
            </a>
          </div>
          <div
            data-reply-list
            className="max-h-[min(400px,60dvh)] overflow-y-auto overscroll-contain p-echo-sm"
          >
            {renderList(true)}
          </div>
        </Popover>
      ) : null}
    </section>
  );
}
