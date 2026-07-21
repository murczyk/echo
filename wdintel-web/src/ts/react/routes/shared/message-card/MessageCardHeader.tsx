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
import { Button, ButtonGroup, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import { memo, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ComponentProps, MouseEvent, ReactNode } from 'react';
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

const COPY_TITLE = `Копіювати${ELLIPSIS}`;
const NAVIGATE_TITLE = `Перейти${ELLIPSIS}`;
const EXCLUDE_TITLE = `Виключити${ELLIPSIS}`;
const MESSAGE_CARD_HEADER_ROW_MIN_HEIGHT_PX = 30;

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
  onComment?: () => void;
  onCopyText?: () => void;
  onCopyFreq?: () => void;
  onCopyTextWithNetwork?: () => void;
  onCopyTextWithNetworkAndNote?: () => void;
  onCopyEtalon?: () => void;
  onCopyLocation?: () => void;
  onDelete?: () => void;
  onEditDetails?: () => void;
  onExcludeMessageEntity?: (entity: MessageEntityFilterKind, value: string) => void;
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
  buttonProps?: Omit<
    ComponentProps<typeof Button>,
    'children' | 'onClick' | 'startIcon' | 'endIcon'
  >;
}) {
  return (
    <Tooltip title={title}>
      <Button
        aria-label={title}
        data-selected={selected}
        onClick={(event) => {
          blurActiveElement();
          onClick(event);
        }}
        {...buttonProps}
        sx={{
          width: 30,
          minWidth: 30,
          height: 30,
          p: 0,
          color: selected ? 'primary.main' : MESSAGE_CARD_ACTION_COLOR,
          backgroundColor: selected ? 'action.selected' : 'transparent',
          '& .MuiSvgIcon-root': { fontSize: 18 },
          '&:hover': {
            backgroundColor: selected ? 'action.selected' : 'action.hover',
          },
        }}
      >
        {icon}
      </Button>
    </Tooltip>
  );
}

function MenuRow({ icon, children }: { icon: JSX.Element; children: ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '10px',
        minWidth: 0,
        width: '100%',
      }}
    >
      {icon}
      <span
        style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {children}
      </span>
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
  onComment,
  onCopyText,
  onCopyFreq,
  onCopyTextWithNetwork,
  onCopyTextWithNetworkAndNote,
  onCopyEtalon,
  onCopyLocation,
  onDelete,
  onEditDetails,
  onExcludeMessageEntity,
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
  const [stackedLayout, setStackedLayout] = useState(compact);
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

  if (!onBookmark || !onImportant || !onComment || !onCopyText || !onCopyFreq) {
    return null;
  }

  const buttons = [
    <ActionIconButton
      key="comment"
      title="Редагувати коментар"
      icon={<ChatBubbleOutlineOutlinedIcon fontSize="inherit" />}
      onClick={onComment}
    />,
    <ActionIconButton
      key="important"
      title={msg.important ? 'Позначити як не важливе' : 'Позначити як важливе'}
      icon={
        msg.important ? <FlagIcon fontSize="inherit" /> : <FlagOutlinedIcon fontSize="inherit" />
      }
      onClick={onImportant}
      selected={msg.important}
    />,
    <ActionIconButton
      key="bookmark"
      title={msg.bookmarked ? 'Прибрати з закладок' : 'Додати в закладки'}
      icon={
        msg.bookmarked ? (
          <BookmarkIcon fontSize="inherit" />
        ) : (
          <BookmarkBorderOutlinedIcon fontSize="inherit" />
        )
      }
      onClick={onBookmark}
      selected={msg.bookmarked}
    />,
    <ActionIconButton
      key="copy"
      title={COPY_TITLE}
      icon={<ContentCopyOutlinedIcon fontSize="inherit" />}
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
        icon={<EditIcon fontSize="inherit" />}
        onClick={onEditDetails}
      />
    ) : null,
    canShowNavigationMenu ? (
      <ActionIconButton
        key="navigate"
        title={NAVIGATE_TITLE}
        icon={<LaunchIcon fontSize="inherit" />}
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
        icon={<RemoveIcon fontSize="inherit" />}
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
        icon={<MoreVertIcon fontSize="inherit" />}
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
  const lastRowButtonCount =
    buttons.length === 0
      ? 0
      : buttons.length % actionGridColumns === 0
        ? actionGridColumns
        : buttons.length % actionGridColumns;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    const minInlineWidth = buttons.length * 32;
    let rafId: number | null = null;
    const updateLayout = () => {
      if (root.clientWidth <= 0) {
        return;
      }
      setStackedLayout(root.clientWidth < minInlineWidth);
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
    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      scheduleUpdateLayout();
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
      if (rafId != null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafId);
      }
    };
  }, [buttons.length, compact]);

  const buttonGroupSx = stackedLayout
    ? {
        display: 'grid',
        gridTemplateColumns: `repeat(${actionGridColumns}, 30px)`,
        gridAutoRows: '30px',
        width: 'fit-content',
        marginInline: 'auto',
        border: '1px solid',
        borderColor: 'var(--color-divider)',
        borderRadius: 1,
        color: 'var(--color-action)',
        overflow: 'hidden',
        '& .MuiButton-root': {
          color: 'var(--color-action)',
          borderColor: 'var(--color-divider)',
          borderRadius: 0,
          borderRight: '1px solid',
          borderBottom: '1px solid',
          borderRightColor: 'divider',
          borderBottomColor: 'divider',
        },
        [`& .MuiButton-root:nth-of-type(${actionGridColumns}n)`]: {
          borderRight: 'none',
        },
        ...(lastRowButtonCount > 0
          ? {
              [`& .MuiButton-root:nth-last-of-type(-n+${lastRowButtonCount})`]: {
                borderBottom: 'none',
              },
            }
          : {}),
        '& .MuiButton-root:hover': {
          borderColor: 'var(--color-divider)',
          backgroundColor: 'action.hover',
        },
      }
    : {
        flexWrap: 'nowrap',
        alignItems: 'center',
        borderRadius: 1,
        '& .MuiButton-root': {
          borderColor: 'var(--color-divider)',
          borderRadius: 0,
        },
        '& .MuiButton-root:first-of-type': {
          borderTopLeftRadius: 4,
          borderBottomLeftRadius: 4,
        },
        '& .MuiButton-root:last-of-type': {
          borderTopRightRadius: 4,
          borderBottomRightRadius: 4,
        },
        '& .MuiButton-root:hover': {
          borderColor: 'var(--color-divider)',
          backgroundColor: 'action.hover',
        },
      };

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
                  <span
                    className="badge badge-no-unit-sm"
                    style={{
                      marginLeft: '0.35em',
                      verticalAlign: 'middle',
                      position: 'relative',
                      top: '-0.06em',
                    }}
                  >
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
      <div ref={rootRef} style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
        <ButtonGroup
          size="small"
          variant="outlined"
          aria-label="Дії повідомлення"
          role={stackedLayout ? 'group' : undefined}
          data-action-grid-columns={stackedLayout ? actionGridColumns : undefined}
          sx={buttonGroupSx}
        >
          {buttons}
        </ButtonGroup>
      </div>
      {overflowMenu}
      {copyMenu}
      {navigationMenu}
      {excludeMenu}
    </>
  );
}

const MESSAGE_CARD_ACTION_COLOR = 'var(--color-action)';

function MetaLine({ icon, title, text }: { icon: JSX.Element; title: string; text: string }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }} title={text}>
      <span
        style={{ color: MESSAGE_CARD_ACTION_COLOR, lineHeight: 0, flexShrink: 0 }}
        title={title}
      >
        {icon}
      </span>
      <Typography variant="body2" sx={{ minWidth: 0, display: 'inline-block' }} noWrap>
        {text}
      </Typography>
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
      <Tooltip title={locationDisplayValue} placement="top">
        <span
          aria-label={`Локація: ${locationDisplayValue}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxSizing: 'border-box',
            width: 24,
            height: 24,
            padding: 0,
            border: '1px solid transparent',
            borderRadius: '50%',
            color: MESSAGE_CARD_ACTION_COLOR,
            flexShrink: 0,
            alignSelf: 'center',
          }}
        >
          <PlaceOutlinedIcon aria-hidden sx={{ fontSize: 16, lineHeight: 1 }} />
        </span>
      </Tooltip>
    ) : null;

  const networkContent =
    primaryKind === 'network' ? (
      <div
        style={{
          minWidth: 0,
          maxWidth: '100%',
          display: 'flex',
          flexDirection: 'column',
          rowGap: 2,
          alignItems: 'flex-start',
        }}
      >
        {renderedNetworks.map(({ networkId, label, badge }) => (
          <div
            key={networkId}
            style={{
              minWidth: 0,
              maxWidth: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              flexWrap: 'nowrap',
              lineHeight: 1.1,
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                maxWidth: '100%',
                verticalAlign: 'top',
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
              }}
            >
              <strong>{label}</strong>
              {badge ? (
                <span
                  className="badge badge-no-unit-sm"
                  style={{
                    marginLeft: '0.35em',
                    verticalAlign: 'middle',
                    position: 'relative',
                    top: '-0.06em',
                  }}
                >
                  в дорозвідці
                </span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    ) : (
      <Typography
        variant="body2"
        sx={{
          minWidth: 0,
          overflowWrap: 'anywhere',
          display: 'inline-flex',
          alignItems: 'center',
        }}
      >
        {displayValue}
      </Typography>
    );

  const primaryIcon =
    primaryKind === 'location' ? (
      <PlaceOutlinedIcon
        sx={{
          fontSize: 18,
          color: MESSAGE_CARD_ACTION_COLOR,
          flexShrink: 0,
          alignSelf: 'center',
          mt: '1px',
        }}
        titleAccess="Локація"
      />
    ) : (
      <PeopleOutlineOutlinedIcon
        sx={{
          fontSize: 18,
          color: MESSAGE_CARD_ACTION_COLOR,
          flexShrink: 0,
          alignSelf: 'center',
          mt: '1px',
        }}
        titleAccess="Еталонна прив'язка"
      />
    );

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        maxWidth: '100%',
        width: 'fit-content',
      }}
    >
      {primaryIcon}
      <div
        style={{
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          rowGap: 2,
          alignItems: 'flex-start',
        }}
      >
        {networkContent}
      </div>
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
  onComment?: () => void;
  onCopyText?: () => void;
  onCopyFreq?: () => void;
  onCopyTextWithNetwork?: () => void;
  onCopyTextWithNetworkAndNote?: () => void;
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
  onComment,
  onCopyText,
  onCopyFreq,
  onCopyTextWithNetwork,
  onCopyTextWithNetworkAndNote,
  onCopyEtalon,
  onCopyLocation,
  onAddFrequencyToFilter,
  onDelete,
  onEditDetails,
  onExcludeMessageEntity,
}: MessageCardHeaderProps) {
  const navigationMenuItems = buildMessageCardNavigationMenuItems(
    etalonDisplayModel.renderedNetworks,
    mapHref,
    analysisHref,
  );
  const locationDisplayValue = etalonDisplayModel.locationDisplayValue;
  const showTopGridLocation =
    etalonDisplayModel.primaryKind !== 'location' && locationDisplayValue != null;
  let coordsDisplayValue: string | null = null;
  if (isPresent(msg.coords) && msg.coords.trim() !== '') {
    coordsDisplayValue = msg.coords.trim();
    const match = coordsDisplayValue.match(/^([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)$/);
    if (match) {
      coordsDisplayValue = `${Number(parseFloat(match[1]).toFixed(5))}, ${Number(parseFloat(match[2]).toFixed(5))}`;
    }
  }
  const dateTimeBlock = (
    <div style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <ScheduleOutlinedIcon sx={{ color: MESSAGE_CARD_ACTION_COLOR, fontSize: 18 }} />
        <Typography variant="body2">{formatTime(msg.time)}</Typography>
      </div>
      {isPresent(msg.date) ? (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <CalendarTodayOutlinedIcon sx={{ color: MESSAGE_CARD_ACTION_COLOR, fontSize: 18 }} />
          <Typography variant="body2">{formatDateNoYear(msg.date)}</Typography>
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
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <SettingsInputAntennaOutlinedIcon
        sx={{ color: MESSAGE_CARD_ACTION_COLOR, fontSize: 18, flexShrink: 0 }}
        titleAccess="Частота"
      />
      <Typography variant="body2" sx={{ whiteSpace: 'nowrap' }}>
        {msg.freq}
      </Typography>
      {hasFrequencyFilter ? (
        <ActionIconButton
          title="В фільтр"
          icon={<FilterAltOutlinedIcon fontSize="inherit" />}
          onClick={handleAddFrequencyToFilterClick}
        />
      ) : null}
    </div>
  ) : null;
  const deviceName = msg.deviceName?.trim();

  const metadataRow = (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 16,
        rowGap: 8,
        minWidth: 0,
        width: '100%',
      }}
    >
      {isPresent(groupName) ? (
        <MetaLine
          icon={<GraphicEqOutlinedIcon sx={{ fontSize: 18 }} />}
          title="Група"
          text={groupName}
        />
      ) : null}
      {isPresent(senderName) ? (
        <MetaLine
          icon={<AccountCircleOutlinedIcon sx={{ fontSize: 18 }} />}
          title="Відправник"
          text={senderName}
        />
      ) : null}
      {freqRowItem}
      {isPresent(deviceName) && deviceName !== '' ? (
        <MetaLine icon={<DevicesIcon sx={{ fontSize: 18 }} />} title="Пристрій" text={deviceName} />
      ) : null}
      {coordsDisplayValue != null ? (
        <MetaLine
          icon={<GpsFixedOutlinedIcon sx={{ fontSize: 18 }} />}
          title="Координати"
          text={coordsDisplayValue}
        />
      ) : null}
      <NetworkEtalonSection etalonDisplayModel={etalonDisplayModel} />
      {showTopGridLocation ? (
        <MetaLine
          icon={<PlaceOutlinedIcon sx={{ fontSize: 18 }} />}
          title="Локація"
          text={locationDisplayValue}
        />
      ) : null}
    </div>
  );

  const row1 = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        columnGap: compact ? 16 : 32,
        width: '100%',
        minHeight: MESSAGE_CARD_HEADER_ROW_MIN_HEIGHT_PX,
      }}
    >
      <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', flex: '1 1 0' }}>
        {dateTimeBlock}
      </div>
      {!readOnly ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
            onComment={onComment}
            onCopyText={onCopyText}
            onCopyFreq={onCopyFreq}
            onCopyTextWithNetwork={onCopyTextWithNetwork}
            onCopyTextWithNetworkAndNote={onCopyTextWithNetworkAndNote}
            onCopyEtalon={onCopyEtalon}
            onCopyLocation={onCopyLocation}
            onDelete={onDelete}
            onEditDetails={onEditDetails}
            onExcludeMessageEntity={onExcludeMessageEntity}
          />
        </div>
      ) : null}
      <div
        style={{
          minWidth: 0,
          paddingRight: `${rightInsetPx}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          flex: '1 1 0',
        }}
      >
        {topRight ?? <div style={{ minHeight: 28 }} />}
      </div>
    </div>
  );

  const row2 = (
    <div style={{ display: 'flex', alignItems: 'flex-start', columnGap: 8, width: '100%' }}>
      <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center' }}>
        {metadataRow}
      </div>
      {metadataTrigger ? (
        <div
          style={{
            paddingRight: `${rightInsetPx}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            flexShrink: 0,
          }}
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
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          rowGap: 8,
          paddingBottom: 8,
          borderBottom: '1px solid',
          borderColor: 'var(--color-divider)',
        }}
      >
        {row1}
        {row2}
      </div>
    );
  }

  return (
    <div
      data-message-header-grid="true"
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        rowGap: 6,
      }}
    >
      {row1}
      {row2}
    </div>
  );
}

export const MessageCardHeader = memo(MessageCardHeaderComponent);
