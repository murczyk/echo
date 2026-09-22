import { Popover } from '@mui/material';
import { useCallback, useId, useState, useSyncExternalStore } from 'react';
import { authorKey, getAuthor, subscribeAuthor } from '../author-identities';

export function AuthorLabel({
  login,
  accountId,
  fallback,
}: {
  login?: string | null;
  accountId?: string | null;
  fallback?: string | null;
}) {
  const key = authorKey(login, accountId);
  const subscribe = useCallback((listener: () => void) => subscribeAuthor(key, listener), [key]);
  const snapshot = useCallback(() => getAuthor(key), [key]);
  const author = useSyncExternalStore(subscribe, snapshot);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const panelId = useId();
  if (!author?.displayName) return <>{fallback ?? login ?? accountId ?? '—'}</>;
  return (
    <>
      <button
        type="button"
        className="cursor-pointer border-0 bg-transparent p-0 text-inherit underline decoration-dotted underline-offset-2 [font:inherit]"
        aria-haspopup="dialog"
        aria-expanded={Boolean(anchor)}
        aria-controls={anchor ? panelId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setAnchor(event.currentTarget);
        }}
      >
        {author.displayName}
      </button>
      {anchor ? (
        <Popover
          open
          anchorEl={anchor}
          onClose={() => setAnchor(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          onClick={(event) => event.stopPropagation()}
        >
          <section
            id={panelId}
            role="dialog"
            aria-label="Інформація про автора"
            className="p-echo-md text-echo-sm"
          >
            <strong className="break-all">{author.displayName}</strong>
            <dl className="m-0 mt-echo-sm grid grid-cols-[auto_1fr] gap-x-echo-md gap-y-echo-xs">
              <dt>Логін</dt>
              <dd className="m-0 break-all">{author.login}</dd>
              {author.deltaLogin ? (
                <>
                  <dt>Логін Delta</dt>
                  <dd className="m-0 break-all">{author.deltaLogin}</dd>
                </>
              ) : null}
            </dl>
          </section>
        </Popover>
      ) : null}
    </>
  );
}
