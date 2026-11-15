import ReplyIcon from '@mui/icons-material/Reply';
import { AuthorLabel } from '../../../components/AuthorLabel';
import { useRadioFeatures } from '../RadioFeatures';
import MessageIcon from '@mui/icons-material/Message';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import AccountCircleOutlinedIcon from '@mui/icons-material/AccountCircleOutlined';
import BarChartIcon from '@mui/icons-material/BarChart';
import BookmarkIcon from '@mui/icons-material/Bookmark';
import BookmarkBorderOutlinedIcon from '@mui/icons-material/BookmarkBorderOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import DownloadIcon from '@mui/icons-material/Download';
import DevicesIcon from '@mui/icons-material/Devices';
import ChatBubbleOutlineOutlinedIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import EditIcon from '@mui/icons-material/Edit';
import DeskIcon from '@mui/icons-material/Desk';
import DeskOutlinedIcon from '@mui/icons-material/DeskOutlined';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import GraphicEqOutlinedIcon from '@mui/icons-material/GraphicEqOutlined';
import SquareTwoToneIcon from '@mui/icons-material/SquareTwoTone';
import FlagIcon from '@mui/icons-material/Flag';
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import LaunchIcon from '@mui/icons-material/Launch';
import LinkIcon from '@mui/icons-material/Link';
import MapIcon from '@mui/icons-material/Map';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PeopleIcon from '@mui/icons-material/People';
import PeopleOutlineOutlinedIcon from '@mui/icons-material/PeopleOutlineOutlined';
import PlaceIcon from '@mui/icons-material/Place';
import PlaceOutlinedIcon from '@mui/icons-material/PlaceOutlined';
import RemoveIcon from '@mui/icons-material/Remove';
import TodayOutlinedIcon from '@mui/icons-material/TodayOutlined';
import SettingsInputAntennaIcon from '@mui/icons-material/SettingsInputAntenna';
import SettingsInputAntennaOutlinedIcon from '@mui/icons-material/SettingsInputAntennaOutlined';
import { Divider, Menu, MenuItem } from '@mui/material';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { cloneElement, memo, useContext, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, MouseEvent, ReactNode, RefObject } from 'react';
import { APP_TIME_ZONE, ELLIPSIS, isPresent } from '../../../utils/misc';
import { blurActiveElement } from '../../../utils/focus';

import type { InboxMessage } from '../../../../../Bindings';
import type {
  MessageEntityExcludeMenuOption,
  MessageEntityFilterKind,
} from '../../rer-duty-neo/utils';
import { formatDateNoYear, formatTime } from '../../rer-duty-neo/utils';
import {
  buildMessageCardNavigationMenuItems,
  type MessageCardEtalonDisplayModel,
  type MessageCardNavigationMenuItem,
  type MessageCardRenderedNetwork,
} from './message-card.utils';
import { MessageCardQuickActionContext } from './MessageCardQuickAction';
import { useMessageDeviceAccess } from './MessageDeviceAccess';
import { useMessageCardDateDisplayMs } from './useMessageCardDateDisplayMs';

dayjs.extend(customParseFormat);

const COPY_TITLE = `Копіювати${ELLIPSIS}`;
const NAVIGATE_TITLE = `Перейти${ELLIPSIS}`;
const EXCLUDE_TITLE = `Виключити${ELLIPSIS}`;
const MESSAGE_CARD_COMPACT_ACTIONS_MAX_WIDTH_PX = 520;

export type MessageCardDisplayMode = 'duty' | 'analysis';

export enum MessageCardMetadataPlacement {
  All = 'all',
  Header = 'header',
  Content = 'content',
}

type ActionIconsRowProps = {
  id: number;
  msg: InboxMessage;
  readOnly?: boolean;
  displayMode: MessageCardDisplayMode;
  excludeMenuOptions?: MessageEntityExcludeMenuOption[];
  etalonDisplayModel: MessageCardEtalonDisplayModel;
  navigationMenuItems?: MessageCardNavigationMenuItem[];
  copiedFeedbackId: string | null;
  onBookmark?: () => void;
  onImportant?: () => void;
  onReply?: (focusTarget: HTMLElement) => void;
  onCreateReport?: (focusTarget: HTMLElement) => void;
  onCopyText?: () => void;
  onCopyFreq?: () => void;
  onCopyTextWithNetwork?: () => void;
  onCopyTextWithNetworkAndNote?: () => void;
  onCopyMessageLink?: () => void;
  onCopyEtalon?: () => void;
  onCopyLocation?: () => void;
  onDelete?: () => void;
  onEditDetails?: (focusTarget: HTMLElement) => void;
  onExcludeMessageEntity?: (entity: MessageEntityFilterKind, value: string) => void;
  attachmentArchiveDownload?: MessageCardAttachmentArchiveDownloadAction;
  headerRowRef: RefObject<HTMLDivElement | null>;
  onCompactChange: (compact: boolean) => void;
};

export type MessageCardAttachmentArchiveDownloadAction = {
  href: string;
  download: string;
  label: string;
  disabled: boolean;
  ariaBusy: boolean;
  ariaLabel: string;
  onClick: (event: MouseEvent<HTMLElement>) => void;
};

type MenuAnchorPosition = {
  top: number;
  left: number;
};

type OverflowMenuItem = {
  key: string;
  title: string;
  icon: JSX.Element;
  selected: boolean;
  secondary?: boolean;
  href?: string;
  download?: string;
  disabled?: boolean;
  ariaBusy?: boolean;
  ariaLabel?: string;
  onClick: (event: MouseEvent<HTMLElement>) => void;
};

function ActionIconButton({
  title,
  icon,
  onClick,
  selected = false,
  importantAction = false,
  buttonProps,
}: {
  title: string;
  icon: JSX.Element;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  selected?: boolean;
  importantAction?: boolean;
  buttonProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick' | 'type'>;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-selected={selected ? 'true' : undefined}
      data-important-action={importantAction ? 'true' : undefined}
      className="message-card-action-btn"
      onClick={(event) => {
        blurActiveElement();
        onClick(event);
      }}
      {...buttonProps}
    >
      {icon}
    </button>
  );
}

function MenuRow({ icon, children }: { icon: JSX.Element; children: ReactNode }) {
  return (
    <span className="message-card-header-menu-row">
      {icon}
      <span className="message-card-header-menu-row__label">{children}</span>
    </span>
  );
}

function HeaderText({
  children,
  nowrap = false,
  wrap = false,
  className,
}: {
  children: ReactNode;
  nowrap?: boolean;
  wrap?: boolean;
  className?: string;
}) {
  const classes = [
    'message-card-text',
    nowrap ? 'message-card-text--nowrap' : null,
    wrap ? 'message-card-text--wrap' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes} data-message-card-text="body2">
      {children}
    </span>
  );
}

type OverflowCopyPanelProps = {
  hasCopyTextWithNetwork: boolean;
  hasCopyTextWithNetworkAndNote: boolean;
  hasFrequencyCopy: boolean;
  canShowLocationCopy: boolean;
  hasEtalonCopy: boolean;
  onCopyText: () => void;
  onCopyTextWithNetwork?: () => void;
  onCopyTextWithNetworkAndNote?: () => void;
  onCopyFreq?: () => void;
  onCopyMessageLink?: () => void;
  onCopyLocation?: () => void;
  onCopyEtalon?: () => void;
  onClose: () => void;
};

function renderCopyMenuItems({
  hasCopyTextWithNetwork,
  hasCopyTextWithNetworkAndNote,
  hasFrequencyCopy,
  canShowLocationCopy,
  hasEtalonCopy,
  onCopyText,
  onCopyTextWithNetwork,
  onCopyTextWithNetworkAndNote,
  onCopyFreq,
  onCopyMessageLink,
  onCopyLocation,
  onCopyEtalon,
  onClose,
}: OverflowCopyPanelProps) {
  const runAndClose = (action: () => void) => {
    action();
    onClose();
  };

  return [
    <MenuItem key="copyText" onClick={() => runAndClose(onCopyText)}>
      <MenuRow icon={<MessageIcon fontSize="small" />}>Копіювати повідомлення</MenuRow>
    </MenuItem>,
    hasCopyTextWithNetwork ? (
      <MenuItem key="network" onClick={() => runAndClose(onCopyTextWithNetwork!)}>
        <MenuRow icon={<PeopleIcon fontSize="small" />}>
          Копіювати повідомлення з назвою мережі
        </MenuRow>
      </MenuItem>
    ) : null,
    hasCopyTextWithNetworkAndNote ? (
      <MenuItem key="note" onClick={() => runAndClose(onCopyTextWithNetworkAndNote!)}>
        <MenuRow icon={<ChatBubbleOutlineOutlinedIcon fontSize="small" />}>
          Копіювати повідомлення з мережею та коментарем
        </MenuRow>
      </MenuItem>
    ) : null,
    hasFrequencyCopy ? (
      <MenuItem key="freq" onClick={() => runAndClose(onCopyFreq!)}>
        <MenuRow icon={<SettingsInputAntennaIcon fontSize="small" />}>Копіювати частоту</MenuRow>
      </MenuItem>
    ) : null,
    isPresent(onCopyMessageLink) ? (
      <MenuItem key="copyLink" onClick={() => runAndClose(onCopyMessageLink)}>
        <MenuRow icon={<LinkIcon fontSize="small" />}>Копіювати посилання на повідомлення</MenuRow>
      </MenuItem>
    ) : null,
    canShowLocationCopy ? (
      <MenuItem key="location" onClick={() => runAndClose(onCopyLocation!)}>
        <MenuRow icon={<PlaceIcon fontSize="small" />}>Копіювати локацію</MenuRow>
      </MenuItem>
    ) : null,
    hasEtalonCopy ? (
      <MenuItem key="etalon" onClick={() => runAndClose(onCopyEtalon!)}>
        <MenuRow icon={<PeopleIcon fontSize="small" />}>Копіювати прив&apos;язку</MenuRow>
      </MenuItem>
    ) : null,
  ].filter((item): item is JSX.Element => item != null);
}

function renderNavigationMenuItems({
  items,
  onClose,
}: {
  items: MessageCardNavigationMenuItem[];
  onClose: () => void;
}) {
  return items.map((item) => (
    <MenuItem
      key={`${item.kind}:${item.href}`}
      component="a"
      href={item.href}
      target="_blank"
      rel="noopener noreferrer"
      title={item.kind === 'network' ? item.networkLabel : undefined}
      onClick={onClose}
      sx={{ maxWidth: 320, overflow: 'hidden' }}
    >
      <MenuRow
        icon={
          item.kind === 'network' ? (
            <PeopleIcon fontSize="small" />
          ) : item.kind === 'map' ? (
            <MapIcon fontSize="small" />
          ) : (
            <BarChartIcon fontSize="small" />
          )
        }
      >
        {item.kind === 'network' ? (
          <>
            В мережу <strong>{item.networkLabel}</strong>
            {item.badge ? (
              <span className="badge badge-no-unit-sm ml-[0.35em] align-middle relative -top-[0.06em]">
                в дорозвідці
              </span>
            ) : null}
          </>
        ) : item.kind === 'map' ? (
          (item.label ?? 'На мапу')
        ) : (
          (item.label ?? 'В аналіз')
        )}
      </MenuRow>
    </MenuItem>
  ));
}

function renderExcludeMenuItems({
  options,
  onExclude,
  onClose,
}: {
  options: MessageEntityExcludeMenuOption[];
  onExclude?: (entity: MessageEntityFilterKind, value: string) => void;
  onClose: () => void;
}) {
  return options.map((option) => (
    <MenuItem
      key={`${option.entity}:${option.value}`}
      onClick={() => {
        onExclude?.(option.entity, option.value);
        onClose();
      }}
    >
      <MenuRow
        icon={
          option.entity === 'group' ? (
            <GraphicEqIcon fontSize="small" />
          ) : option.entity === 'sender' ? (
            <AccountCircleIcon fontSize="small" />
          ) : option.entity === 'freq' ? (
            <SettingsInputAntennaIcon fontSize="small" />
          ) : (
            <DeskIcon fontSize="small" />
          )
        }
      >
        {option.entity === 'group'
          ? 'Виключити групу'
          : option.entity === 'sender'
            ? 'Виключити відправника'
            : option.entity === 'freq'
              ? 'Виключити частоту'
              : 'Виключити пост'}{' '}
        <strong>{option.label}</strong>
      </MenuRow>
    </MenuItem>
  ));
}

function ActionIconsRow({
  id,
  msg,
  readOnly = false,
  displayMode,
  excludeMenuOptions = [],
  etalonDisplayModel,
  copiedFeedbackId,
  navigationMenuItems = [],
  onBookmark,
  onImportant,
  onReply,
  onCreateReport,
  onCopyText,
  onCopyFreq,
  onCopyTextWithNetwork,
  onCopyTextWithNetworkAndNote,
  onCopyMessageLink,
  onCopyEtalon,
  onCopyLocation,
  onDelete,
  onEditDetails,
  onExcludeMessageEntity,
  attachmentArchiveDownload,
  headerRowRef,
  onCompactChange,
}: ActionIconsRowProps) {
  const messageCardQuickAction = useContext(MessageCardQuickActionContext) ?? 'createReport';
  const rootRef = useRef<HTMLDivElement | null>(null);
  const excludeMenuId = useId();
  const copyMenuId = useId();
  const overflowMenuId = useId();
  const navigationMenuId = useId();
  const [excludeMenuAnchorPosition, setExcludeMenuAnchorPosition] =
    useState<MenuAnchorPosition | null>(null);
  const [copyMenuAnchorPosition, setCopyMenuAnchorPosition] = useState<MenuAnchorPosition | null>(
    null,
  );
  const [overflowMenuAnchorPosition, setOverflowMenuAnchorPosition] =
    useState<MenuAnchorPosition | null>(null);
  const [navigationMenuAnchorPosition, setNavigationMenuAnchorPosition] =
    useState<MenuAnchorPosition | null>(null);
  const overflowMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [mobileActions, setMobileActions] = useState(false);
  const canShowCreateReport = !readOnly && isPresent(onCreateReport);
  const canShowReply = !readOnly && isPresent(onReply);
  const canShowPrimaryActions =
    !readOnly && isPresent(onBookmark) && isPresent(onImportant) && isPresent(onCopyText);
  const canShowExcludeMenu =
    !readOnly &&
    displayMode === 'duty' &&
    isPresent(onExcludeMessageEntity) &&
    excludeMenuOptions.length > 0;
  const canShowNavigationMenu = !readOnly && navigationMenuItems.length > 0;
  const navigationMenuHasNetwork = navigationMenuItems.some((item) => item.kind === 'network');
  const hasFrequencyCopy =
    isPresent(onCopyFreq) && isPresent(msg.freq) && String(msg.freq).trim() !== '';
  const hasCopyTextWithNetwork = isPresent(onCopyTextWithNetwork);
  const hasCopyTextWithNetworkAndNote = isPresent(onCopyTextWithNetworkAndNote);
  const hasEtalonCopy = isPresent(onCopyEtalon);
  const canShowLocationCopy =
    etalonDisplayModel.copyLocationValue != null && isPresent(onCopyLocation);
  const overflowMenuItemCandidates: Array<OverflowMenuItem | null> = [
    mobileActions && canShowCreateReport
      ? {
          key: 'createReport',
          title: 'Створити розвіддонесення',
          icon: <NoteAddIcon fontSize="small" />,
          selected: false,
          onClick: (event) => onCreateReport(event.currentTarget),
        }
      : null,
    mobileActions && canShowReply
      ? {
          key: 'reply',
          title: 'Відповісти',
          icon: <ReplyIcon fontSize="small" />,
          selected: false,
          onClick: (event) => onReply(event.currentTarget),
        }
      : null,
    mobileActions && canShowPrimaryActions
      ? {
          key: 'important',
          title: msg.important ? 'Позначити як не важливе' : 'Позначити як важливе',
          icon: msg.important ? (
            <FlagIcon fontSize="small" titleAccess={msg.aiImportant ? 'Позначено ШІ' : undefined} />
          ) : (
            <FlagOutlinedIcon fontSize="small" />
          ),
          selected: msg.important,
          onClick: () => onImportant!(),
        }
      : null,
    mobileActions && canShowPrimaryActions
      ? {
          key: 'bookmark',
          title: msg.bookmarked ? 'Прибрати з закладок' : 'Додати в закладки',
          icon: msg.bookmarked ? (
            <BookmarkIcon fontSize="small" />
          ) : (
            <BookmarkBorderOutlinedIcon fontSize="small" />
          ),
          selected: msg.bookmarked,
          onClick: () => onBookmark!(),
        }
      : null,
    mobileActions && canShowPrimaryActions
      ? {
          key: 'copyText',
          title: 'Копіювати повідомлення',
          icon: <MessageIcon fontSize="small" />,
          selected: false,
          onClick: () => onCopyText!(),
        }
      : null,
    mobileActions && canShowPrimaryActions && isPresent(onCopyMessageLink)
      ? {
          key: 'copyLink',
          title: 'Копіювати посилання на повідомлення',
          icon: <LinkIcon fontSize="small" />,
          selected: false,
          onClick: () => onCopyMessageLink(),
        }
      : null,
    !readOnly && isPresent(onEditDetails)
      ? {
          key: 'edit',
          secondary: true,
          title: 'Редагувати',
          icon: <EditIcon fontSize="small" />,
          selected: false,
          onClick: (event) => onEditDetails(event.currentTarget),
        }
      : null,
    isPresent(attachmentArchiveDownload)
      ? {
          key: 'download-attachments-archive',
          secondary: true,
          title: attachmentArchiveDownload.label,
          icon: <DownloadIcon fontSize="small" />,
          selected: false,
          href: attachmentArchiveDownload.href,
          download: attachmentArchiveDownload.download,
          disabled: attachmentArchiveDownload.disabled,
          ariaBusy: attachmentArchiveDownload.ariaBusy,
          ariaLabel: attachmentArchiveDownload.ariaLabel,
          onClick: attachmentArchiveDownload.onClick,
        }
      : null,
    !readOnly && isPresent(onDelete)
      ? {
          key: 'delete',
          secondary: true,
          title: 'Видалити',
          icon: <DeleteIcon fontSize="small" color="error" />,
          selected: false,
          onClick: (_event: MouseEvent<HTMLElement>) => {
            onDelete();
          },
        }
      : null,
  ];
  const availableActions = overflowMenuItemCandidates.filter(
    (item): item is OverflowMenuItem => item != null,
  );
  const quickAction = mobileActions
    ? availableActions.find((item) => item.key === messageCardQuickAction)
    : undefined;
  // Narrow cards keep the important toggle beside the quick action instead of in the menu.
  const overflowMenuItems = availableActions.filter(
    (item) =>
      item.key !== quickAction?.key &&
      item.key !== 'important' &&
      item.key !== 'copyText' &&
      item.key !== 'copyLink',
  );
  const canShowOverflowMenu =
    overflowMenuItems.length > 0 ||
    (mobileActions && (canShowPrimaryActions || canShowNavigationMenu || canShowExcludeMenu));

  function getMenuAnchorPosition(event: MouseEvent<HTMLElement>): MenuAnchorPosition {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      top: rect.bottom,
      left: rect.left,
    };
  }

  function openExcludeMenu(event: MouseEvent<HTMLElement>) {
    event.stopPropagation();
    setExcludeMenuAnchorPosition(getMenuAnchorPosition(event));
  }

  function closeExcludeMenu() {
    blurActiveElement();
    setExcludeMenuAnchorPosition(null);
  }

  function openCopyMenu(event: MouseEvent<HTMLElement>) {
    event.stopPropagation();
    setCopyMenuAnchorPosition(getMenuAnchorPosition(event));
  }

  function closeCopyMenu() {
    blurActiveElement();
    setCopyMenuAnchorPosition(null);
  }

  function openOverflowMenu(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    overflowMenuTriggerRef.current = event.currentTarget;
    setOverflowMenuAnchorPosition(getMenuAnchorPosition(event));
  }

  function closeOverflowMenu() {
    blurActiveElement();
    setOverflowMenuAnchorPosition(null);
  }

  function openNavigationMenu(event: MouseEvent<HTMLElement>) {
    event.stopPropagation();
    setNavigationMenuAnchorPosition(getMenuAnchorPosition(event));
  }

  function closeNavigationMenu() {
    blurActiveElement();
    setNavigationMenuAnchorPosition(null);
  }

  function handleExcludeMenuItemClick(option: MessageEntityExcludeMenuOption) {
    blurActiveElement();
    onExcludeMessageEntity?.(option.entity, option.value);
    closeExcludeMenu();
  }

  function handleCopyMenuItemClick(action: () => void) {
    blurActiveElement();
    action();
    closeCopyMenu();
  }

  function handleOverflowMenuItemClick(
    event: MouseEvent<HTMLElement>,
    action: (event: MouseEvent<HTMLElement>) => void,
  ) {
    blurActiveElement();
    action(event);
    closeOverflowMenu();
  }

  if (
    !quickAction &&
    !canShowCreateReport &&
    !canShowReply &&
    !canShowPrimaryActions &&
    !canShowNavigationMenu &&
    !canShowExcludeMenu &&
    !canShowOverflowMenu
  ) {
    return null;
  }

  const buttons = [
    quickAction ? (
      <ActionIconButton
        key="quick-action"
        title={quickAction.title}
        icon={cloneElement(quickAction.icon, { className: 'message-card-action-btn__icon' })}
        onClick={quickAction.onClick}
        selected={quickAction.selected}
        importantAction={quickAction.key === 'important'}
        buttonProps={
          quickAction.key === 'important' || quickAction.key === 'bookmark'
            ? { 'aria-pressed': quickAction.selected }
            : undefined
        }
      />
    ) : null,
    !mobileActions && canShowCreateReport ? (
      <ActionIconButton
        key="report"
        title="Створити розвіддонесення"
        icon={<NoteAddIcon className="message-card-action-btn__icon" />}
        onClick={(event) => onCreateReport(event.currentTarget)}
      />
    ) : null,
    canShowReply && !mobileActions ? (
      <ActionIconButton
        key="reply"
        title="Відповісти"
        icon={<ReplyIcon className="message-card-action-btn__icon" />}
        onClick={(event) => onReply(event.currentTarget)}
      />
    ) : null,
    canShowPrimaryActions && (!mobileActions || quickAction?.key !== 'important') ? (
      <ActionIconButton
        key="important"
        title={msg.important ? 'Позначити як не важливе' : 'Позначити як важливе'}
        icon={
          msg.important ? (
            <FlagIcon
              className="message-card-action-btn__icon"
              titleAccess={msg.aiImportant ? 'Позначено ШІ' : undefined}
            />
          ) : (
            <FlagOutlinedIcon className="message-card-action-btn__icon" />
          )
        }
        onClick={onImportant!}
        selected={msg.important}
        importantAction
        buttonProps={{ 'aria-pressed': msg.important }}
      />
    ) : null,
    canShowPrimaryActions && !mobileActions ? (
      <ActionIconButton
        key="bookmark"
        title={msg.bookmarked ? 'Прибрати з закладок' : 'Додати в закладки'}
        icon={
          msg.bookmarked ? (
            <BookmarkIcon className="message-card-action-btn__icon" />
          ) : (
            <BookmarkBorderOutlinedIcon className="message-card-action-btn__icon" />
          )
        }
        onClick={onBookmark!}
        selected={msg.bookmarked}
      />
    ) : null,
    canShowPrimaryActions && !mobileActions ? (
      <ActionIconButton
        key="copy"
        title={COPY_TITLE}
        icon={<ContentCopyOutlinedIcon className="message-card-action-btn__icon" />}
        onClick={openCopyMenu}
        buttonProps={{
          'aria-controls': copyMenuAnchorPosition ? copyMenuId : undefined,
          'aria-haspopup': 'menu',
          'aria-expanded': copyMenuAnchorPosition ? 'true' : undefined,
        }}
      />
    ) : null,
    canShowNavigationMenu && !mobileActions ? (
      <ActionIconButton
        key="navigate"
        title={NAVIGATE_TITLE}
        icon={<LaunchIcon className="message-card-action-btn__icon" />}
        onClick={openNavigationMenu}
        buttonProps={{
          'aria-controls': navigationMenuAnchorPosition ? navigationMenuId : undefined,
          'aria-haspopup': 'menu',
          'aria-expanded': navigationMenuAnchorPosition ? 'true' : undefined,
        }}
      />
    ) : null,
    canShowExcludeMenu && !mobileActions ? (
      <ActionIconButton
        key="minus"
        title={EXCLUDE_TITLE}
        icon={<RemoveIcon className="message-card-action-btn__icon" />}
        onClick={openExcludeMenu}
        buttonProps={{
          'aria-controls': excludeMenuAnchorPosition ? excludeMenuId : undefined,
          'aria-haspopup': 'menu',
          'aria-expanded': excludeMenuAnchorPosition ? 'true' : undefined,
        }}
      />
    ) : null,
    canShowOverflowMenu ? (
      <ActionIconButton
        key="overflow"
        title="Більше дій"
        icon={<MoreVertIcon className="message-card-action-btn__icon" />}
        onClick={openOverflowMenu}
        buttonProps={{
          'aria-controls': overflowMenuAnchorPosition ? overflowMenuId : undefined,
          'aria-haspopup': 'menu',
          'aria-expanded': overflowMenuAnchorPosition ? 'true' : undefined,
        }}
      />
    ) : null,
  ].filter((button): button is JSX.Element => button != null);

  useLayoutEffect(() => {
    const headerRow =
      headerRowRef.current ??
      rootRef.current?.closest<HTMLDivElement>('[data-message-card-header-row]');
    if (!headerRow) {
      return;
    }

    let rafId: number | null = null;
    const updateLayout = () => {
      if (headerRow.clientWidth <= 0) {
        return;
      }
      const compact = headerRow.clientWidth <= MESSAGE_CARD_COMPACT_ACTIONS_MAX_WIDTH_PX;
      setMobileActions(compact);
      onCompactChange(compact);
    };

    const scheduleUpdateLayout = () => {
      if (typeof requestAnimationFrame === 'undefined') {
        updateLayout();
        return;
      }
      if (rafId != null) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateLayout();
      });
    };

    updateLayout();
    const ResizeObserverConstructor =
      typeof window === 'undefined' ? undefined : window.ResizeObserver;
    if (!ResizeObserverConstructor) {
      return;
    }

    const observer = new ResizeObserverConstructor(() => {
      scheduleUpdateLayout();
    });
    observer.observe(headerRow);
    return () => {
      observer.disconnect();
      if (rafId != null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafId);
      }
    };
  }, [headerRowRef, onCompactChange]);

  function renderOverflowMenuItem(item: OverflowMenuItem) {
    const props = {
      disabled: item.disabled,
      'aria-busy': item.ariaBusy,
      'aria-label': item.ariaLabel,
      selected: item.selected,
      onClick: (event: MouseEvent<HTMLElement>) => {
        const focusTarget = overflowMenuTriggerRef.current ?? event.currentTarget;
        handleOverflowMenuItemClick(event, () => {
          if (item.key === 'reply') window.setTimeout(() => onReply?.(focusTarget), 0);
          else if (item.key === 'createReport') onCreateReport?.(focusTarget);
          else if (item.key === 'edit') onEditDetails?.(focusTarget);
          else item.onClick(event);
        });
      },
    };
    return item.href != null ? (
      <MenuItem
        key={item.key}
        component="a"
        href={item.href}
        download={item.download}
        target="_blank"
        rel="noopener noreferrer"
        {...props}
      >
        <MenuRow icon={item.icon}>{item.title}</MenuRow>
      </MenuItem>
    ) : (
      <MenuItem key={item.key} {...props}>
        <MenuRow icon={item.icon}>{item.title}</MenuRow>
      </MenuItem>
    );
  }

  const overflowMenu =
    isPresent(overflowMenuAnchorPosition) && canShowOverflowMenu ? (
      <Menu
        id={overflowMenuId}
        anchorReference="anchorPosition"
        anchorPosition={overflowMenuAnchorPosition ?? undefined}
        open
        onClose={closeOverflowMenu}
        MenuListProps={{ 'aria-label': 'Додаткові дії повідомлення' }}
      >
        {[
          overflowMenuItems.filter((item) => !item.secondary).map(renderOverflowMenuItem),
          mobileActions && canShowPrimaryActions
            ? renderCopyMenuItems({
                hasCopyTextWithNetwork,
                hasCopyTextWithNetworkAndNote,
                hasFrequencyCopy,
                canShowLocationCopy,
                hasEtalonCopy,
                onCopyText: onCopyText!,
                onCopyTextWithNetwork,
                onCopyTextWithNetworkAndNote,
                onCopyFreq,
                onCopyMessageLink,
                onCopyLocation,
                onCopyEtalon,
                onClose: closeOverflowMenu,
              }).filter((item) => item.key !== quickAction?.key)
            : [],
          mobileActions && canShowNavigationMenu
            ? renderNavigationMenuItems({ items: navigationMenuItems, onClose: closeOverflowMenu })
            : [],
          mobileActions && canShowExcludeMenu
            ? renderExcludeMenuItems({
                options: excludeMenuOptions,
                onExclude: onExcludeMessageEntity,
                onClose: closeOverflowMenu,
              })
            : [],
          overflowMenuItems.filter((item) => item.secondary).map(renderOverflowMenuItem),
        ]
          .filter((items) => items.length > 0)
          .flatMap((items, index) => [
            ...(index > 0 ? [<Divider key={`divider-${index}`} role="separator" />] : []),
            ...items,
          ])}
      </Menu>
    ) : null;

  const copyMenu =
    isPresent(copyMenuAnchorPosition) && canShowPrimaryActions ? (
      <Menu
        id={copyMenuId}
        anchorReference="anchorPosition"
        anchorPosition={copyMenuAnchorPosition ?? undefined}
        open
        onClose={closeCopyMenu}
        MenuListProps={{ 'aria-label': 'Копіювання повідомлення' }}
      >
        <MenuItem onClick={() => handleCopyMenuItemClick(onCopyText!)}>
          <MenuRow icon={<MessageIcon fontSize="small" />}>Копіювати повідомлення</MenuRow>
        </MenuItem>
        {hasCopyTextWithNetwork ? (
          <MenuItem onClick={() => handleCopyMenuItemClick(onCopyTextWithNetwork!)}>
            <MenuRow icon={<PeopleIcon fontSize="small" />}>
              Копіювати повідомлення з назвою мережі
            </MenuRow>
          </MenuItem>
        ) : null}
        {hasCopyTextWithNetworkAndNote ? (
          <MenuItem onClick={() => handleCopyMenuItemClick(onCopyTextWithNetworkAndNote!)}>
            <MenuRow icon={<ChatBubbleOutlineOutlinedIcon fontSize="small" />}>
              Копіювати повідомлення з мережею та коментарем
            </MenuRow>
          </MenuItem>
        ) : null}
        {hasFrequencyCopy ? (
          <MenuItem onClick={() => handleCopyMenuItemClick(onCopyFreq!)}>
            <MenuRow icon={<SettingsInputAntennaIcon fontSize="small" />}>
              Копіювати частоту
            </MenuRow>
          </MenuItem>
        ) : null}
        {isPresent(onCopyMessageLink) ? (
          <MenuItem onClick={() => handleCopyMenuItemClick(onCopyMessageLink!)}>
            <MenuRow icon={<LinkIcon fontSize="small" />}>
              Копіювати посилання на повідомлення
            </MenuRow>
          </MenuItem>
        ) : null}
        {canShowLocationCopy ? (
          <MenuItem onClick={() => handleCopyMenuItemClick(onCopyLocation!)}>
            <MenuRow icon={<PlaceIcon fontSize="small" />}>Копіювати локацію</MenuRow>
          </MenuItem>
        ) : null}
        {hasEtalonCopy ? (
          <MenuItem onClick={() => handleCopyMenuItemClick(onCopyEtalon!)}>
            <MenuRow icon={<PeopleIcon fontSize="small" />}>Копіювати прив&apos;язку</MenuRow>
          </MenuItem>
        ) : null}
      </Menu>
    ) : null;

  const navigationMenu =
    isPresent(navigationMenuAnchorPosition) && canShowNavigationMenu ? (
      <Menu
        id={navigationMenuId}
        anchorReference="anchorPosition"
        anchorPosition={navigationMenuAnchorPosition ?? undefined}
        open
        onClose={closeNavigationMenu}
        MenuListProps={{ 'aria-label': 'Перехід по повідомленню' }}
        slotProps={{
          paper: {
            sx: {
              maxWidth: 320,
              minWidth: navigationMenuHasNetwork ? undefined : 140,
              width: navigationMenuHasNetwork ? '100%' : 'fit-content',
            },
          },
        }}
      >
        {navigationMenuItems.map((item) =>
          item.kind === 'network' ? (
            <MenuItem
              key={`${item.kind}:${item.href}`}
              component="a"
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              title={item.networkLabel}
              onClick={closeNavigationMenu}
              sx={{ maxWidth: 320, overflow: 'hidden' }}
            >
              <MenuRow icon={<PeopleIcon fontSize="small" />}>
                В мережу <strong>{item.networkLabel}</strong>
                {item.badge ? (
                  <span className="badge badge-no-unit-sm ml-[0.35em] align-middle relative -top-[0.06em]">
                    в дорозвідці
                  </span>
                ) : null}
              </MenuRow>
            </MenuItem>
          ) : item.kind === 'map' ? (
            <MenuItem
              key={`${item.kind}:${item.href}`}
              component="a"
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={closeNavigationMenu}
              sx={{ maxWidth: 320, overflow: 'hidden' }}
            >
              <MenuRow icon={<MapIcon fontSize="small" />}>{item.label ?? 'На мапу'}</MenuRow>
            </MenuItem>
          ) : (
            <MenuItem
              key={`${item.kind}:${item.href}`}
              component="a"
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={closeNavigationMenu}
              sx={{ maxWidth: 320, overflow: 'hidden' }}
            >
              <MenuRow icon={<BarChartIcon fontSize="small" />}>{item.label ?? 'В аналіз'}</MenuRow>
            </MenuItem>
          ),
        )}
      </Menu>
    ) : null;

  const excludeMenu =
    isPresent(excludeMenuAnchorPosition) && canShowExcludeMenu ? (
      <Menu
        id={excludeMenuId}
        anchorReference="anchorPosition"
        anchorPosition={excludeMenuAnchorPosition ?? undefined}
        open
        onClose={closeExcludeMenu}
        MenuListProps={{ 'aria-label': 'Виключення з фільтрів' }}
      >
        {excludeMenuOptions.map((option) => (
          <MenuItem
            key={`${option.entity}:${option.value}`}
            onClick={() => handleExcludeMenuItemClick(option)}
          >
            <MenuRow
              icon={
                option.entity === 'group' ? (
                  <GraphicEqIcon fontSize="small" />
                ) : option.entity === 'sender' ? (
                  <AccountCircleIcon fontSize="small" />
                ) : option.entity === 'freq' ? (
                  <SettingsInputAntennaIcon fontSize="small" />
                ) : (
                  <DeskIcon fontSize="small" />
                )
              }
            >
              {option.entity === 'group'
                ? 'Виключити групу'
                : option.entity === 'sender'
                  ? 'Виключити відправника'
                  : option.entity === 'freq'
                    ? 'Виключити частоту'
                    : 'Виключити пост'}{' '}
              <strong>{option.label}</strong>
            </MenuRow>
          </MenuItem>
        ))}
      </Menu>
    ) : null;

  return (
    <>
      <div ref={rootRef} className="flex w-full justify-center">
        <div aria-label="Дії повідомлення" className="message-card-action-group">
          {buttons}
        </div>
      </div>
      {overflowMenu}
      {copyMenu}
      {navigationMenu}
      {excludeMenu}
    </>
  );
}

function MetaLine({
  icon,
  title,
  text,
  iconKind,
  wrapText = false,
  children,
}: {
  icon: JSX.Element;
  title: string;
  text: string;
  iconKind?: 'group';
  wrapText?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="message-card-header-meta" data-message-card-metadata-item="true" title={text}>
      <span
        className={`message-card-header-meta__icon${
          iconKind ? ` message-card-header-meta__icon--${iconKind}` : ''
        }`}
        data-message-card-metadata-icon-kind={iconKind ?? 'standard'}
        title={title}
      >
        {icon}
      </span>
      <HeaderText nowrap={!wrapText} wrap={wrapText}>
        {children ?? text}
      </HeaderText>
    </div>
  );
}

/**
 * The network icon's tooltip; it carries the message's callsigns this network
 * lists and the AI certainty when there are any.
 */
function networkIconTitle(
  certainty?: number | null,
  reason?: string | null,
  matchedCallsigns?: string[],
): string {
  const lines = ["Еталонна прив'язка"];
  if (matchedCallsigns?.length) {
    lines.push(
      `Позивні з повідомлення в цій мережі: ${matchedCallsigns
        .map((callsign) => callsign.toLocaleUpperCase('uk'))
        .join(', ')}`,
    );
  }
  if (certainty != null) {
    lines.push(`Впевненість ШІ, що повідомлення належить саме цій мережі: ${certainty}%`);
    if (reason) lines.push(`Пояснення ШІ: ${reason}`);
  }
  return lines.join('\n');
}

function NetworkMetadataItem({
  networkId,
  label,
  badge,
  certainty,
  certaintyReason,
  matchedCallsigns,
}: MessageCardRenderedNetwork) {
  return (
    <div
      className="message-card-header-meta w-fit max-w-full"
      data-message-card-metadata-item="true"
      data-message-card-network-item="true"
      data-network-id={networkId}
    >
      <span
        className="message-card-header-meta__icon message-card-header-meta__icon--network"
        data-message-card-metadata-icon-kind="network"
        title={networkIconTitle(certainty, certaintyReason, matchedCallsigns)}
      >
        <PeopleOutlineOutlinedIcon />
      </span>
      <span className="inline-flex max-w-full items-center align-top [overflow-wrap:anywhere] break-words">
        <HeaderText wrap>{label}</HeaderText>
        {badge ? (
          <span className="badge badge-no-unit-sm relative -top-[0.06em] ml-[0.35em] align-middle">
            в дорозвідці
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** With a confident AI match, shows that network and folds the rest. */
function NetworkMetadataList({
  networks,
  confidentNetworkId,
}: {
  networks: MessageCardRenderedNetwork[];
  confidentNetworkId?: number | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const folds = confidentNetworkId != null && networks.length > 1;
  const visible =
    folds && !expanded
      ? networks.filter((network) => network.networkId === confidentNetworkId)
      : networks;
  return (
    <>
      {visible.map((network) => (
        <NetworkMetadataItem key={network.networkId} {...network} />
      ))}
      {folds ? (
        <button
          type="button"
          className="message-card-network-expand"
          data-message-card-network-expand="true"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Згорнути інші мережі' : 'Показати інші мережі'}
        >
          {expanded ? 'згорнути' : `і ще ${networks.length - 1}`}
        </button>
      ) : null}
    </>
  );
}

function NetworkEtalonSection({
  etalonDisplayModel,
  hideExplicitUnit = false,
}: {
  etalonDisplayModel: MessageCardEtalonDisplayModel;
  hideExplicitUnit?: boolean;
}) {
  const {
    displayValue,
    locationDisplayValue,
    primaryKind,
    renderedNetworks,
    showInlineLocationTooltip,
  } = etalonDisplayModel;
  if (hideExplicitUnit && primaryKind === 'unit') return null;
  const showTopGridLocation = primaryKind === 'network' && locationDisplayValue != null;

  const geoButton =
    !showTopGridLocation && showInlineLocationTooltip && locationDisplayValue != null ? (
      <span
        title={locationDisplayValue}
        aria-label={`Локація: ${locationDisplayValue}`}
        className="inline-flex size-6 shrink-0 items-center justify-center self-center rounded-full border border-transparent text-[var(--color-action)]"
      >
        <PlaceOutlinedIcon aria-hidden className="text-base leading-none" />
      </span>
    ) : null;

  if (primaryKind === 'network') {
    return (
      <NetworkMetadataList
        networks={renderedNetworks}
        confidentNetworkId={etalonDisplayModel.confidentNetworkId}
      />
    );
  }

  const primaryIcon =
    primaryKind === 'location' ? (
      <PlaceOutlinedIcon
        className="message-card-header-icon mt-px self-center"
        titleAccess="Локація"
      />
    ) : (
      <PeopleOutlineOutlinedIcon
        className="message-card-header-icon mt-px self-center"
        titleAccess="Еталонна прив'язка"
      />
    );

  return (
    <div
      className="message-card-header-meta w-fit max-w-full"
      data-message-card-metadata-item="true"
    >
      <span
        className="message-card-header-meta__icon"
        data-message-card-metadata-icon-kind="standard"
      >
        {primaryIcon}
      </span>
      <HeaderText wrap className="inline-flex items-center">
        {displayValue}
      </HeaderText>
      {geoButton}
    </div>
  );
}

export type MessageCardHeaderProps = {
  readOnly?: boolean;
  displayMode: MessageCardDisplayMode;
  excludeMenuOptions?: MessageEntityExcludeMenuOption[];
  id: number;
  msg: InboxMessage;
  copiedFeedbackId: string | null;
  etalonDisplayModel: MessageCardEtalonDisplayModel;
  metadata?: ReactNode;
  /** Hides metadata and event time; actions and the important badge stay. */
  hideIdentity?: boolean;
  /** Hides the unit row shown when there is no header metadata. */
  hideUnit?: boolean;
  mapHref?: string;
  analysisHref?: string;
  onBookmark?: () => void;
  onImportant?: () => void;
  onReply?: (focusTarget: HTMLElement) => void;
  onCreateReport?: (focusTarget: HTMLElement) => void;
  onCopyText?: () => void;
  onCopyFreq?: () => void;
  onCopyTextWithNetwork?: () => void;
  onCopyTextWithNetworkAndNote?: () => void;
  onCopyMessageLink?: () => void;
  onCopyEtalon?: () => void;
  onCopyLocation?: () => void;
  onDelete?: () => void;
  onEditDetails?: (focusTarget: HTMLElement) => void;
  onExcludeMessageEntity?: (entity: MessageEntityFilterKind, value: string) => void;
  attachmentArchiveDownload?: MessageCardAttachmentArchiveDownloadAction;
};

export function MessageCardMetadata({
  msg,
  groupName,
  senderName,
  etalonDisplayModel,
  metadataTrigger,
  wrapText = false,
  hideExplicitUnit = false,
  hideFrequency = false,
  hideUnit = false,
  placement = MessageCardMetadataPlacement.All,
}: {
  msg: InboxMessage;
  groupName: string | null;
  senderName: string | null;
  etalonDisplayModel: MessageCardEtalonDisplayModel;
  metadataTrigger?: ReactNode;
  wrapText?: boolean;
  hideExplicitUnit?: boolean;
  hideFrequency?: boolean;
  hideUnit?: boolean;
  placement?: MessageCardMetadataPlacement;
}) {
  const radioFeaturesAllowed = useRadioFeatures();
  const canUseMessageDevices = useMessageDeviceAccess();
  const locationDisplayValue = etalonDisplayModel.locationDisplayValue;
  const showTopGridLocation =
    (placement === MessageCardMetadataPlacement.Header ||
      etalonDisplayModel.primaryKind !== 'location') &&
    locationDisplayValue != null;
  const deviceName = canUseMessageDevices ? msg.deviceName?.trim() : undefined;
  const showPrimaryMetadata = placement !== MessageCardMetadataPlacement.Content;
  const showSecondaryMetadata = placement !== MessageCardMetadataPlacement.Header;

  return (
    <div className="message-card-metadata flex w-full items-start gap-2">
      <div
        className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0"
        style={{ flexWrap: 'wrap' }}
      >
        {placement === MessageCardMetadataPlacement.Header ? (
          <NetworkMetadataList
            networks={etalonDisplayModel.renderedNetworks}
            confidentNetworkId={etalonDisplayModel.confidentNetworkId}
          />
        ) : null}
        {showPrimaryMetadata && isPresent(groupName) ? (
          <MetaLine
            icon={<GraphicEqOutlinedIcon />}
            iconKind="group"
            title="Група"
            text={groupName}
            wrapText={wrapText}
          />
        ) : null}
        {showPrimaryMetadata && isPresent(senderName) ? (
          <MetaLine
            icon={<AccountCircleOutlinedIcon />}
            title="Відправник"
            text={senderName}
            wrapText={wrapText}
          >
            <AuthorLabel accountId={msg.sender} fallback={senderName} />
          </MetaLine>
        ) : null}
        {showSecondaryMetadata && !hideFrequency && radioFeaturesAllowed && isPresent(msg.freq) ? (
          <div className="message-card-header-meta" data-message-card-metadata-item="true">
            <span
              className="message-card-header-meta__icon"
              data-message-card-metadata-icon-kind="standard"
            >
              <SettingsInputAntennaOutlinedIcon titleAccess="Частота" />
            </span>
            <HeaderText className={wrapText ? undefined : 'whitespace-nowrap'} wrap={wrapText}>
              {msg.freq}
            </HeaderText>
          </div>
        ) : null}
        {showSecondaryMetadata && isPresent(deviceName) && deviceName !== '' ? (
          <MetaLine icon={<DevicesIcon />} title="Пристрій" text={deviceName} wrapText={wrapText} />
        ) : null}
        {placement === MessageCardMetadataPlacement.Content &&
        !hideUnit &&
        isPresent(etalonDisplayModel.headerUnit) ? (
          <MetaLine
            icon={<SquareTwoToneIcon className="message-card-unit-icon" />}
            title="Підрозділ"
            text={etalonDisplayModel.headerUnit}
            wrapText
          />
        ) : null}
        {placement === MessageCardMetadataPlacement.All ? (
          <NetworkEtalonSection
            etalonDisplayModel={etalonDisplayModel}
            hideExplicitUnit={hideExplicitUnit}
          />
        ) : null}
        {showPrimaryMetadata && showTopGridLocation ? (
          <MetaLine
            icon={<PlaceOutlinedIcon />}
            title="Локація"
            text={locationDisplayValue}
            wrapText={wrapText}
          />
        ) : null}
      </div>
      {metadataTrigger ? <div className="flex shrink-0 items-center">{metadataTrigger}</div> : null}
    </div>
  );
}

export function MessageCardTimestampFooter({
  msg,
  referenceTimeMs,
}: Pick<MessageCardHeaderProps, 'msg'> & { referenceTimeMs: number | null }) {
  const receiptTimestamp = Number.isFinite(msg.createdAt) ? msg.createdAt : null;
  const [footerRef, displayMs] = useMessageCardDateDisplayMs(referenceTimeMs, receiptTimestamp);

  if (receiptTimestamp == null) return null;

  const receiptTime = dayjs(receiptTimestamp).tz(APP_TIME_ZONE);
  const now = dayjs(displayMs ?? Date.now()).tz(APP_TIME_ZONE);
  const receiptFormat = receiptTime.isSame(now, 'day')
    ? 'HH:mm'
    : receiptTime.year() === now.year()
      ? 'DD.MM, HH:mm'
      : 'DD.MM.YYYY, HH:mm';

  return (
    <div
      ref={footerRef as RefObject<HTMLDivElement>}
      className="message-card-timestamp-footer"
      data-message-card-timestamp-footer="true"
    >
      <time dateTime={receiptTime.toISOString()} title="Час отримання повідомлення">
        <HeaderText className="opacity-50">{receiptTime.format(receiptFormat)}</HeaderText>
      </time>
    </div>
  );
}

function formatAnalysisEventDateTime(msg: InboxMessage): string {
  const timestamp = msg.timestamp == null ? null : dayjs(msg.timestamp).tz(APP_TIME_ZONE);
  const parsedDate = dayjs(msg.date?.trim() ?? '', ['YYYY-MM-DD', 'DD.MM.YYYY'], true);
  const date = parsedDate.isValid()
    ? parsedDate.format('DD.MM.YYYY')
    : msg.date?.trim() || timestamp?.format('DD.MM.YYYY');
  const time =
    msg.isTimeNull === true
      ? null
      : msg.time?.trim()
        ? formatTime(msg.time)
        : timestamp?.format('HH:mm');
  return [date, time].filter(Boolean).join(', ') || '—';
}

// Hot path: preserve native structural layout and conditional menu mounting.
// Leaf MUI components remain intentional; see ./AGENTS.md.
function MessageCardHeaderComponent({
  readOnly = false,
  displayMode,
  excludeMenuOptions = [],
  id,
  msg,
  copiedFeedbackId,
  etalonDisplayModel,
  metadata,
  hideIdentity = false,
  hideUnit = false,
  mapHref,
  analysisHref,
  onBookmark,
  onImportant,
  onReply,
  onCreateReport,
  onCopyText,
  onCopyFreq,
  onCopyTextWithNetwork,
  onCopyTextWithNetworkAndNote,
  onCopyMessageLink,
  onCopyEtalon,
  onCopyLocation,
  onDelete,
  onEditDetails,
  onExcludeMessageEntity,
  attachmentArchiveDownload,
}: MessageCardHeaderProps) {
  const headerRowRef = useRef<HTMLDivElement | null>(null);
  const [compactActions, setCompactActions] = useState(false);
  const explicitUnit = etalonDisplayModel.headerUnit ?? '—';
  const navigationMenuItems = buildMessageCardNavigationMenuItems(
    etalonDisplayModel.renderedNetworks,
    mapHref,
    analysisHref,
  );
  const dateTimeBlock = (
    <div
      className={`message-card-header-timestamps inline-flex ${
        displayMode === 'duty' ? 'flex-nowrap' : 'flex-wrap'
      } message-card-header-timestamps--mobile-nowrap items-center`}
    >
      <div
        className="message-card-timestamp-item"
        data-message-card-timestamp-item="true"
        title="Дата і час перехоплення"
      >
        <TodayOutlinedIcon
          className="message-card-header-icon"
          titleAccess="Дата і час перехоплення"
        />
        <HeaderText>{formatAnalysisEventDateTime(msg)}</HeaderText>
      </div>
    </div>
  );

  const row1 = (
    <div
      ref={headerRowRef}
      data-message-card-header-row="true"
      data-message-card-display-mode={displayMode}
      data-message-card-actions-compact={compactActions ? 'true' : undefined}
      data-message-card-header-identity-hidden={hideIdentity ? 'true' : undefined}
      className="message-card-header-row w-full"
    >
      {hideIdentity ? null : (
        <div className="message-card-header-identity">
          <div data-message-card-header-left="true" className="min-w-0">
            {metadata ??
              (hideUnit ? null : (
                <div className="message-card-header-unit" data-message-card-header-unit-row="true">
                  <span className="message-card-header-meta__icon">
                    <SquareTwoToneIcon className="message-card-unit-icon" titleAccess="Підрозділ" />
                  </span>
                  <HeaderText wrap>{explicitUnit}</HeaderText>
                </div>
              ))}
            {dateTimeBlock}
          </div>
        </div>
      )}
      {msg.important || !readOnly || isPresent(attachmentArchiveDownload) ? (
        <div className="message-card-header-actions flex items-center justify-end gap-2 self-start">
          {msg.important ? (
            <span
              className="message-card-important-status"
              title={msg.aiImportant ? 'Позначено ШІ' : undefined}
              data-message-card-important-status="true"
            >
              <FlagIcon aria-hidden className="message-card-important-status__icon" />
              Важливе
            </span>
          ) : null}
          {!readOnly || isPresent(attachmentArchiveDownload) ? (
            <ActionIconsRow
              id={id}
              msg={msg}
              readOnly={readOnly}
              displayMode={displayMode}
              excludeMenuOptions={excludeMenuOptions}
              etalonDisplayModel={etalonDisplayModel}
              copiedFeedbackId={copiedFeedbackId}
              navigationMenuItems={navigationMenuItems}
              onBookmark={onBookmark}
              onImportant={onImportant}
              onReply={onReply}
              onCreateReport={onCreateReport}
              onCopyText={onCopyText}
              onCopyFreq={onCopyFreq}
              onCopyTextWithNetwork={onCopyTextWithNetwork}
              onCopyTextWithNetworkAndNote={onCopyTextWithNetworkAndNote}
              onCopyMessageLink={onCopyMessageLink}
              onCopyEtalon={onCopyEtalon}
              onCopyLocation={onCopyLocation}
              onDelete={onDelete}
              onEditDetails={onEditDetails}
              onExcludeMessageEntity={onExcludeMessageEntity}
              attachmentArchiveDownload={attachmentArchiveDownload}
              headerRowRef={headerRowRef}
              onCompactChange={setCompactActions}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <div data-message-header-grid="true" className="flex w-full">
      {row1}
    </div>
  );
}

export const MessageCardHeader = memo(MessageCardHeaderComponent);
