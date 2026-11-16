import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import DownloadIcon from '@mui/icons-material/Download';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import LinkIcon from '@mui/icons-material/Link';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import {
  Button,
  Checkbox,
  CircularProgress,
  Skeleton,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Virtuoso, VirtuosoGrid } from 'react-virtuoso';

import type { MessengersAttachmentItem } from '../../../../../Bindings';
import { copyTextToClipboard } from '../../../../copy-to-clipboard';
import { PowerAlert } from '../../../components/PowerAlert';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import { downloadBlob } from '../../../utils/download-blob';
import {
  MessageCardAttachmentPreviewProvider,
  type MessageCardPreviewAttachment,
} from '../../shared/message-card/attachment-preview/MessageCardAttachmentPreviewProvider';
import {
  MessageMediaAudioPlayer,
  guardMessageCardDownloadClick,
  mediaAttachmentContentType,
  mediaAttachmentDisplayName,
  mediaAttachmentSizeBytes,
  mediaDownloadAttr,
  messageCardMediaDownloadKey,
  useMessageCardDownloadGuard,
  type MessageCardDownloadGuardProps,
} from '../../shared/message-card/MessageCardMedia';
import { MessageCardAudioTranscription } from '../../shared/message-card/MessageCardAudioTranscription';
import { collectMessageDocuments } from '../../shared/message-card/message-card-document-utils';
import {
  collectMessageImages,
  formatSizeBytes,
} from '../../shared/message-card/message-card-image-utils';
import { blurActiveElement } from '../../../utils/focus';
import { buildMessengerChatLink } from '../helpers';
import { GalleryThumbImage } from './MessengerGalleryThumb';
import {
  GALLERY_TABS,
  GALLERY_TAB_LABELS,
  messengerGallerySource,
  type GalleryDataSource,
  type GalleryTab,
} from '../messenger-gallery';
import { useMessengerGallery, useMessengerGalleryCounts } from '../use-messenger-gallery';

// How far from the end of the grid the reader still counts as being at the end of the loaded items.
const LOAD_MORE_THRESHOLD_PX = 600;
// An open preview asks for the next page once it is this close to the last loaded item (the preview wraps round at the end
// of the list it was given, so it must not reach the end while older items are still on the server).
const PREVIEW_PRELOAD_AHEAD = 10;

// Inline style: Virtuoso's own list class sets `display: flex`, and a utility class would only win by stylesheet order.
const GRID_LIST_STYLE = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(124px, 1fr))',
  gap: 10,
} as const;
const GridList = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ style, ...props }, ref) => (
    <div ref={ref} {...props} style={{ ...style, ...GRID_LIST_STYLE }} />
  ),
);
GridList.displayName = 'GalleryGridList';
const GRID_COMPONENTS = { List: GridList };
const itemKey = (_index: number, item: MessengersAttachmentItem) => item.attachment.media.id;

type Props = {
  accountId: string;
  // null: every chat of the account (the account gallery); each item then carries its own chat.
  chatId: string | null;
  refreshToken?: number;
  // Opens the chat at a message (the tile's "go to message").
  onOpenMessage?: (chatId: string, messageId: string) => void;
  source?: GalleryDataSource;
};

type Preview = { mediaId: string; attachment: MessageCardPreviewAttachment };

const mediaOf = (item: MessengersAttachmentItem) => item.attachment.media;

// One formatter for every tile: `toLocaleDateString` builds a new `Intl.DateTimeFormat` on each call (~40 times slower).
const dateFormat = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
});
const formatDate = (epochMs: number) => dateFormat.format(epochMs);

// The preview dialog item of a gallery item, or null when it only downloads (audio plays in place).
function previewOf(tab: GalleryTab, item: MessengersAttachmentItem): Preview | null {
  const media = mediaOf(item);
  if (tab === 'photo') {
    const [image] = collectMessageImages({ images: [], media: [media] });
    return image && { mediaId: media.id, attachment: { type: 'image', value: image } };
  }
  if (tab === 'video') {
    return {
      mediaId: media.id,
      attachment: {
        type: 'video',
        value: {
          id: media.id,
          name: mediaAttachmentDisplayName(media),
          source: media.href,
          mimeType: mediaAttachmentContentType(media) || undefined,
          sizeBytes: media.sizeBytes,
        },
      },
    };
  }
  if (tab === 'document') {
    const [document] = collectMessageDocuments({ media: [media] });
    return document?.kind !== 'unsupported' && document
      ? { mediaId: media.id, attachment: { type: 'document', value: document } }
      : null;
  }
  return null;
}

// The controls of a tile are plain elements with static classes (the rule for repeated nodes in
// `shared/message-card/AGENTS.md`): a MUI button, tooltip or checkbox with `sx` per tile cost Emotion work on every mount.
// `!`: the global styles of buttons and links (Bootstrap's reboot, outside Tailwind's layers) beat plain utilities: they
// square a button and recolor a link.
const TILE_BUTTON_CLASS =
  'inline-flex h-[22px] w-[22px] cursor-pointer items-center justify-center !rounded-full !border-0 !bg-[rgba(15,23,42,0.42)] !p-0 !text-[rgba(255,255,255,0.92)] hover:!bg-[rgba(15,23,42,0.64)] hover:!text-[rgba(255,255,255,0.92)] focus-visible:!bg-[rgba(15,23,42,0.64)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-action)] [&_svg]:!h-[15px] [&_svg]:!w-[15px]';

function TileIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={TILE_BUTTON_CLASS}
    >
      {children}
    </button>
  );
}

// The regular echo checkbox (the one of the filters: MUI's `Checkbox`, same ripple, tick and theme colors), small. Over a cover it
// sits on the same round translucent backing as the other controls of the tile, with the same hover; the unchecked box is drawn in
// the white of their icons, and checked it keeps the theme's primary color. Classes with `!`: the MUI styles are outside Tailwind's
// layers and beat plain utilities. In a row, with no cover under it, it is the plain small checkbox.
function TileCheckbox({
  checked,
  label,
  onChange,
  overCover = false,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
  overCover?: boolean;
}) {
  const checkbox = (
    <Checkbox
      size="small"
      checked={checked}
      onChange={onChange}
      inputProps={{ 'aria-label': label }}
      className={
        overCover
          ? `!p-0 [&_svg]:!h-[16px] [&_svg]:!w-[16px] ${checked ? '' : '!text-[rgba(255,255,255,0.92)]'}`
          : '!p-[2px]'
      }
    />
  );
  return overCover ? (
    <div className="absolute left-1 top-1 z-[4] flex h-[22px] w-[22px] items-center justify-center rounded-full bg-[rgba(15,23,42,0.42)] hover:bg-[rgba(15,23,42,0.64)]">
      {checkbox}
    </div>
  ) : (
    checkbox
  );
}

type TileProps = MessageCardDownloadGuardProps & {
  tab: GalleryTab;
  item: MessengersAttachmentItem;
  // Position among the previewable items of the tab, or null.
  previewIndex: number | null;
  selected: boolean;
  canOpenMessage: boolean;
  onToggle: (mediaId: string) => void;
  onOpen: (index: number) => void;
  onOpenMessage: (chatId: string, messageId: string) => void;
  onCopyLink: (item: MessengersAttachmentItem) => void;
};

function TileActions({
  item,
  canOpenMessage,
  onOpenMessage,
  onCopyLink,
}: Pick<TileProps, 'item' | 'canOpenMessage' | 'onOpenMessage' | 'onCopyLink'>) {
  return (
    <>
      {canOpenMessage ? (
        <TileIconButton
          label="Перейти до повідомлення"
          onClick={() => onOpenMessage(item.chatId, item.messageId)}
        >
          <ChatBubbleOutlineIcon />
        </TileIconButton>
      ) : null}
      <TileIconButton label="Копіювати посилання на повідомлення" onClick={() => onCopyLink(item)}>
        <LinkIcon />
      </TileIconButton>
    </>
  );
}

function TileDownloadLink({
  media,
  name,
  fallbackName,
  corner = false,
  isDownloadStarting,
  onDownloadStart,
}: MessageCardDownloadGuardProps & {
  media: MessengersAttachmentItem['attachment']['media'];
  name: string;
  fallbackName: string;
  // On the top right corner of a tile, over the cover; otherwise in the flow of a row.
  corner?: boolean;
}) {
  if (media.href.trim() === '') return null;
  const downloadKey = messageCardMediaDownloadKey(media.id);
  const downloading = isDownloadStarting(downloadKey);
  const label = `Завантажити вкладення: ${name}`;
  return (
    <a
      href={media.href}
      download={mediaDownloadAttr(name, fallbackName)}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={downloading ? 'Завантаження…' : label}
      aria-busy={downloading}
      data-message-card-attachment-download="true"
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        event.stopPropagation();
        guardMessageCardDownloadClick(event, downloadKey, { isDownloadStarting, onDownloadStart });
      }}
      className={`${TILE_BUTTON_CLASS} ${corner ? 'absolute right-[5px] top-[5px] z-[3]' : 'shrink-0'} ${
        downloading ? 'pointer-events-none opacity-60' : ''
      }`}
    >
      <DownloadIcon aria-hidden />
    </a>
  );
}

function TileCover({
  tab,
  item,
  previewIndex,
  onOpen,
  isDownloadStarting,
  onDownloadStart,
}: TileProps) {
  const media = mediaOf(item);
  const name = mediaAttachmentDisplayName(media);
  const extension = name.includes('.') ? name.split('.').pop()?.toUpperCase() : null;
  const label =
    tab === 'photo'
      ? 'Відкрити зображення'
      : tab === 'video'
        ? 'Відкрити відео'
        : `Відкрити ${name}`;
  return (
    <div
      className="relative h-full w-full"
      title={
        previewIndex == null
          ? 'Цей файл не можна переглянути тут, його можна лише завантажити.'
          : undefined
      }
    >
      <button
        type="button"
        disabled={previewIndex == null}
        aria-label={label}
        onClick={() => {
          blurActiveElement();
          onOpen(previewIndex ?? 0);
        }}
        className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-1 !rounded-md !border-0 bg-[color-mix(in_srgb,var(--color-action)_8%,transparent)] !p-0 text-inherit focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-action)] disabled:cursor-default"
      >
        {tab === 'photo' || tab === 'video' ? (
          <GalleryThumbImage media={media} video={tab === 'video'} />
        ) : (
          <>
            <InsertDriveFileOutlinedIcon aria-hidden className="text-[var(--color-text-muted)]" />
            <span className="rounded bg-[var(--color-divider)] px-1 text-[0.65rem] font-semibold">
              {extension ?? 'FILE'}
            </span>
          </>
        )}
      </button>
      <TileDownloadLink
        media={media}
        name={name}
        fallbackName={tab === 'document' ? 'document' : 'attachment'}
        corner
        isDownloadStarting={isDownloadStarting}
        onDownloadStart={onDownloadStart}
      />
    </div>
  );
}

const SELECTED_RING = 'ring-2 ring-[var(--color-action)]';
const IDLE_RING = 'ring-[var(--color-divider)]';

// Memoized, with primitive and stable props only, so a selection or a page that arrives re-renders the tiles that changed.
const GalleryTile = memo(function GalleryTile(props: TileProps) {
  const { item, selected, onToggle, canOpenMessage, onOpenMessage, onCopyLink } = props;
  const media = mediaOf(item);
  const name = mediaAttachmentDisplayName(media);
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-gallery-tile={media.id}>
      <div
        className={`relative aspect-square overflow-hidden rounded-md ring-1 ${
          selected ? SELECTED_RING : IDLE_RING
        }`}
      >
        <div className="absolute inset-0">
          <TileCover {...props} />
        </div>
        <TileCheckbox
          overCover
          checked={selected}
          label={`Обрати ${name}`}
          onChange={() => onToggle(media.id)}
        />
        <div className="absolute bottom-1 left-1 z-[4] flex gap-1">
          <TileActions
            item={item}
            canOpenMessage={canOpenMessage}
            onOpenMessage={onOpenMessage}
            onCopyLink={onCopyLink}
          />
        </div>
      </div>
      <span className="truncate text-xs" title={name}>
        {name}
      </span>
      <span className="flex justify-between gap-1 text-[0.7rem] opacity-70">
        <span>{formatDate(item.sentAt)}</span>
        <span>{formatSizeBytes(mediaAttachmentSizeBytes(media))}</span>
      </span>
    </div>
  );
});

// A row is a plain line until it is pressed. The shared player asks for the waveform, the spectrogram and the whole audio
// file when it mounts (3 requests a row, measured), which is too much for a list that scrolls through hundreds of voice
// messages; so the player mounts on the first press, and starts playing. Scrolling the row away unmounts it again.
const GalleryAudioRow = memo(function GalleryAudioRow(props: TileProps) {
  const { item, selected, onToggle, canOpenMessage, onOpenMessage, onCopyLink } = props;
  const [playerMounted, setPlayerMounted] = useState(false);
  const media = mediaOf(item);
  const name = mediaAttachmentDisplayName(media);
  const transcription = media.transcription?.trim() ?? '';
  return (
    <div
      className={`flex flex-col gap-1 rounded-md p-1.5 ring-1 ${selected ? SELECTED_RING : IDLE_RING}`}
      data-gallery-tile={media.id}
    >
      <div className="flex items-center gap-1.5 text-xs">
        <TileCheckbox
          checked={selected}
          label={`Обрати ${name}`}
          onChange={() => onToggle(media.id)}
        />
        <span className="shrink-0 opacity-70">{formatDate(item.sentAt)}</span>
        <span className="min-w-0 flex-1 truncate" title={name}>
          {name}
        </span>
        <TileActions
          item={item}
          canOpenMessage={canOpenMessage}
          onOpenMessage={onOpenMessage}
          onCopyLink={onCopyLink}
        />
        {playerMounted ? null : (
          <TileDownloadLink
            media={media}
            name={name}
            fallbackName="audio"
            isDownloadStarting={props.isDownloadStarting}
            onDownloadStart={props.onDownloadStart}
          />
        )}
      </div>
      {playerMounted ? (
        <MessageMediaAudioPlayer
          attachment={media}
          isDownloadStarting={props.isDownloadStarting}
          onDownloadStart={props.onDownloadStart}
          onPlayerChange={(player) => {
            void player?.play?.()?.catch(() => {});
          }}
        />
      ) : (
        <>
          <button
            type="button"
            onClick={() => setPlayerMounted(true)}
            aria-label={`Відтворити ${name}`}
            className="flex h-[40px] w-full cursor-pointer items-center gap-2 !rounded border border-[var(--color-divider)] bg-transparent px-2 text-left text-xs text-inherit hover:bg-[color-mix(in_srgb,var(--color-action)_8%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-action)]"
          >
            <PlayArrowIcon aria-hidden className="!h-5 !w-5" />
            <span className="opacity-70">{formatSizeBytes(mediaAttachmentSizeBytes(media))}</span>
          </button>
          {transcription !== '' ? (
            <MessageCardAudioTranscription transcription={transcription} />
          ) : null}
        </>
      )}
    </div>
  );
});

// The media of one analysis messenger chat for the right panel, like kontur's Media tab: tabs by kind with counts,
// a grid of the shared attachment tiles, selection with a ZIP, the shared preview dialog, "go to message" and "copy link".
// Counts, "select all" over unloaded pages and the ZIP wait for the backend (see `GalleryDataSource`); without them the
// tab labels have no numbers, "select all" takes what is loaded and the ZIP button stays disabled.
export function MessengerGallery({
  accountId,
  chatId,
  refreshToken = 0,
  onOpenMessage,
  source = messengerGallerySource,
}: Props) {
  // The page's own phone check (the same one the workspace makes), so the gallery is also tight in the right panel.
  const phone = useMediaQuery(useTheme().breakpoints.down('sm'));
  // One padding for the bar of the tabs and for the grid below it.
  const gutter = phone ? 'p-2' : 'p-3';
  const [tab, setTab] = useState<GalleryTab>('photo');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  // The item the open preview is on (it moves by itself with the arrows).
  const [previewCurrent, setPreviewCurrent] = useState(0);
  const openPreview = useCallback((index: number) => {
    setPreviewIndex(index);
    setPreviewCurrent(index);
  }, []);
  const [busyAction, setBusyAction] = useState<'ids' | 'zip' | null>(null);
  const downloadGuard = useMessageCardDownloadGuard();
  const { notify } = useOptionalPowerSnackbar();
  const { items, loading, fetching, hasMore, error, loadMore, retry } = useMessengerGallery({
    source,
    accountId,
    chatId,
    tab,
    refreshToken,
  });
  const counts = useMessengerGalleryCounts({ accountId, chatId }, refreshToken, source);

  // Actions in flight end with the gallery (it is mounted once per chat).
  const actionControllerRef = useRef<AbortController>(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    actionControllerRef.current = controller;
    return () => controller.abort();
  }, []);

  const previews = useMemo(() => items.flatMap((item) => previewOf(tab, item) ?? []), [items, tab]);
  const previewIndexOf = useMemo(
    () => new Map(previews.map((preview, index) => [preview.mediaId, index])),
    [previews],
  );
  const previewAttachments = useMemo(
    () => previews.map((preview) => preview.attachment),
    [previews],
  );

  // The scroller holds the grid (Virtuoso scrolls in it) and the notices around it.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  // True once Virtuoso has laid the items out (the grid says so itself, the list reports a height).
  const [listReady, setListReady] = useState(false);
  const loadMoreWhenNearEnd = useCallback(() => {
    if (scroller == null || fetching || !hasMore) return;
    // Before the first layout the scroller is as short as its padding and would read as "at the end": that asked for a
    // second page although the first one filled the panel several times over.
    if (items.length > 0 && !listReady) return;
    if (
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <=
      LOAD_MORE_THRESHOLD_PX
    ) {
      loadMore();
    }
  }, [scroller, fetching, hasMore, loadMore, items.length, listReady]);
  // Tiles that do not fill the panel leave nothing to scroll, so the next page is asked for without a scroll.
  useEffect(loadMoreWhenNearEnd, [loadMoreWhenNearEnd, items.length]);

  // Every tab starts at the top and is laid out afresh (the scroller is shared by the tabs, so it would keep the offset).
  const changeTab = useCallback(
    (value: GalleryTab) => {
      setTab(value);
      setListReady(false);
      if (scroller != null) scroller.scrollTop = 0;
    },
    [scroller],
  );

  const toggle = useCallback(
    (mediaId: string) =>
      setSelected((previous) => {
        const next = new Set(previous);
        if (!next.delete(mediaId)) next.add(mediaId);
        return next;
      }),
    [],
  );
  // The tiles are memoized, so what they get must not change from one render to the next: `notify` and the parent's
  // `onOpenMessage` are read through refs.
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const onOpenMessageRef = useRef(onOpenMessage);
  onOpenMessageRef.current = onOpenMessage;
  const canOpenMessage = onOpenMessage != null;
  const openMessage = useCallback(
    (itemChatId: string, messageId: string) => onOpenMessageRef.current?.(itemChatId, messageId),
    [],
  );
  const copyLink = useCallback(
    (item: MessengersAttachmentItem) =>
      copyTextToClipboard(buildMessengerChatLink(item.chatId, item.messageId)).then(
        () => notifyRef.current({ severity: 'success', message: 'Посилання скопійовано.' }),
        () => notifyRef.current({ severity: 'error', message: 'Не вдалося скопіювати посилання.' }),
      ),
    [],
  );

  const scope = { accountId, chatId };
  // Selects every item of the tab (or deselects them all when they already are), loaded or not when the source can list them.
  const selectAll = async () => {
    setBusyAction('ids');
    try {
      const ids = source.ids
        ? await source.ids(scope, tab, actionControllerRef.current.signal)
        : items.map((item) => mediaOf(item).id);
      setSelected((previous) => {
        const next = new Set(previous);
        const everySelected = ids.length > 0 && ids.every((id) => previous.has(id));
        for (const id of ids) {
          if (everySelected) next.delete(id);
          else next.add(id);
        }
        return next;
      });
    } catch {
      notify({ severity: 'error', message: 'Не вдалося отримати список файлів.' });
    } finally {
      setBusyAction(null);
    }
  };
  const downloadZip = async () => {
    if (source.zip == null) return;
    setBusyAction('zip');
    try {
      const blob = await source.zip(scope, [...selected], actionControllerRef.current.signal);
      downloadBlob(
        blob,
        chatId == null ? `media_account_${accountId}.zip` : `media_chat_${chatId}.zip`,
      );
    } catch {
      notify({ severity: 'error', message: 'Не вдалося сформувати ZIP.' });
    } finally {
      setBusyAction(null);
    }
  };

  const { isDownloadStarting, onDownloadStart } = downloadGuard;
  const renderTile = useCallback(
    (_index: number, item: MessengersAttachmentItem) => {
      const mediaId = mediaOf(item).id;
      const props: TileProps = {
        tab,
        item,
        previewIndex: previewIndexOf.get(mediaId) ?? null,
        selected: selected.has(mediaId),
        canOpenMessage,
        onToggle: toggle,
        onOpen: openPreview,
        onOpenMessage: openMessage,
        onCopyLink: copyLink,
        isDownloadStarting,
        onDownloadStart,
      };
      return tab === 'audio' ? (
        <div className="pb-2">
          <GalleryAudioRow {...props} />
        </div>
      ) : (
        <GalleryTile {...props} />
      );
    },
    [
      tab,
      previewIndexOf,
      selected,
      canOpenMessage,
      toggle,
      openPreview,
      openMessage,
      copyLink,
      isDownloadStarting,
      onDownloadStart,
    ],
  );

  // Flicking through the preview goes on into the next page: it is asked for as soon as the preview is near the loaded end,
  // also when it is opened there. `loadMore` does nothing while a page is on its way or when there is none.
  useEffect(() => {
    if (
      previewIndex != null &&
      previewAttachments.length - 1 - previewCurrent <= PREVIEW_PRELOAD_AHEAD
    ) {
      loadMore();
    }
  }, [previewIndex, previewCurrent, previewAttachments.length, loadMore]);

  const empty = !loading && !fetching && !hasMore && error == null && items.length === 0;
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={chatId == null ? 'Медіа акаунта' : 'Медіа чату'}
      data-messenger-gallery
    >
      <div
        className={`flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-divider)] ${gutter}`}
      >
        <ToggleButtonGroup
          exclusive
          size="small"
          value={tab}
          onChange={(_event, value: GalleryTab | null) => value != null && changeTab(value)}
          aria-label="Тип медіа"
          // On a phone the tabs fill the row: no empty space beside them, and each tab grows with its number.
          sx={phone ? { width: '100%' } : undefined}
        >
          {GALLERY_TABS.map((value) => (
            <ToggleButton
              key={value}
              value={value}
              // On a phone the four tabs share one line: a smaller text and 6 px less padding on each side; the label never wraps.
              sx={{
                textTransform: 'none',
                whiteSpace: 'nowrap',
                px: phone ? 0.5 : 1.25,
                ...(phone ? { flex: '1 1 auto', fontSize: 12, lineHeight: 1.3 } : {}),
              }}
            >
              {GALLERY_TAB_LABELS[value]}
              {counts ? ` (${counts[value]})` : ''}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <div className={`flex items-center gap-2 ${phone ? 'w-full' : ''}`}>
          <Button
            size="small"
            variant="outlined"
            disabled={busyAction != null || (source.ids == null && items.length === 0)}
            startIcon={busyAction === 'ids' ? <CircularProgress size={14} /> : undefined}
            onClick={() => void selectAll()}
            sx={{ textTransform: 'none', ...(phone ? { flex: 1 } : {}) }}
          >
            Вибрати всі
          </Button>
          <Tooltip
            title={source.zip == null ? 'Завантаження ZIP з’явиться пізніше' : ''}
            disableInteractive
          >
            <span className={phone ? 'flex-1' : undefined}>
              <Button
                size="small"
                variant="outlined"
                disabled={source.zip == null || selected.size === 0 || busyAction != null}
                startIcon={busyAction === 'zip' ? <CircularProgress size={14} /> : <DownloadIcon />}
                onClick={() => void downloadZip()}
                sx={{ textTransform: 'none', ...(phone ? { width: '100%' } : {}) }}
              >
                ZIP ({selected.size})
              </Button>
            </span>
          </Tooltip>
        </div>
      </div>
      <div
        ref={setScroller}
        onScroll={loadMoreWhenNearEnd}
        className={`slim-scrollbar min-h-0 flex-1 overflow-y-auto ${gutter}`}
      >
        {error != null ? (
          <PowerAlert
            severity="error"
            action={
              <button type="button" className="cursor-pointer underline" onClick={retry}>
                Повторити завантаження
              </button>
            }
          >
            {error}
          </PowerAlert>
        ) : null}
        {loading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(124px,1fr))] gap-2.5">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton
                key={index}
                variant="rectangular"
                className="!aspect-square !h-auto !rounded-md"
              />
            ))}
          </div>
        ) : scroller == null ? null : tab === 'audio' ? (
          <Virtuoso
            key="audio"
            customScrollParent={scroller}
            data={items}
            computeItemKey={itemKey}
            totalListHeightChanged={(height) => setListReady(height > 0)}
            itemContent={renderTile}
          />
        ) : (
          <VirtuosoGrid
            key={tab}
            customScrollParent={scroller}
            data={items}
            computeItemKey={itemKey}
            components={GRID_COMPONENTS}
            readyStateChanged={setListReady}
            itemContent={renderTile}
          />
        )}
        {fetching && !loading ? (
          <div className="flex justify-center p-2">
            <CircularProgress size={20} aria-label="Завантаження…" />
          </div>
        ) : null}
        {empty ? (
          <p className="p-1 opacity-60" role="status">
            {chatId == null ? 'В акаунті' : 'У цьому чаті'} немає медіа цього типу.
          </p>
        ) : null}
      </div>
      {previewIndex != null && previewAttachments.length > 0 ? (
        <MessageCardAttachmentPreviewProvider
          attachments={previewAttachments}
          initialIndex={previewIndex}
          onIndexChange={setPreviewCurrent}
          onClose={() => setPreviewIndex(null)}
          {...downloadGuard}
        />
      ) : null}
    </section>
  );
}
