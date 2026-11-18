import {
  alpha,
  Button,
  CircularProgress,
  ClickAwayListener,
  ListItemButton,
  Paper,
} from '@mui/material';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import type { MessengersMessageItem } from '../../../../../Bindings';
import { splitHeadline } from '../messenger-chat-search';
import { useMessengerChatSearch } from '../use-messenger-chat-search';
import { MessengerChatDateField } from './MessengerChatDateField';
import { MessengerSearchField } from './MessengerSearchField';

type Props = {
  accountId: string;
  chatId: string;
  // Who wrote a hit, for its first line; an empty text leaves the name out.
  senderLabel: (message: MessengersMessageItem) => string;
  onOpenHit: (messageId: string) => void;
  // The first and last millisecond of the chosen day.
  onJumpToDate: (dayStartMs: number, dayEndMs: number) => void;
  jumping: boolean;
  // The phone: the date is only an icon and the search takes the rest of the row.
  mobile?: boolean;
};

const HIT_DATE = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function SearchHit({
  id,
  hit,
  sender,
  active,
  opened,
  onOpen,
}: {
  id: string;
  hit: MessengersMessageItem;
  sender: string;
  // The hit the arrow keys are on.
  active: boolean;
  // The hit that was opened last, so a reader who comes back to the list sees where they left off.
  opened: boolean;
  onOpen: (messageId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  return (
    <ListItemButton
      ref={ref}
      id={id}
      role="option"
      aria-selected={active}
      aria-current={opened ? 'true' : undefined}
      className="!block !px-3 !py-2"
      sx={{
        bgcolor: opened ? (theme) => alpha(theme.palette.primary.main, 0.14) : undefined,
        outline: active ? '2px solid' : undefined,
        outlineColor: 'primary.main',
        outlineOffset: -2,
      }}
      onClick={() => onOpen(hit.id)}
      data-messenger-search-hit
    >
      <div className="text-[11px] opacity-60">
        {sender === '' ? '' : `${sender} · `}
        {HIT_DATE.format(hit.sentAt)}
      </div>
      <div className="text-[13px] break-words">
        {splitHeadline(hit.headline || hit.text || '').map((part, index) =>
          part.match ? (
            <mark key={index} className="rounded-sm bg-yellow-300/70 px-px text-inherit">
              {part.text}
            </mark>
          ) : (
            <span key={index}>{part.text}</span>
          ),
        )}
      </div>
    </ListItemButton>
  );
}

// Search under the chat header: a text search whose hits open the message in the chat, and a day to jump to.
export function MessengerChatSearchBar({
  accountId,
  chatId,
  senderLabel,
  onOpenHit,
  onJumpToDate,
  jumping,
  mobile = false,
}: Props) {
  const [text, setText] = useState('');
  // The list is shown while open. Closing it (a press outside, Escape, a hit opened) keeps the text and the loaded
  // hits: a click or focus on the input, or typing, shows them again without a new request. Blur never closes it, so
  // dismissing the phone's keyboard leaves the list where it is.
  const [open, setOpen] = useState(true);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const listId = useId();
  const search = useMessengerChatSearch({ accountId, chatId, text });
  const { hits } = search;
  const shown = open && search.active;

  const close = () => {
    setOpen(false);
    setActiveIndex(-1);
  };
  const openHit = (messageId: string) => {
    // A jump is loading: it would drop this one without a word, so the list stays and nothing is marked opened.
    if (jumping) return;
    close();
    setOpenedId(messageId);
    onOpenHit(messageId);
  };
  const changeText = (value: string) => {
    setText(value);
    setOpen(true);
    setActiveIndex(-1);
    setOpenedId(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && shown) {
      // Only what this closes: the rest of the page keeps its own Escape.
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!shown) setOpen(true);
      else if (hits.length > 0)
        setActiveIndex((index) =>
          Math.max(0, Math.min(index + (event.key === 'ArrowDown' ? 1 : -1), hits.length - 1)),
        );
    } else if (event.key === 'Enter' && shown && hits[activeIndex] != null) {
      event.preventDefault();
      openHit(hits[activeIndex].id);
    }
  };

  return (
    <div
      className={`flex items-start gap-2 border-b border-solid border-black/12 py-2 dark:border-white/12 ${mobile ? 'px-2' : 'flex-wrap px-3'}`}
      data-messenger-chat-search
    >
      <ClickAwayListener onClickAway={close}>
        <div
          className={`relative flex-1 [&_.MuiTextField-root]:w-full ${mobile ? 'min-w-0' : 'min-w-48'}`}
        >
          <MessengerSearchField
            value={text}
            onChange={changeText}
            ariaLabel="Пошук у чаті"
            placeholder="Пошук в чаті..."
            inputProps={{
              role: 'combobox',
              'aria-expanded': shown,
              'aria-controls': shown ? listId : undefined,
              'aria-autocomplete': 'list',
              'aria-activedescendant':
                shown && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined,
              onFocus: () => setOpen(true),
              onClick: () => setOpen(true),
              onKeyDown,
            }}
          />
          {shown ? (
            <Paper
              elevation={4}
              className="absolute top-full right-0 left-0 z-20 mt-1 max-h-[400px] overflow-y-auto"
            >
              {search.loading ? (
                <div className="flex justify-center p-4" role="status" aria-label="Пошук">
                  <CircularProgress size={18} />
                </div>
              ) : (
                <>
                  <div id={listId} role="listbox" aria-label="Результати пошуку">
                    {hits.map((hit, index) => (
                      <SearchHit
                        key={hit.id}
                        id={`${listId}-${index}`}
                        hit={hit}
                        sender={senderLabel(hit)}
                        active={index === activeIndex}
                        opened={hit.id === openedId}
                        onOpen={openHit}
                      />
                    ))}
                  </div>
                  {search.error != null ? (
                    <p className="m-0 p-3 text-sm text-red-600" role="alert">
                      {search.error}
                    </p>
                  ) : hits.length === 0 ? (
                    <p className="m-0 p-3 text-sm opacity-60" role="status">
                      Нічого не знайдено.
                    </p>
                  ) : null}
                  {search.cursor != null ? (
                    <Button
                      fullWidth
                      size="small"
                      disabled={search.loadingMore}
                      onClick={() => void search.loadMore()}
                    >
                      Показати ще
                    </Button>
                  ) : null}
                </>
              )}
            </Paper>
          ) : null}
        </div>
      </ClickAwayListener>
      <MessengerChatDateField onJumpToDate={onJumpToDate} disabled={jumping} mobile={mobile} />
    </div>
  );
}
