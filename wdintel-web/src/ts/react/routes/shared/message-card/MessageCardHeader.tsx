import MessageIcon from '@mui/icons-material/Message';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import AccountCircleOutlinedIcon from '@mui/icons-material/AccountCircleOutlined';
import BarChartIcon from '@mui/icons-material/BarChart';
import BookmarkIcon from '@mui/icons-material/Bookmark';
import BookmarkBorderOutlinedIcon from '@mui/icons-material/BookmarkBorderOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import DevicesIcon from '@mui/icons-material/Devices';
import CalendarTodayOutlinedIcon from '@mui/icons-material/CalendarTodayOutlined';
import ChatBubbleOutlineOutlinedIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import EditIcon from '@mui/icons-material/Edit';
import DeskIcon from '@mui/icons-material/Desk';
import DeskOutlinedIcon from '@mui/icons-material/DeskOutlined';
import GpsFixedOutlinedIcon from '@mui/icons-material/GpsFixedOutlined';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import GraphicEqOutlinedIcon from '@mui/icons-material/GraphicEqOutlined';
import FlagIcon from '@mui/icons-material/Flag';
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import LaunchIcon from '@mui/icons-material/Launch';
import LinkIcon from '@mui/icons-material/Link';
import MapIcon from '@mui/icons-material/Map';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PeopleIcon from '@mui/icons-material/People';
import PeopleOutlineOutlinedIcon from '@mui/icons-material/PeopleOutlineOutlined';
import PlaceIcon from '@mui/icons-material/Place';
import PlaceOutlinedIcon from '@mui/icons-material/PlaceOutlined';
import RemoveIcon from '@mui/icons-material/Remove';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import SettingsInputAntennaIcon from '@mui/icons-material/SettingsInputAntenna';
import SettingsInputAntennaOutlinedIcon from '@mui/icons-material/SettingsInputAntennaOutlined';
import { Menu, MenuItem } from '@mui/material';
import { memo, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, MouseEvent, ReactNode, RefObject } from 'react';
import { ELLIPSIS, isPresent } from '../../../utils/misc';
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
} from './message-card.utils';
import { formatCoordinatePreviewPointCount } from './message-coordinate-preview';

const COPY_TITLE = `Копіювати${ELLIPSIS}`;
const NAVIGATE_TITLE = `Перейти${ELLIPSIS}`;
const EXCLUDE_TITLE = `Виключити${ELLIPSIS}`;
const MESSAGE_CARD_HEADER_ROW_MIN_HEIGHT_PX = 30;
const MESSAGE_CARD_ACTION_BUTTON_SIZE_PX = 30;
const MESSAGE_CARD_ACTION_GROUP_BORDER_PX = 2;

export type MessageCardDisplayMode = 'duty' | 'analysis';

type ActionIconsRowProps = {
  id: number;
  msg: InboxMessage;
  compact?: boolean;
  readOnly?: boolean;
  displayMode: MessageCardDisplayMode;
  excludeMenuOptions?: MessageEntityExcludeMenuOption[];
  etalonDisplayModel: MessageCardEtalonDisplayModel;
  navigationMenuItems?: MessageCardNavigationMenuItem[];
  copiedFeedbackId: string | null;
  onBookmark?: () => void;
  onImportant?: () => void;
  onCreateReport?: () => void;
  onCopyText?: () => void;
  onCopyFreq?: () => void;
  onCopyTextWithNetwork?: () => void;
  onCopyTextWithNetworkAndNote?: () => void;
  onCopyMessageLink?: () => void;
  onCopyEtalon?: () => void;
  onCopyLocation?: () => void;
  onDelete?: () => void;
  onEditDetails?: () => void;
  onExcludeMessageEntity?: (entity: MessageEntityFilterKind, value: string) => void;
  headerRowRef: RefObject<HTMLDivElement | null>;
  leftHeaderContentRef: RefObject<HTMLDivElement | null>;
  rightHeaderContentRef: RefObject<HTMLDivElement | null>;
  headerColumnGap: number;
};

type MenuAnchorPosition = {
  top: number;
  left: number;
};

function ActionIconButton({
  title,
  icon,
  onClick,
  selected = false,
  buttonProps,
}: {
  title: string;
  icon: JSX.Element;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  selected?: boolean;
  buttonProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick' | 'type'>;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-selected={selected ? 'true' : undefined}
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

function ActionIconsRow({
  id,
  msg,
  compact = false,
  readOnly = false,
  displayMode,
  excludeMenuOptions = [],
  etalonDisplayModel,
  copiedFeedbackId,
  navigationMenuItems = [],
  onBookmark,
  onImportant,
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
  headerRowRef,
  leftHeaderContentRef,
  rightHeaderContentRef,
  headerColumnGap,
}: ActionIconsRowProps) {
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
  const [stackedLayout, setStackedLayout] = useState(false);
  const canShowExcludeMenu =
    displayMode === 'duty' && isPresent(onExcludeMessageEntity) && excludeMenuOptions.length > 0;
  const canShowNavigationMenu = navigationMenuItems.length > 0;
  const navigationMenuHasNetwork = navigationMenuItems.some((item) => item.kind === 'network');
  const hasFrequencyCopy = isPresent(msg.freq) && String(msg.freq).trim() !== '';
  const hasCopyTextWithNetwork = isPresent(onCopyTextWithNetwork);
  const hasCopyTextWithNetworkAndNote = isPresent(onCopyTextWithNetworkAndNote);
  const hasEtalonCopy = isPresent(onCopyEtalon);
  const canShowLocationCopy =
    etalonDisplayModel.copyLocationValue != null && isPresent(onCopyLocation);
  const overflowMenuItems = [
    isPresent(onDelete)
      ? {
          key: 'delete',
          title: 'Видалити',
          icon: <DeleteIcon fontSize="small" color="error" />,
          selected: false,
          onClick: onDelete,
        }
      : null,
  ].filter(
    (
      item,
    ): item is {
      key: string;
      title: string;
      icon: JSX.Element;
      selected: boolean;
      onClick: () => void;
    } => item != null,
  );
  const canShowOverflowMenu = overflowMenuItems.length > 0;

  function getMenuAnchorPosition(event: MouseEvent<HTMLButtonElement>): MenuAnchorPosition {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      top: rect.bottom,
      left: rect.left,
    };
  }

  function openExcludeMenu(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setExcludeMenuAnchorPosition(getMenuAnchorPosition(event));
  }

  function closeExcludeMenu() {
    blurActiveElement();
    setExcludeMenuAnchorPosition(null);
  }

  function openCopyMenu(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setCopyMenuAnchorPosition(getMenuAnchorPosition(event));
  }

  function closeCopyMenu() {
    blurActiveElement();
    setCopyMenuAnchorPosition(null);
  }

  function openOverflowMenu(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setOverflowMenuAnchorPosition(getMenuAnchorPosition(event));
  }

  function closeOverflowMenu() {
    blurActiveElement();
    setOverflowMenuAnchorPosition(null);
  }

  function openNavigationMenu(event: MouseEvent<HTMLButtonElement>) {
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

  function handleOverflowMenuItemClick(action: () => void) {
    blurActiveElement();
    action();
    closeOverflowMenu();
  }

  if (!onBookmark || !onImportant || !onCopyText || !onCopyFreq) {
    return null;
  }

  const buttons = [
    isPresent(onCreateReport) ? (
      <ActionIconButton
        key="report"
        title="Створити розвіддонесення"
        icon={<NoteAddIcon className="message-card-action-btn__icon" />}
        onClick={onCreateReport}
      />
    ) : null,
    <ActionIconButton
      key="important"
      title={msg.important ? 'Позначити як не важливе' : 'Позначити як важливе'}
      icon={
        msg.important ? (
          <FlagIcon className="message-card-action-btn__icon" />
        ) : (
          <FlagOutlinedIcon className="message-card-action-btn__icon" />
        )
      }
      onClick={onImportant}
      selected={msg.important}
    />,
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
      onClick={onBookmark}
      selected={msg.bookmarked}
    />,
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
    />,
    isPresent(onEditDetails) ? (
      <ActionIconButton
        key="edit"
        title="Редагувати"
        icon={<EditIcon className="message-card-action-btn__icon" />}
        onClick={onEditDetails}
      />
    ) : null,
    canShowNavigationMenu ? (
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
    canShowExcludeMenu ? (
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

  const actionGridColumns = displayMode === 'duty' ? 4 : 3;

  useLayoutEffect(() => {
    const headerRow =
      headerRowRef.current ??
      rootRef.current?.closest<HTMLDivElement>('[data-message-card-header-row]');
    const leftHeaderContent =
      leftHeaderContentRef.current ??
      headerRow?.querySelector<HTMLDivElement>('[data-message-card-header-left]');
    const rightHeaderContent =
      rightHeaderContentRef.current ??
      headerRow?.querySelector<HTMLDivElement>('[data-message-card-header-right]');
    if (!headerRow || !leftHeaderContent || !rightHeaderContent) {
      return;
    }

    const minInlineWidth =
      buttons.length * MESSAGE_CARD_ACTION_BUTTON_SIZE_PX + MESSAGE_CARD_ACTION_GROUP_BORDER_PX;
    let rafId: number | null = null;
    const updateLayout = () => {
      if (headerRow.clientWidth <= 0) {
        return;
      }
      const availableActionWidth =
        headerRow.clientWidth -
        leftHeaderContent.scrollWidth -
        rightHeaderContent.scrollWidth -
        headerColumnGap * 2;
      setStackedLayout(availableActionWidth < minInlineWidth);
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
    observer.observe(leftHeaderContent);
    observer.observe(rightHeaderContent);
    return () => {
      observer.disconnect();
      if (rafId != null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafId);
      }
    };
  }, [buttons.length, headerColumnGap, headerRowRef, leftHeaderContentRef, rightHeaderContentRef]);

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
        {overflowMenuItems.map((item) => (
          <MenuItem
            key={item.key}
            selected={item.selected}
            onClick={() => handleOverflowMenuItemClick(item.onClick)}
          >
            <MenuRow icon={item.icon}>{item.title}</MenuRow>
          </MenuItem>
        ))}
      </Menu>
    ) : null;

  const copyMenu = isPresent(copyMenuAnchorPosition) ? (
    <Menu
      id={copyMenuId}
      anchorReference="anchorPosition"
      anchorPosition={copyMenuAnchorPosition ?? undefined}
      open
      onClose={closeCopyMenu}
      MenuListProps={{ 'aria-label': 'Копіювання повідомлення' }}
    >
      <MenuItem onClick={() => handleCopyMenuItemClick(onCopyText)}>
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
        <MenuItem onClick={() => handleCopyMenuItemClick(onCopyFreq)}>
          <MenuRow icon={<SettingsInputAntennaIcon fontSize="small" />}>Копіювати частоту</MenuRow>
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
        <div
          role={stackedLayout ? 'group' : undefined}
          aria-label="Дії повідомлення"
          className={
            stackedLayout
              ? 'message-card-action-group message-card-action-group--stacked'
              : 'message-card-action-group'
          }
          data-action-grid-columns={stackedLayout ? actionGridColumns : undefined}
          style={
            stackedLayout
              ? ({
                  ['--message-card-action-cols' as string]: actionGridColumns,
                } as CSSProperties)
              : undefined
          }
        >
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

function MetaLine({ icon, title, text }: { icon: JSX.Element; title: string; text: string }) {
  return (
    <div className="message-card-header-meta" title={text}>
      <span className="message-card-header-meta__icon" title={title}>
        {icon}
      </span>
      <HeaderText nowrap>{text}</HeaderText>
    </div>
  );
}

function NetworkEtalonSection({
  etalonDisplayModel,
}: {
  etalonDisplayModel: MessageCardEtalonDisplayModel;
}) {
  const {
    displayValue,
    locationDisplayValue,
    primaryKind,
    renderedNetworks,
    showInlineLocationTooltip,
  } = etalonDisplayModel;
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

  const networkContent =
    primaryKind === 'network' ? (
      <div className="flex min-w-0 max-w-full flex-col items-start gap-0.5">
        {renderedNetworks.map(({ networkId, label, badge }) => (
          <div
            key={networkId}
            className="flex min-w-0 max-w-full flex-nowrap items-center gap-1 leading-tight"
          >
            <span className="inline-flex max-w-full items-center align-top [overflow-wrap:anywhere] break-words">
              <strong>{label}</strong>
              {badge ? (
                <span className="badge badge-no-unit-sm relative -top-[0.06em] ml-[0.35em] align-middle">
                  в дорозвідці
                </span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    ) : (
      <HeaderText wrap className="inline-flex items-center">
        {displayValue}
      </HeaderText>
    );

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
    <div className="inline-flex w-fit min-w-0 max-w-full items-center gap-1.5">
      {primaryIcon}
      <div className="flex min-w-0 flex-col items-start gap-0.5">{networkContent}</div>
      {geoButton}
    </div>
  );
}

export type MessageCardHeaderProps = {
  compact?: boolean;
  readOnly?: boolean;
  displayMode: MessageCardDisplayMode;
  excludeMenuOptions?: MessageEntityExcludeMenuOption[];
  id: number;
  msg: InboxMessage;
  copiedFeedbackId: string | null;
  groupName: string | null;
  senderName: string | null;
  etalonDisplayModel: MessageCardEtalonDisplayModel;
  mapHref?: string;
  analysisHref?: string;
  rightInsetPx?: number;
  topRight?: ReactNode;
  metadataTrigger?: ReactNode;
  onBookmark?: () => void;
  onImportant?: () => void;
  onCreateReport?: () => void;
  onCopyText?: () => void;
  onCopyFreq?: () => void;
  onCopyTextWithNetwork?: () => void;
  onCopyTextWithNetworkAndNote?: () => void;
  onCopyMessageLink?: () => void;
  onCopyEtalon?: () => void;
  onCopyLocation?: () => void;
  onAddFrequencyToFilter?: (freq: string) => void;
  onDelete?: () => void;
  onEditDetails?: () => void;
  onExcludeMessageEntity?: (entity: MessageEntityFilterKind, value: string) => void;
};

// Hot path: preserve native structural layout and conditional menu mounting.
// Leaf MUI components remain intentional; see ./AGENTS.md.
function MessageCardHeaderComponent({
  compact = false,
  readOnly = false,
  displayMode,
  excludeMenuOptions = [],
  id,
  msg,
  copiedFeedbackId,
  groupName,
  senderName,
  etalonDisplayModel,
  mapHref,
  analysisHref,
  rightInsetPx = 0,
  topRight,
  metadataTrigger,
  onBookmark,
  onImportant,
  onCreateReport,
  onCopyText,
  onCopyFreq,
  onCopyTextWithNetwork,
  onCopyTextWithNetworkAndNote,
  onCopyMessageLink,
  onCopyEtalon,
  onCopyLocation,
  onAddFrequencyToFilter,
  onDelete,
  onEditDetails,
  onExcludeMessageEntity,
}: MessageCardHeaderProps) {
  const headerRowRef = useRef<HTMLDivElement | null>(null);
  const leftHeaderContentRef = useRef<HTMLDivElement | null>(null);
  const rightHeaderContentRef = useRef<HTMLDivElement | null>(null);
  const headerColumnGap = compact ? 16 : 32;
  const navigationMenuItems = buildMessageCardNavigationMenuItems(
    etalonDisplayModel.renderedNetworks,
    mapHref,
    analysisHref,
  );
  const locationDisplayValue = etalonDisplayModel.locationDisplayValue;
  const showTopGridLocation =
    etalonDisplayModel.primaryKind !== 'location' && locationDisplayValue != null;
  const persistedCoordinates = msg.coordsWithLocality ?? [];
  const firstCoord = persistedCoordinates[0]?.coords;
  const primaryWgs = firstCoord
    ? `${Number(firstCoord.lat.toFixed(5))}, ${Number(firstCoord.lon.toFixed(5))}`
    : null;

  let coordsDisplayValue: string | null = null;
  if (primaryWgs != null) {
    coordsDisplayValue =
      persistedCoordinates.length > 1
        ? `${primaryWgs} · ще ${persistedCoordinates.length - 1}`
        : primaryWgs;
  } else if (persistedCoordinates.length > 1) {
    coordsDisplayValue = formatCoordinatePreviewPointCount(persistedCoordinates.length);
  } else if (isPresent(msg.coords) && msg.coords.trim() !== '') {
    coordsDisplayValue = msg.coords.trim();
    const match = coordsDisplayValue.match(/^([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)$/);
    if (match) {
      coordsDisplayValue = `${Number(parseFloat(match[1]).toFixed(5))}, ${Number(parseFloat(match[2]).toFixed(5))}`;
    }
  }
  const dateTimeBlock = (
    <div className="inline-flex flex-wrap items-center gap-2">
      <div className="inline-flex items-center gap-1.5">
        <ScheduleOutlinedIcon className="message-card-header-icon" />
        <HeaderText>{formatTime(msg.time)}</HeaderText>
      </div>
      {isPresent(msg.date) ? (
        <div className="inline-flex items-center gap-1.5">
          <CalendarTodayOutlinedIcon className="message-card-header-icon" />
          <HeaderText>{formatDateNoYear(msg.date)}</HeaderText>
        </div>
      ) : null}
    </div>
  );
  const hasFrequencyFilter =
    isPresent(onAddFrequencyToFilter) && isPresent(msg.freq) && String(msg.freq).trim() !== '';
  function handleAddFrequencyToFilterClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onAddFrequencyToFilter?.(String(msg.freq ?? '').trim());
  }

  const freqRowItem = isPresent(msg.freq) ? (
    <div className="inline-flex min-w-0 items-center gap-1.5">
      <SettingsInputAntennaOutlinedIcon
        className="message-card-header-icon"
        titleAccess="Частота"
      />
      <HeaderText className="whitespace-nowrap">{msg.freq}</HeaderText>
      {hasFrequencyFilter ? (
        <ActionIconButton
          title="В фільтр"
          icon={<FilterAltOutlinedIcon className="message-card-action-btn__icon" />}
          onClick={handleAddFrequencyToFilterClick}
        />
      ) : null}
    </div>
  ) : null;
  const deviceName = msg.deviceName?.trim();

  const metadataRow = (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
      {isPresent(groupName) ? (
        <MetaLine
          icon={<GraphicEqOutlinedIcon className="message-card-action-btn__icon" />}
          title="Група"
          text={groupName}
        />
      ) : null}
      {isPresent(senderName) ? (
        <MetaLine
          icon={<AccountCircleOutlinedIcon className="message-card-action-btn__icon" />}
          title="Відправник"
          text={senderName}
        />
      ) : null}
      {freqRowItem}
      {isPresent(deviceName) && deviceName !== '' ? (
        <MetaLine
          icon={<DevicesIcon className="message-card-action-btn__icon" />}
          title="Пристрій"
          text={deviceName}
        />
      ) : null}
      {coordsDisplayValue != null ? (
        <MetaLine
          icon={<GpsFixedOutlinedIcon className="message-card-action-btn__icon" />}
          title="Координати"
          text={coordsDisplayValue}
        />
      ) : null}
      <NetworkEtalonSection etalonDisplayModel={etalonDisplayModel} />
      {showTopGridLocation ? (
        <MetaLine
          icon={<PlaceOutlinedIcon className="message-card-action-btn__icon" />}
          title="Локація"
          text={locationDisplayValue}
        />
      ) : null}
    </div>
  );

  const row1 = (
    <div
      ref={headerRowRef}
      data-message-card-header-row="true"
      className="flex w-full items-center"
      style={{
        columnGap: headerColumnGap,
        minHeight: MESSAGE_CARD_HEADER_ROW_MIN_HEIGHT_PX,
      }}
    >
      <div className="flex min-w-0 flex-1 items-center">
        <div ref={leftHeaderContentRef} data-message-card-header-left="true">
          {dateTimeBlock}
        </div>
      </div>
      {!readOnly ? (
        <div className="flex items-center justify-center">
          <ActionIconsRow
            id={id}
            msg={msg}
            compact={compact}
            displayMode={displayMode}
            excludeMenuOptions={excludeMenuOptions}
            etalonDisplayModel={etalonDisplayModel}
            copiedFeedbackId={copiedFeedbackId}
            navigationMenuItems={navigationMenuItems}
            onBookmark={onBookmark}
            onImportant={onImportant}
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
            headerRowRef={headerRowRef}
            leftHeaderContentRef={leftHeaderContentRef}
            rightHeaderContentRef={rightHeaderContentRef}
            headerColumnGap={headerColumnGap}
          />
        </div>
      ) : null}
      <div
        className="flex min-w-0 flex-1 items-center justify-end"
        style={{ paddingRight: `${rightInsetPx}px` }}
      >
        <div ref={rightHeaderContentRef} data-message-card-header-right="true">
          {topRight ?? <div className="min-h-7" />}
        </div>
      </div>
    </div>
  );

  const row2 = (
    <div className="flex w-full items-start gap-2">
      <div className="flex min-w-0 flex-1 items-center">{metadataRow}</div>
      {metadataTrigger ? (
        <div
          className="flex shrink-0 items-center justify-end"
          style={{ paddingRight: `${rightInsetPx}px` }}
        >
          {metadataTrigger}
        </div>
      ) : null}
    </div>
  );

  if (compact) {
    return (
      <div
        data-message-header-grid="true"
        className="flex w-full flex-col gap-2 border-b border-[var(--color-divider)] pb-2"
      >
        {row1}
        {row2}
      </div>
    );
  }

  return (
    <div data-message-header-grid="true" className="flex w-full flex-col gap-1.5">
      {row1}
      {row2}
    </div>
  );
}

export const MessageCardHeader = memo(MessageCardHeaderComponent);
