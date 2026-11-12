import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';
import ContactsOutlinedIcon from '@mui/icons-material/ContactsOutlined';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import MarkChatUnreadOutlinedIcon from '@mui/icons-material/MarkChatUnreadOutlined';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import PhotoLibraryOutlinedIcon from '@mui/icons-material/PhotoLibraryOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { Collapse, IconButton, Switch, Tooltip } from '@mui/material';
import { Fragment, useState, type ElementType, type ReactNode } from 'react';
import { Virtuoso } from 'react-virtuoso';

import { SidePanelToggleButton } from '../../../components/SidePanelToggleButton';
import { useLocalStorage } from '../../../hooks/use-local-storage';
import { formatDate } from '../../../utils/misc';
import {
  chatSectionOf,
  type MessengerChat,
  type MessengerChatSection,
  type useMessengerChats,
} from '../use-messenger-chats';
import { CopyValue } from './CopyValue';
import { MessengerAccountAvatar, type MessengerAccountItem } from './MessengerAccountList';
import { MessengerSearchField } from './MessengerSearchField';

// shortcut: the gallery is not wired yet, its item does nothing.
const GALLERY_NAV_ITEM = 'Галерея';
const CONTACTS_NAV_ITEM = 'Контакти';
const CHAT_SECTIONS: ReadonlyArray<{
  key: MessengerChatSection;
  title: string;
  Icon: ElementType;
}> = [
  { key: 'private', title: 'Приватні', Icon: PersonOutlineIcon },
  { key: 'group', title: 'Групи', Icon: GroupsOutlinedIcon },
  { key: 'channel', title: 'Канали', Icon: CampaignOutlinedIcon },
  { key: 'bot', title: 'Боти', Icon: SmartToyOutlinedIcon },
];

const DIVIDER = 'border-black/12 dark:border-white/12';
const UNREAD_ONLY_LABEL = 'Лише непрочитані';
const READ_ALL_LABEL = 'Прочитати всі';
// The look of an open chat row (`.group-navigation-list-item[data-selected]`), for the other items that can be open.
const SELECTED_LOOK =
  'hover:bg-[color-mix(in_srgb,var(--echo-color-text,#fff)_6%,transparent)] data-[selected=true]:bg-[color-mix(in_srgb,var(--echo-color-text,#fff)_8%,transparent)] data-[selected=true]:hover:bg-[color-mix(in_srgb,var(--echo-color-text,#fff)_10%,transparent)]';

// The accent of the rail: an open item is lit in the primary color and has a bar on the left edge of the rail, like the
// active item of a chat app's side rail. A plain grey patch behind a round avatar looked like a stain.
// (The classes are written out in full: Tailwind reads the source text and does not see a joined string.)
const RAIL_BAR =
  'relative flex w-full justify-center before:pointer-events-none before:absolute before:top-1/2 before:left-0 before:h-0 before:w-1 before:-translate-y-1/2 before:rounded-r-full before:bg-[var(--echo-color-primary,var(--color-action,#3b82f6))] before:transition-[height] before:duration-200 motion-reduce:before:transition-none data-[selected=true]:before:h-5';
const RAIL_ICON_LOOK =
  'hover:bg-[color-mix(in_srgb,var(--echo-color-text,#fff)_8%,transparent)] data-[selected=true]:bg-[color-mix(in_srgb,var(--echo-color-primary,var(--color-action,#3b82f6))_16%,transparent)] data-[selected=true]:text-[var(--echo-color-primary,var(--color-action,#3b82f6))]';
const ACCOUNT_OPEN_LOOK =
  'data-[selected=true]:bg-[color-mix(in_srgb,var(--echo-color-primary,var(--color-action,#3b82f6))_16%,transparent)]';
// On a phone the rail is narrower (so its line meets the right edge of the page's panel button), and its things shrink:
// the buttons to 2 rem, the avatars to 2 rem (`!`: the avatar size is set in a plain stylesheet, outside the layers).
const RAIL_AVATAR_SIZE =
  'group-data-[mobile=true]/sidebar:!size-8 group-data-[mobile=true]/sidebar:!text-sm';
// A kind of chat that is folded and holds the open chat is lit green over its whole area between the lines, as the
// account info is lit blue.
const SECTION_FILL =
  'data-[selected=true]:bg-[color-mix(in_srgb,var(--echo-color-success,#16a34a)_18%,transparent)]';
// Chats are lit green, the pages (gallery, contacts) in the primary color. The `!` on the radius is needed: the global
// reset gives buttons a square corner, and it beats a plain utility, which sits in a cascade layer.
const RAIL_CHAT_LOOK =
  'hover:bg-[color-mix(in_srgb,var(--echo-color-text,#fff)_8%,transparent)] data-[selected=true]:bg-[color-mix(in_srgb,var(--echo-color-success,#16a34a)_18%,transparent)]';

function Separator({ name }: { name: string }) {
  return (
    <div
      role="separator"
      data-messenger-separator={name}
      className={`w-full shrink-0 border-t border-solid ${DIVIDER}`}
    />
  );
}

// Short numeric date, e.g. 12.09.26.
const formatChatDate = (ms: number) =>
  formatDate(ms, { day: '2-digit', month: '2-digit', year: '2-digit' });

export const chatLabel = (chat: MessengerChat) => chat.title || chat.username || chat.externalId;

// Whether the account sidebar is open, remembered between visits like the other panels of the page.
const SIDEBAR_OPEN_STORAGE_KEY = 'messenger-account-sidebar-open';

function useAccountSidebarOpen(): [boolean, (open: boolean) => void] {
  const storage = useLocalStorage();
  const [open, setOpen] = useState(() => storage.getItem(SIDEBAR_OPEN_STORAGE_KEY) !== 'false');
  const update = (next: boolean) => {
    setOpen(next);
    storage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(next));
  };
  return [open, update];
}

// The chats of one kind, in the scroll area of the sidebar (`scroller`). A long list is virtualized (only the rows near the
// view are in the DOM), which keeps a sidebar with thousands of chats smooth; `container` is the box of the rows and
// `gap` the space under a row (a virtual list has no `gap`, the rows carry it). The rows of a short list stay plain DOM.
// shortcut: a virtual list has no ul/li semantics, and the 90 is a guess: lower it if a short list scrolls badly.
const VIRTUALIZE_FROM = 90;
function ChatRows({
  chats,
  scroller,
  container,
  gap,
  semantic = false,
  render,
}: {
  chats: MessengerChat[];
  scroller: HTMLElement | null;
  container: string;
  gap: { plain: string; row: string };
  semantic?: boolean;
  render: (chat: MessengerChat) => ReactNode;
}) {
  if (scroller != null && chats.length >= VIRTUALIZE_FROM) {
    return (
      <div className={container} data-messenger-virtual-list>
        <Virtuoso
          customScrollParent={scroller}
          data={chats}
          computeItemKey={(_, chat) => chat.id}
          increaseViewportBy={400}
          itemContent={(_, chat) => <div className={gap.row}>{render(chat)}</div>}
        />
      </div>
    );
  }
  const Box = semantic ? 'ul' : 'div';
  return (
    <Box className={`${container} flex flex-col ${gap.plain}`}>
      {chats.map((chat) =>
        semantic ? (
          <li key={chat.id}>{render(chat)}</li>
        ) : (
          <Fragment key={chat.id}>{render(chat)}</Fragment>
        ),
      )}
    </Box>
  );
}

function ChatSection({
  title,
  Icon,
  chats,
  scroller,
  selectedChatId,
  onSelectChat,
}: {
  title: string;
  Icon: ElementType;
  chats: MessengerChat[];
  scroller: HTMLElement | null;
  selectedChatId: string | null;
  onSelectChat: (chatId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const lit = !open && chats.some((chat) => chat.id === selectedChatId);
  return (
    <section
      className={`border-t border-solid ${DIVIDER} ${SECTION_FILL}`}
      data-selected={lit ? 'true' : 'false'}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-2 text-sm"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="flex items-center gap-2">
          <Icon fontSize="small" className="opacity-70" />
          <span>
            {title} ({chats.length})
          </span>
        </span>
        <ExpandMoreIcon fontSize="small" className={open ? '' : '-rotate-90'} />
      </button>
      <Collapse in={open}>
        {chats.length === 0 ? (
          <p className="px-4 pt-1 pb-3 text-xs opacity-60">Немає чатів</p>
        ) : (
          <ChatRows
            chats={chats}
            scroller={scroller}
            semantic
            container="m-0 list-none px-2 pt-0 pb-2"
            gap={{ plain: 'gap-1', row: 'pb-1' }}
            render={(chat) => (
              <button
                type="button"
                className="group-navigation-list-item !px-2"
                data-messenger-chat
                data-selected={chat.id === selectedChatId ? 'true' : 'false'}
                aria-current={chat.id === selectedChatId ? 'true' : undefined}
                onClick={() => onSelectChat(chat.id)}
              >
                <MessengerAccountAvatar
                  account={{ id: chat.id, name: chatLabel(chat), phone: '' }}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="group-navigation-name" title={chatLabel(chat)}>
                    {chatLabel(chat)}
                  </span>
                  {chat.lastMessageDate != null ? (
                    <span className="group-navigation-name text-xs opacity-60">
                      {formatChatDate(chat.lastMessageDate)}
                    </span>
                  ) : null}
                </span>
              </button>
            )}
          />
        )}
      </Collapse>
    </section>
  );
}

type SidebarProps = {
  account: MessengerAccountItem;
  chatsState: ReturnType<typeof useMessengerChats>;
  selectedChatId: string | null;
  contactsOpen: boolean;
  onSelectChat: (chatId: string) => void;
  onOpenContacts: () => void;
  onOpenAccount: () => void;
};

function ExpandedSidebar({
  account,
  chatsState: { chats, loading, error, retry },
  selectedChatId,
  contactsOpen,
  onSelectChat,
  onOpenContacts,
  onOpenAccount,
  className,
  hidden,
}: SidebarProps & { className: string; hidden: boolean }) {
  const [query, setQuery] = useState('');
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const accountOpen = selectedChatId == null && !contactsOpen;
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? chats.filter((chat) =>
        [chat.title, chat.username, chat.externalId].some((field) =>
          (field ?? '').toLowerCase().includes(needle),
        ),
      )
    : chats;
  return (
    <aside
      ref={setScroller}
      aria-label="Навігація акаунту"
      className={`${className} slim-scrollbar flex flex-col gap-2 overflow-y-auto py-2`}
      // A hidden layer is neither clicked nor tabbed to nor read out.
      // The blank areas lead back to the account cards, like the back arrow of an open chat or view. The things on
      // them (copy values, buttons, the search) are not blank; the copy values stop their clicks. A pointer
      // shortcut only: the keyboard has the back arrow of the view.
      onClick={(event) => {
        if (event.target === event.currentTarget) onOpenAccount();
      }}
      {...(hidden ? ({ inert: '', 'aria-hidden': true } as object) : {})}
    >
      {/* Lit like the open items of the rail while the account cards are open; it reaches up to the top edge of the box and down to the line below (negative margins cancel the gaps of the column). */}
      <div
        className={`-mt-2 -mb-2 flex cursor-pointer items-center gap-3 px-4 pt-4 pb-3 ${ACCOUNT_OPEN_LOOK}`}
        data-selected={accountOpen ? 'true' : 'false'}
        onClick={onOpenAccount}
      >
        <MessengerAccountAvatar account={account} />
        <span className="flex min-w-0 flex-1 flex-col">
          {/* The panel toggle floats over the top right corner, so the first two lines keep clear of it. */}
          <CopyValue
            text={account.name}
            className="group-navigation-name self-start max-w-[calc(100%_-_2.25rem)]"
          >
            {account.name}
          </CopyValue>
          {account.phone ? (
            <CopyValue
              text={account.phone.startsWith('+') ? account.phone : `+${account.phone}`}
              className="group-navigation-name self-start max-w-[calc(100%_-_2.25rem)] text-xs opacity-60"
            >
              {account.phone}
            </CopyValue>
          ) : null}
          {account.username ? (
            <CopyValue
              text={`@${account.username}`}
              className="group-navigation-name self-start text-xs opacity-60"
            >
              @{account.username}
            </CopyValue>
          ) : null}
          {account.userId ? (
            <CopyValue
              text={account.userId}
              className="group-navigation-name self-start text-xs opacity-60"
              data-messenger-user-id
            >
              User ID: {account.userId}
            </CopyValue>
          ) : null}
          {account.externalId ? (
            <CopyValue
              text={account.externalId}
              className="group-navigation-name self-start text-xs opacity-60"
            >
              External ID: {account.externalId}
            </CopyValue>
          ) : null}
        </span>
      </div>
      <Separator name="account-pages" />
      <nav className="flex flex-col gap-1 px-2">
        <button
          type="button"
          className={`!rounded-lg !px-2 py-2 text-start text-sm ${SELECTED_LOOK}`}
          data-messenger-nav="gallery"
          data-selected="false"
        >
          {GALLERY_NAV_ITEM}
        </button>
        <button
          type="button"
          className={`!rounded-lg !px-2 py-2 text-start text-sm data-[selected=true]:font-medium ${SELECTED_LOOK}`}
          data-messenger-nav="contacts"
          data-selected={contactsOpen ? 'true' : 'false'}
          aria-current={contactsOpen ? 'true' : undefined}
          onClick={onOpenContacts}
        >
          {CONTACTS_NAV_ITEM}
        </button>
      </nav>
      <Separator name="pages-search" />
      <div className="px-4">
        <MessengerSearchField value={query} onChange={setQuery} ariaLabel="Пошук чату" />
      </div>
      {/* shortcut: the unread filter and "read all" take their place but do nothing until read state exists (plan, section B). */}
      <div
        className="flex items-center justify-between gap-2 px-4 text-xs"
        data-messenger-unread-row
      >
        <label className="flex items-center gap-1 opacity-60">
          {UNREAD_ONLY_LABEL}
          <Switch
            size="small"
            disabled
            checked={false}
            slotProps={{ input: { 'aria-label': UNREAD_ONLY_LABEL } }}
          />
        </label>
        <Tooltip title={READ_ALL_LABEL}>
          <span>
            <IconButton size="small" disabled aria-label={READ_ALL_LABEL}>
              <DoneAllIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </div>
      {error != null ? (
        <div className="flex flex-col items-start gap-1 px-4 py-2">
          <p className="m-0" role="alert">
            {error}
          </p>
          <button type="button" className="text-xs underline" onClick={retry}>
            Повторити завантаження
          </button>
        </div>
      ) : null}
      {loading ? (
        <p className="px-4 text-xs opacity-60" role="status">
          Завантажуємо чати…
        </p>
      ) : // A failed first load has no chats to show; a failed refresh keeps the old ones under the error.
      error != null && chats.length === 0 ? null : (
        // Sections are cut off from each other by a line, as in kontur, and the last one is closed by a line too.
        <div className={`border-b border-solid ${DIVIDER}`}>
          {CHAT_SECTIONS.map(({ key, title, Icon }) => (
            <ChatSection
              key={key}
              title={title}
              Icon={Icon}
              chats={visible.filter((chat) => chatSectionOf(chat) === key)}
              scroller={scroller}
              selectedChatId={selectedChatId}
              onSelectChat={onSelectChat}
            />
          ))}
        </div>
      )}
    </aside>
  );
}

// One button of the rail, with its name in a tooltip. The span keeps the tooltip working on a disabled button.
function RailButton({
  label,
  selected = false,
  disabled = false,
  avatar = false,
  onClick,
  children,
  ...dataAttributes
}: {
  label: string;
  selected?: boolean;
  disabled?: boolean;
  // An avatar button: a small rounded frame round the avatar, grey on hover, green when the chat is open.
  avatar?: boolean;
  onClick?: () => void;
  children: ReactNode;
  [dataAttribute: `data-${string}`]: string | boolean | undefined;
}) {
  return (
    // The bar belongs to a row as wide as the rail, so it sits on the edge of the rail whatever the width of the button.
    <div className={RAIL_BAR} data-selected={selected ? 'true' : 'false'} data-messenger-rail-row>
      <Tooltip placement="right" title={label}>
        <span className="inline-flex shrink-0">
          <button
            type="button"
            aria-label={label}
            aria-current={selected ? 'true' : undefined}
            data-selected={selected ? 'true' : 'false'}
            disabled={disabled}
            // Every button is a slightly rounded square that goes grey on hover: the pages are lit in the primary color when
            // open, a chat is lit green; an avatar button sits in a small frame round its avatar.
            className={`flex cursor-pointer items-center justify-center !rounded-lg disabled:cursor-default disabled:opacity-40 ${
              avatar
                ? `p-0.5 ${RAIL_CHAT_LOOK}`
                : `size-10 group-data-[mobile=true]/sidebar:size-8 ${RAIL_ICON_LOOK}`
            }`}
            onClick={onClick}
            {...dataAttributes}
          >
            {children}
          </button>
        </span>
      </Tooltip>
    </div>
  );
}

// What is left of the sidebar when it is hidden: the same things as icons and avatars. The account (its avatar names
// it on hover and opens the sidebar again), the gallery and the contacts, the unread filter and "read all", and for
// every kind of chat its icon with the number of chats, which opens and closes the avatars of them (closed at first).
function CollapsedSidebar({
  account,
  chatsState: { chats, loading, error },
  selectedChatId,
  contactsOpen,
  onSelectChat,
  onOpenContacts,
  onOpenAccount,
  className,
  hidden,
}: SidebarProps & { className: string; hidden: boolean }) {
  const accountOpen = selectedChatId == null && !contactsOpen;
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [openSections, setOpenSections] = useState<ReadonlySet<MessengerChatSection>>(new Set());
  const toggleSection = (key: MessengerChatSection) =>
    setOpenSections((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const details = [
    account.name,
    account.phone,
    account.username ? `@${account.username}` : null,
    account.userId ? `User ID: ${account.userId}` : null,
    account.externalId ? `External ID: ${account.externalId}` : null,
  ].filter(Boolean);
  return (
    <aside
      ref={setScroller}
      aria-label="Навігація акаунту (згорнуто)"
      data-messenger-sidebar-rail
      // No scrollbar: it would take its width from the rail (the kind buttons are sized to the whole width for 4 digits), the
      // wheel and touch still scroll. Not `slim-scrollbar`: its unlayered rule would beat a utility.
      className={`${className} flex flex-col items-center gap-2 overflow-y-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`}
      {...(hidden ? ({ inert: '', 'aria-hidden': true } as object) : {})}
    >
      {/* Lit like the account info of the full sidebar, from the top of the layer (below the toggle) to the line. The `!` on the margins is needed for the same reason as on the radius above: the global reset gives buttons margin 0. */}
      <Tooltip
        placement="right"
        title={
          <span className="flex flex-col">
            {details.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </span>
        }
      >
        <button
          type="button"
          className={`!-mt-2 !-mb-2 flex w-full cursor-pointer justify-center pt-4 pb-3 ${ACCOUNT_OPEN_LOOK}`}
          aria-label={`${account.name}: деталі акаунту`}
          aria-current={accountOpen ? 'true' : undefined}
          data-selected={accountOpen ? 'true' : 'false'}
          data-messenger-rail-account
          onClick={onOpenAccount}
        >
          <MessengerAccountAvatar account={account} className={RAIL_AVATAR_SIZE} />
        </button>
      </Tooltip>
      <Separator name="account-pages" />
      <RailButton label={GALLERY_NAV_ITEM} data-messenger-rail-nav="gallery">
        <PhotoLibraryOutlinedIcon fontSize="small" />
      </RailButton>
      <RailButton
        label={CONTACTS_NAV_ITEM}
        selected={contactsOpen}
        onClick={onOpenContacts}
        data-messenger-rail-nav="contacts"
      >
        <ContactsOutlinedIcon fontSize="small" />
      </RailButton>
      <Separator name="pages-search" />
      {/* shortcut: like in the full sidebar, they take their place and do nothing until read state exists. */}
      <RailButton label={UNREAD_ONLY_LABEL} disabled data-messenger-rail-unread>
        <MarkChatUnreadOutlinedIcon fontSize="small" />
      </RailButton>
      <RailButton label={READ_ALL_LABEL} disabled data-messenger-rail-read-all>
        <DoneAllIcon fontSize="small" />
      </RailButton>
      {loading || (error != null && chats.length === 0) ? null : (
        <>
          {CHAT_SECTIONS.map(({ key, title, Icon }) => {
            const sectionChats = chats.filter((chat) => chatSectionOf(chat) === key);
            // A kind with no chats has nothing to open: it stays folded, and a click does nothing.
            const empty = sectionChats.length === 0;
            const open = openSections.has(key) && !empty;
            // A folded kind that holds the open chat is marked, so the chat is not lost.
            const lit = !open && sectionChats.some((chat) => chat.id === selectedChatId);
            return (
              <div
                key={key}
                className="flex w-full flex-col items-center gap-2"
                data-messenger-rail-section={key}
              >
                <Separator name={`section-${key}`} />
                {/* The button fills the whole area between the lines, for hover (grey) and for lit (green) alike: the negative margins
                    take back the gaps of the column (`!`: the global reset gives buttons margin 0 and a rounded corner), and 3.5 pads
                    the button to the height of the area (8 + 32 + 8 px). */}
                <Tooltip placement="right" title={`${title} (${sectionChats.length})`}>
                  <button
                    type="button"
                    className={`flex w-full cursor-pointer items-center justify-between whitespace-nowrap !-my-2 !rounded-none py-3.5 pl-0.5 pr-[3.75px] group-data-[mobile=true]/sidebar:!pl-px group-data-[mobile=true]/sidebar:!pr-[3px] ${RAIL_CHAT_LOOK}`}
                    aria-expanded={open}
                    aria-label={`${title}: ${sectionChats.length}`}
                    data-selected={lit ? 'true' : 'false'}
                    data-messenger-rail-section-toggle={key}
                    aria-disabled={empty || undefined}
                    onClick={() => {
                      if (!empty) toggleSection(key);
                    }}
                  >
                    {/* From the left edge of the rail: icon, a small gap, the count, then the free space, and the chevron near the right
                        edge. Sized for a count of 4 digits (9999) in a 56 px rail, 47.5 px on a phone: the sizes are set on the parts,
                        not on the button (the global reset gives the button its own font size, and the MUI icon sets its own, hence the `!`).
                        Width, desktop: 1.75 + 15 + 1 + 22.9 (4 digits at 10 px) + 11 + 3.75 = 55.4 of 56 px. */}
                    <span className="flex min-w-0 items-center gap-px">
                      <Icon
                        fontSize="small"
                        className="!size-[15px] shrink-0 opacity-70 group-data-[mobile=true]/sidebar:!size-[13px]"
                      />
                      <span className="text-[10px] leading-none opacity-70 group-data-[mobile=true]/sidebar:text-[8.5px]">
                        {sectionChats.length}
                      </span>
                    </span>
                    <ExpandMoreIcon
                      className={`!size-[11px] shrink-0 opacity-60 transition-transform duration-200 group-data-[mobile=true]/sidebar:!size-[9px] motion-reduce:transition-none ${
                        open ? '' : '-rotate-90'
                      }`}
                    />
                  </button>
                </Tooltip>
                {/* Opens and closes like the sections of the full sidebar. The negative margin takes back the gap above it, which
                    is there even at zero height. */}
                <Collapse in={open} unmountOnExit className="-mt-2 w-full">
                  <ChatRows
                    chats={sectionChats}
                    scroller={scroller}
                    container="w-full pt-2"
                    gap={{ plain: 'gap-2', row: 'pb-2' }}
                    render={(chat) => (
                      <RailButton
                        avatar
                        label={chatLabel(chat)}
                        selected={chat.id === selectedChatId}
                        onClick={() => onSelectChat(chat.id)}
                        data-messenger-rail-chat={chat.id}
                      >
                        <MessengerAccountAvatar
                          account={{
                            id: chat.id,
                            name: chatLabel(chat),
                            phone: '',
                          }}
                          className={RAIL_AVATAR_SIZE}
                        />
                      </RailButton>
                    )}
                  />
                </Collapse>
              </div>
            );
          })}
          <Separator name="sections-end" />
        </>
      )}
    </aside>
  );
}

// The account sidebar: the full one or, hidden, a rail of icons and avatars. Both stay mounted and the box slides
// between their widths while they cross-fade, so the full sidebar keeps its search text and does not reflow. The
// panel toggle is one button over both: it floats over the top right corner of the account info and slides along
// with the box to the top of the rail.
//
// On a phone (below the `sm` breakpoint, like the rest of the page) the open sidebar takes the whole width and hides the
// page beside it, and whatever leads somewhere (a chat, the contacts, the account cards) closes it to show the place.
// That state is not remembered: it starts closed and does not touch the choice made on a wide screen.
export function MessengerAccountSidebar({ mobile, ...props }: SidebarProps & { mobile: boolean }) {
  const [desktopOpen, setDesktopOpen] = useAccountSidebarOpen();
  const [mobileOpen, setMobileOpen] = useState(false);
  const open = mobile ? mobileOpen : desktopOpen;
  const setOpen = mobile ? setMobileOpen : setDesktopOpen;
  const closeOnPhone = () => {
    if (mobile) setMobileOpen(false);
  };
  const sidebarProps: SidebarProps = {
    ...props,
    onSelectChat: (chatId) => {
      props.onSelectChat(chatId);
      closeOnPhone();
    },
    onOpenContacts: () => {
      props.onOpenContacts();
      closeOnPhone();
    },
    onOpenAccount: () => {
      props.onOpenAccount();
      closeOnPhone();
    },
  };
  const fullWidth = mobile ? 'w-full' : 'w-72';
  const railWidth = mobile ? 'w-[calc(3.25rem_+_2px)]' : 'w-16';
  const layer = (active: boolean, width: string, top = 'top-0') =>
    `absolute ${top} bottom-0 left-0 ${width} transition-opacity duration-200 motion-reduce:transition-none ${
      active ? 'opacity-100' : 'pointer-events-none opacity-0'
    }`;
  return (
    <div
      className={`group/sidebar relative shrink-0 overflow-hidden border-r border-solid ${DIVIDER} transition-[width] duration-200 ease-in-out motion-reduce:transition-none ${
        open ? fullWidth : railWidth
      }`}
      data-messenger-sidebar
      data-open={open ? 'true' : 'false'}
      data-mobile={mobile ? 'true' : 'false'}
    >
      {/* First in the document, so it is the first stop of the keyboard, and above both layers. It hangs on the
          right edge of the box, which moves with the box, and is centered over the rail when closed. Open, it is 3 px further
          in than 0.5 rem, so it does not touch the scrollbar of the full sidebar. The offsets
          are in rem like the widths of the box, so they hold at any root font size. */}
      <div
        className={`absolute top-2 z-10 transition-[right] duration-200 ease-in-out motion-reduce:transition-none ${
          open
            ? 'right-[calc(0.5rem_+_4px)]'
            : mobile
              ? 'right-[calc((3.25rem_+_2px_-_32px)_/_2)]'
              : 'right-[calc((4rem_-_32px)_/_2)]'
        }`}
        data-messenger-sidebar-toggle
      >
        <SidePanelToggleButton
          side="left"
          active={open}
          label={open ? 'Згорнути панель акаунту' : 'Розгорнути панель акаунту'}
          size={32}
          onClick={() => setOpen(!open)}
        />
      </div>
      <ExpandedSidebar {...sidebarProps} className={layer(open, fullWidth)} hidden={!open} />
      <CollapsedSidebar
        {...sidebarProps}
        // The rail starts below the toggle, so its buttons scroll under the edge of the box, not under the toggle.
        className={layer(!open, railWidth, 'top-12')}
        hidden={open}
      />
    </div>
  );
}
