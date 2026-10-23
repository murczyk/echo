import type { MessageTimeBasis } from '../../../services/api/user-settings';
import { CitedMessageCard } from './CitedMessageCard';
import type { ReplySnapshot } from './reply-store';

export function MessageReplyChain({
  id,
  snapshot,
  timeBasis,
}: {
  id: number;
  snapshot: ReplySnapshot;
  timeBasis: MessageTimeBasis;
}) {
  const original = snapshot.relations.find((relation) => relation.replySignalMessageId === id);
  const replies = snapshot.relations.filter((relation) => relation.replySignalMessageId !== id);
  if (!original && !replies.length) return null;
  return (
    <section aria-label="Відповіді" className="flex min-w-0 flex-col gap-echo-sm">
      {original ? (
        <div>
          {original.originalDeleted ||
          !snapshot.messages.has(original.originalSignalMessageId ?? -1) ? (
            <span className="text-(--color-action)">Оригінальне повідомлення</span>
          ) : null}
          <CitedMessageCard
            label="Оригінальне повідомлення"
            deleted={original.originalDeleted}
            message={snapshot.messages.get(original.originalSignalMessageId ?? -1)}
            timeBasis={timeBasis}
          />
        </div>
      ) : null}
      {replies.length ? (
        <>
          <div className="flex items-center gap-echo-xs">
            Ланцюжок{' '}
            <span className="inline-flex size-echo-control-sm items-center justify-center rounded-full border border-echo-border bg-echo-surface text-echo-sm">
              {replies.length}
            </span>
          </div>
          <ol className="m-0 list-none p-0">
            {replies.map((relation, index) => (
              <li key={relation.id} className="group flex min-w-0 gap-echo-sm">
                <div className="flex shrink-0 flex-col items-center">
                  <span className="inline-flex size-echo-control-sm items-center justify-center rounded-full border border-echo-border group-hover:border-(--color-action) group-focus-within:bg-(--color-action) group-focus-within:text-echo-surface">
                    {index + 1}
                  </span>
                  {index + 1 < replies.length ? (
                    <span className="grow border-l border-echo-border" aria-hidden />
                  ) : null}
                </div>
                <div className="min-w-0 grow pb-echo-sm">
                  <CitedMessageCard
                    deleted={relation.replyDeleted}
                    message={snapshot.messages.get(relation.replySignalMessageId ?? -1)}
                    timeBasis={timeBasis}
                  />
                </div>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}
