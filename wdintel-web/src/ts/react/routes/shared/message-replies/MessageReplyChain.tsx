import { Popover } from '@mui/material';
import { useMemo, useRef, useState } from 'react';
import type { MessageTimeBasis } from '../../../services/api/user-settings';
import { CitedMessageCard } from './CitedMessageCard';
import { useReplyNavigation } from './MessageRepliesProvider';
import type { ReplySnapshot } from './reply-store';

const COMPACT_REPLY_LIMIT = 2;

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
  const previews = entries.filter((entry) => entry.messageId !== id).slice(-COMPACT_REPLY_LIMIT);
  if (!entries.length) return null;
  const renderList = (all: boolean) => (
    <ol className="m-0 flex list-none flex-col gap-echo-sm p-0">
      {(all ? entries : previews).map((entry, index) => (
        <li
          key={entry.key}
          aria-current={entry.messageId === id ? 'true' : undefined}
          className={all ? 'relative flex min-h-9 min-w-0 gap-echo-sm' : 'min-w-0'}
        >
          {all ? (
            <span aria-hidden="true" className="relative flex w-5 shrink-0 justify-center">
              <span className="relative z-1 mt-3.5 size-2 rounded-full bg-echo-divider" />
              {index < entries.length - 1 ? (
                <span className="absolute top-4 -bottom-6 w-px bg-echo-divider" />
              ) : null}
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            <CitedMessageCard
              showTimestamp={all}
              deleted={entry.deleted}
              message={entry.message}
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
        </li>
      ))}
    </ol>
  );
  return (
    <section ref={sourceRef} aria-label="Відповіді" className="flex min-w-0 flex-col gap-echo-sm">
      <div className="text-echo-text opacity-50">Ланцюжок</div>
      {renderList(false)}
      {entries.length > COMPACT_REPLY_LIMIT ? (
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={anchor != null}
          className="inline-flex items-center gap-echo-xs self-start rounded-echo-sm! px-echo-sm py-echo-xs text-(--color-action) transition-colors hover:bg-(--color-action)/10 focus-visible:outline-2 focus-visible:outline-echo-focus"
          onClick={(event) => setAnchor(event.currentTarget)}
        >
          Усі повідомлення{' '}
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-(--color-action)/20 px-1 text-echo-xs">
            {entries.length}
          </span>
        </button>
      ) : null}
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
          <div className="border-b border-echo-divider p-echo-sm text-echo-text">Ланцюжок</div>
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
