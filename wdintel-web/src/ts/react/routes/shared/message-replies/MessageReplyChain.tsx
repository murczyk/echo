import { Popover } from '@mui/material';
import { useRef, useState } from 'react';
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
  const head = snapshot.relations[0];
  const entries = [
    ...(head && head.originalSignalMessageId !== id
      ? [
          {
            key: `head-${head.threadId}`,
            original: true,
            deleted: head.originalDeleted,
            message: snapshot.messages.get(head.originalSignalMessageId ?? -1),
          },
        ]
      : []),
    ...snapshot.relations
      .filter((relation) => relation.replySignalMessageId !== id)
      .map((relation) => ({
        key: `reply-${relation.id}`,
        original: false,
        deleted: relation.replyDeleted,
        message: snapshot.messages.get(relation.replySignalMessageId ?? -1),
      })),
  ];
  if (!entries.length) return null;
  const renderList = (all: boolean) => (
    <ol className="m-0 flex list-none flex-col gap-echo-sm p-0">
      {(all ? entries : entries.slice(0, COMPACT_REPLY_LIMIT)).map((entry) => (
        <li key={entry.key} className="min-w-0">
          <CitedMessageCard
            label={entry.original ? 'Оригінальне повідомлення' : undefined}
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
        </li>
      ))}
    </ol>
  );
  return (
    <section ref={sourceRef} aria-label="Відповіді" className="flex min-w-0 flex-col gap-echo-sm">
      <div className="text-echo-text-muted">Ланцюжок</div>
      {renderList(false)}
      {entries.length > COMPACT_REPLY_LIMIT ? (
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={anchor != null}
          className="inline-flex items-center gap-echo-xs self-start rounded-echo-sm px-echo-sm py-echo-xs text-(--color-action) hover:bg-echo-hover focus-visible:outline-2 focus-visible:outline-echo-focus"
          onClick={(event) => setAnchor(event.currentTarget)}
        >
          Усі{' '}
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
          <div className="border-b border-echo-divider p-echo-sm text-echo-text-muted">
            Ланцюжок
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
