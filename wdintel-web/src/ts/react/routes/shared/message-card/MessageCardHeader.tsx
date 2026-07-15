import MessageIcon from '@mui/icons-material/Message';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import AccountCircleOutlinedIcon from '@mui/icons-material/AccountCircleOutlined';
import BarChartIcon from '@mui/icons-material/BarChart';
import BookmarkIcon from '@mui/icons-material/Bookmark';
import BookmarkBorderOutlinedIcon from '@mui/icons-material/BookmarkBorderOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import CalendarTodayOutlinedIcon from '@mui/icons-material/CalendarTodayOutlined';
import ChatBubbleOutlineOutlinedIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import EditIcon from '@mui/icons-material/Edit';
import DeskIcon from '@mui/icons-material/Desk';
import DeskOutlinedIcon from '@mui/icons-material/DeskOutlined';
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
import {
  Box,
  Button,
  ButtonGroup,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
  type SxProps,
  type Theme,
} from '@mui/material';
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

/** Where the card is shown: both modes use a 3-column stacked action grid when the toolbar wraps. */
export type MessageCardDisplayMode = 'duty' | 'analysis';

type ActionIconsRowProps = {
  id: number;
  msg: InboxMessage;
  compact?: boolean;
  displayMode: MessageCardDisplayMode;
  excludeMenuOptions?: MessageEntityExcludeMenuOption[];
  etalonDisplayModel: MessageCardEtalonDisplayModel;
  navigationMenuItems?: MessageCardNavigationMenuItem[];
  copiedFeedbackId: string | null;
  onBookmark: () => void;
  onImportant: () => void;
  onComment: () => void;
  onCopyText: () => void;
  onCopyFreq: () => void;
  onCopyTextWithNetwork?: () => void;
  onCopyTextWithNetworkAndNote?: () => void;
  onCopyEtalon?: () => void;
  onCopyLocation?: () => void;
  onDelete?: () => void;
  onEditDetails?: () => void;
  onExcludeMessageEntity?: (entity: MessageEntityFilterKind, value: string) => void;
  sx?: SxProps<Theme>;
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

function CenteredInfoRow({
  icon,
  text,
  trailing,
}: {
  icon: JSX.Element;
  text: JSX.Element;
  trailing?: JSX.Element | null;
}) {
  return (
    <div className="w-full flex justify-center items-center">
      <div
        className="grid items-center gap-x-1 min-h-[30px] max-w-full"
        style={{
          gridTemplateColumns: trailing ? '30px minmax(0, auto) 30px' : '30px minmax(0, auto)',
        }}
      >
        <div className="flex justify-center items-center">{icon}</div>
        <div className="min-w-0 max-w-full flex justify-center items-center">{text}</div>
        {trailing ? (
          <div className="w-[30px] min-w-[30px] h-[30px] flex justify-center items-center">
            {trailing}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CenteredTextOnlyRow({ text }: { text: JSX.Element }) {
  return <div className="w-full flex justify-center items-center">{text}</div>;
}

function ActionIconsRow({
  id,
  msg,
  compact = false,
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
  sx,
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
    etalonDisplayModel.primaryKind === 'location' && isPresent(onCopyLocation);
  const overflowMenuItems = [
    isPresent(onEditDetails)
      ? {
          key: 'edit-details',
          title: 'Редагувати додаткові поля та позивні',
          icon: <EditIcon fontSize="small" />,
          selected: false,
          onClick: onEditDetails,
        }
      : null,
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
  ].filter(Boolean);

  const actionGridColumns = 3;
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

  return (
    <>
      <div ref={rootRef} style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
        {stackedLayout ? (
          <Box
            role="group"
            aria-label="Дії повідомлення"
            data-action-grid-columns={actionGridColumns}
            sx={[
              {
                display: 'grid',
                gridTemplateColumns: `repeat(${actionGridColumns}, 30px)`,
                gridAutoRows: '30px',
                width: 'fit-content',
                marginInline: 'auto',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
                color: 'var(--color-action)',
                overflow: 'hidden',
                '& .MuiButton-root': {
                  color: 'var(--color-action)',
                  borderColor: 'divider',
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
                  borderColor: 'divider',
                  backgroundColor: 'action.hover',
                },
              },
              ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
            ]}
          >
            {buttons}
          </Box>
        ) : (
          <ButtonGroup
            size="small"
            variant="outlined"
            aria-label="Дії повідомлення"
            sx={[
              {
                flexWrap: 'nowrap',
                alignItems: 'center',
                borderRadius: 1,
                '& .MuiButton-root': {
                  borderColor: 'divider',
                  borderRadius: 0,
                },
                '& .MuiButton-root:first-of-type': {
                  borderTopLeftRadius: (theme) => `${theme.shape.borderRadius}px`,
                  borderBottomLeftRadius: (theme) => `${theme.shape.borderRadius}px`,
                },
                '& .MuiButton-root:last-of-type': {
                  borderTopRightRadius: (theme) => `${theme.shape.borderRadius}px`,
                  borderBottomRightRadius: (theme) => `${theme.shape.borderRadius}px`,
                },
                '& .MuiButton-root:hover': {
                  borderColor: 'divider',
                  backgroundColor: 'action.hover',
                },
              },
              ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
            ]}
          >
            {buttons}
          </ButtonGroup>
        )}
      </div>
      {isPresent(overflowMenuAnchorPosition) && canShowOverflowMenu && (
        <Menu
          id={overflowMenuId}
          anchorReference="anchorPosition"
          anchorPosition={overflowMenuAnchorPosition ?? undefined}
          open={true}
          onClose={closeOverflowMenu}
          MenuListProps={{ 'aria-label': 'Додаткові дії повідомлення' }}
        >
          {overflowMenuItems.map((item) => (
            <MenuItem
              key={item.key}
              selected={item.selected}
              onClick={() => handleOverflowMenuItemClick(item.onClick)}
            >
              <span className="inline-flex items-center gap-[10px]">
                {item.icon}
                <span>{item.title}</span>
              </span>
            </MenuItem>
          ))}
        </Menu>
      )}
      {isPresent(copyMenuAnchorPosition) && (
        <Menu
          id={copyMenuId}
          anchorReference="anchorPosition"
          anchorPosition={copyMenuAnchorPosition ?? undefined}
          open={isPresent(copyMenuAnchorPosition)}
          onClose={closeCopyMenu}
          MenuListProps={{ 'aria-label': 'Копіювання повідомлення' }}
        >
          <MenuItem onClick={() => handleCopyMenuItemClick(onCopyText)}>
            <span className="inline-flex items-center gap-[10px]">
              <MessageIcon fontSize="small" />
              <span>Копіювати повідомлення</span>
            </span>
          </MenuItem>
          {hasCopyTextWithNetwork ? (
            <MenuItem onClick={() => handleCopyMenuItemClick(onCopyTextWithNetwork!)}>
              <span className="inline-flex items-center gap-[10px]">
                <PeopleIcon fontSize="small" />
                <span>Копіювати повідомлення з назвою мережі</span>
              </span>
            </MenuItem>
          ) : null}
          {hasCopyTextWithNetworkAndNote ? (
            <MenuItem onClick={() => handleCopyMenuItemClick(onCopyTextWithNetworkAndNote!)}>
              <span className="inline-flex items-center gap-[10px]">
                <ChatBubbleOutlineOutlinedIcon fontSize="small" />
                <span>Копіювати повідомлення з мережею та коментарем</span>
              </span>
            </MenuItem>
          ) : null}
          {hasFrequencyCopy ? (
            <MenuItem onClick={() => handleCopyMenuItemClick(onCopyFreq)}>
              <span className="inline-flex items-center gap-[10px]">
                <SettingsInputAntennaIcon fontSize="small" />
                <span>Копіювати частоту</span>
              </span>
            </MenuItem>
          ) : null}
          {canShowLocationCopy ? (
            <MenuItem onClick={() => handleCopyMenuItemClick(onCopyLocation!)}>
              <span className="inline-flex items-center gap-[10px]">
                <PlaceIcon fontSize="small" />
                <span>Копіювати локацію</span>
              </span>
            </MenuItem>
          ) : null}
          {hasEtalonCopy ? (
            <MenuItem onClick={() => handleCopyMenuItemClick(onCopyEtalon!)}>
              <span className="inline-flex items-center gap-[10px]">
                <PeopleIcon fontSize="small" />
                <span>Копіювати прив&apos;язку</span>
              </span>
            </MenuItem>
          ) : null}
        </Menu>
      )}
      {isPresent(navigationMenuAnchorPosition) && canShowNavigationMenu && (
        <Menu
          id={navigationMenuId}
          anchorReference="anchorPosition"
          anchorPosition={navigationMenuAnchorPosition ?? undefined}
          open={true}
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
                <span className="flex items-center gap-[10px] min-w-0 w-full">
                  <PeopleIcon fontSize="small" />
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                    В мережу <strong className="font-bold">{item.networkLabel}</strong>
                    {item.badge ? (
                      <span className="badge badge-no-unit-sm ml-[0.35em] align-middle relative -top-[0.06em]">
                        в дорозвідці
                      </span>
                    ) : null}
                  </span>
                </span>
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
                <span className="flex items-center gap-[10px] min-w-0 w-full">
                  <MapIcon fontSize="small" />
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                    {item.label ?? 'На мапу'}
                  </span>
                </span>
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
                <span className="flex items-center gap-[10px] min-w-0 w-full">
                  <BarChartIcon fontSize="small" />
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                    {item.label ?? 'В аналіз'}
                  </span>
                </span>
              </MenuItem>
            ),
          )}
        </Menu>
      )}
      {isPresent(excludeMenuAnchorPosition) && canShowExcludeMenu && (
        <Menu
          id={excludeMenuId}
          anchorReference="anchorPosition"
          anchorPosition={excludeMenuAnchorPosition ?? undefined}
          open={true}
          onClose={closeExcludeMenu}
          MenuListProps={{ 'aria-label': 'Виключення з фільтрів' }}
        >
          {excludeMenuOptions.map((option) => (
            <MenuItem
              key={`${option.entity}:${option.value}`}
              onClick={() => handleExcludeMenuItemClick(option)}
            >
              <span className="inline-flex items-center gap-[10px]">
                {option.entity === 'group' ? (
                  <GraphicEqIcon fontSize="small" />
                ) : option.entity === 'sender' ? (
                  <AccountCircleIcon fontSize="small" />
                ) : option.entity === 'freq' ? (
                  <SettingsInputAntennaIcon fontSize="small" />
                ) : (
                  <DeskIcon fontSize="small" />
                )}
                <span>
                  {option.entity === 'group'
                    ? 'Виключити групу'
                    : option.entity === 'sender'
                      ? 'Виключити відправника'
                      : option.entity === 'freq'
                        ? 'Виключити частоту'
                        : 'Виключити пост'}{' '}
                  <strong>{option.label}</strong>
                </span>
              </span>
            </MenuItem>
          ))}
        </Menu>
      )}
    </>
  );
}

const MESSAGE_CARD_ACTION_COLOR = 'var(--color-action)';

function MetaLine({ icon, title, text }: { icon: JSX.Element; title: string; text: string }) {
  return (
    <div className="flex flex-row gap-1.5 items-center min-w-0" title={text}>
      <div className="text-[var(--color-action)] leading-none shrink-0" title={title}>
        {icon}
      </div>
      <Typography variant="body2" sx={{ minWidth: 0 }} noWrap>
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
          className="inline-flex items-center justify-center box-border w-6 h-6 p-0 border border-transparent rounded-full shrink-0 self-center text-[var(--color-action)] hover:text-[var(--color-action)]"
        >
          <PlaceOutlinedIcon aria-hidden sx={{ fontSize: 16, lineHeight: 1 }} />
        </span>
      </Tooltip>
    ) : null;

  const networkContent =
    primaryKind === 'network' ? (
      <div className="min-w-0 max-w-full flex flex-col gap-y-1 items-start">
        {renderedNetworks.map(({ networkId, label, badge }) => (
          <div
            key={networkId}
            className="min-w-0 max-w-full flex items-center gap-1 flex-nowrap leading-[1.1]"
          >
            <span className="inline-flex items-center max-w-full align-top break-words [overflow-wrap:anywhere]">
              <Typography component="strong" variant="body2" sx={{ fontWeight: 700 }}>
                {label}
              </Typography>
              {badge ? (
                <span className="badge badge-no-unit-sm ml-[0.35em] align-middle relative -top-[0.06em]">
                  в дорозвідці
                </span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    ) : (
      <Typography
        component="span"
        variant="body2"
        sx={{
          minWidth: 0,
          overflowWrap: 'anywhere',
          fontWeight: 700,
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
    <div className="flex flex-row gap-1.5 items-center min-w-0 max-w-full w-fit">
      {primaryIcon}
      <div className="min-w-0 flex flex-col gap-y-1 items-start">{networkContent}</div>
      {geoButton}
    </div>
  );
}

export type MessageCardHeaderProps = {
  compact?: boolean;
  displayMode: MessageCardDisplayMode;
  excludeMenuOptions?: MessageEntityExcludeMenuOption[];
  /** Width % of the bottom header row for the network / etalon block. */
  networkRowContentWidthPct?: number;
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
  onBookmark: () => void;
  onImportant: () => void;
  onComment: () => void;
  onCopyText: () => void;
  onCopyFreq: () => void;
  onCopyTextWithNetwork?: () => void;
  onCopyTextWithNetworkAndNote?: () => void;
  onCopyEtalon?: () => void;
  onCopyLocation?: () => void;
  onAddFrequencyToFilter?: (freq: string) => void;
  onDelete?: () => void;
  onEditDetails?: () => void;
  onExcludeMessageEntity?: (entity: MessageEntityFilterKind, value: string) => void;
};

function MessageCardHeaderComponent({
  compact = false,
  displayMode,
  excludeMenuOptions = [],
  networkRowContentWidthPct = 80,
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
    etalonDisplayModel.primaryKind === 'network' && locationDisplayValue != null;
  const dateTimeBlock = (
    <div className="flex flex-row gap-2 flex-wrap items-center">
      <div className="flex flex-row gap-[6px] items-center">
        <ScheduleOutlinedIcon sx={{ color: MESSAGE_CARD_ACTION_COLOR, fontSize: 18 }} />
        <Typography variant="body2">{formatTime(msg.time)}</Typography>
      </div>
      {isPresent(msg.date) ? (
        <div className="flex flex-row gap-[6px] items-center">
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

  const freqBlock = isPresent(msg.freq) ? (
    <CenteredInfoRow
      icon={
        <SettingsInputAntennaOutlinedIcon
          sx={{ color: MESSAGE_CARD_ACTION_COLOR, fontSize: 18 }}
          titleAccess="Частота"
        />
      }
      text={
        <div className="min-w-0">
          <Typography variant="body2" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
            {msg.freq}
          </Typography>
        </div>
      }
      trailing={
        hasFrequencyFilter ? (
          <ActionIconButton
            title="В фільтр"
            icon={<FilterAltOutlinedIcon fontSize="inherit" />}
            onClick={handleAddFrequencyToFilterClick}
          />
        ) : null
      }
    />
  ) : null;

  if (compact) {
    return (
      <div
        data-message-header-grid="true"
        className="grid items-center w-full pb-2 border-b border-divider"
        style={{
          gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
          gridTemplateRows: `repeat(3, minmax(${MESSAGE_CARD_HEADER_ROW_MIN_HEIGHT_PX}px, auto))`,
          columnGap: '16px',
          rowGap: '8px',
        }}
      >
        <div className="min-w-0 flex items-center col-start-1 row-start-1">{dateTimeBlock}</div>
        <div className="min-w-0 flex items-center justify-center col-start-2 row-start-1">
          <ActionIconsRow
            id={id}
            msg={msg}
            compact
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
        <div
          className="min-w-0 flex items-center justify-end col-start-3 row-start-1"
          style={{ paddingRight: rightInsetPx }}
        >
          {topRight ?? <div className="min-h-[28px] flex items-center justify-end" />}
        </div>
        <div className="min-w-0 flex items-start col-start-1 row-start-2">
          <div className="flex flex-row gap-3 flex-wrap items-center min-w-0">
            {isPresent(groupName) ? (
              <MetaLine
                icon={<GraphicEqOutlinedIcon sx={{ fontSize: 18 }} />}
                title="Група"
                text={groupName}
              />
            ) : (
              <Typography variant="body2" color="text.secondary">
                —
              </Typography>
            )}
            {isPresent(senderName) ? (
              <MetaLine
                icon={<AccountCircleOutlinedIcon sx={{ fontSize: 18 }} />}
                title="Відправник"
                text={senderName}
              />
            ) : (
              <Typography variant="body2" color="text.secondary">
                —
              </Typography>
            )}
          </div>
        </div>
        <div className="min-w-0 flex items-center justify-center col-start-2 row-start-2">
          {freqBlock ?? (
            <Typography variant="body2" color="text.secondary">
              —
            </Typography>
          )}
        </div>
        <div
          className="min-w-0 flex items-center justify-end col-start-3 row-start-2"
          style={{ paddingRight: rightInsetPx }}
        >
          <div className="min-h-[28px] flex items-center justify-end">
            {metadataTrigger ?? <div className="min-h-[28px] min-w-[28px]" />}
          </div>
        </div>
        <div
          className="min-w-0 flex items-center col-start-1 col-end-3 row-start-3 gap-2"
          style={{ paddingRight: rightInsetPx }}
        >
          <div
            className="min-w-0"
            style={{
              flex: `0 1 ${networkRowContentWidthPct}%`,
              maxWidth: `${networkRowContentWidthPct}%`,
            }}
          >
            <NetworkEtalonSection etalonDisplayModel={etalonDisplayModel} />
          </div>
        </div>
        <div
          className="min-w-0 flex items-center justify-end col-start-3 row-start-3"
          style={{ paddingRight: rightInsetPx }}
        >
          {showTopGridLocation ? (
            <MetaLine
              icon={<PlaceOutlinedIcon sx={{ fontSize: 18 }} />}
              title="Локація"
              text={locationDisplayValue}
            />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      data-message-header-grid="true"
      className="grid items-center w-full"
      style={{
        gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
        gridTemplateRows: `repeat(3, minmax(${MESSAGE_CARD_HEADER_ROW_MIN_HEIGHT_PX}px, auto))`,
        columnGap: '32px',
        rowGap: '6px',
      }}
    >
      <div className="min-w-0 flex items-center col-start-1 row-start-1">{dateTimeBlock}</div>
      <div className="min-w-0 flex items-center justify-center col-start-2 row-start-1">
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
      <div
        className="min-w-0 flex items-center justify-end col-start-3 row-start-1"
        style={{ paddingRight: rightInsetPx }}
      >
        {topRight ?? <div className="min-h-[28px] flex items-center justify-end" />}
      </div>
      <div className="min-w-0 flex items-start col-start-1 row-start-2">
        <div className="flex flex-row gap-3 flex-wrap items-center min-w-0">
          {isPresent(groupName) ? (
            <MetaLine
              icon={<GraphicEqOutlinedIcon sx={{ fontSize: 18 }} />}
              title="Група"
              text={groupName}
            />
          ) : (
            <Typography variant="body2" color="text.secondary">
              —
            </Typography>
          )}
          {isPresent(senderName) ? (
            <MetaLine
              icon={<AccountCircleOutlinedIcon sx={{ fontSize: 18 }} />}
              title="Відправник"
              text={senderName}
            />
          ) : (
            <Typography variant="body2" color="text.secondary">
              —
            </Typography>
          )}
        </div>
      </div>
      <div className="min-w-0 flex items-center justify-center col-start-2 row-start-2">
        {freqBlock ?? (
          <CenteredTextOnlyRow
            text={
              <Typography variant="body2" color="text.secondary">
                —
              </Typography>
            }
          />
        )}
      </div>
      <div
        className="min-w-0 flex items-center justify-end col-start-3 row-start-2"
        style={{ paddingRight: rightInsetPx }}
      >
        <div className="min-h-[28px] flex items-center justify-end">
          {metadataTrigger ?? <div className="min-h-[28px] min-w-[28px]" />}
        </div>
      </div>
      <div
        className="min-w-0 flex items-center col-start-1 col-end-3 row-start-3 gap-2"
        style={{ paddingRight: rightInsetPx }}
      >
        <div
          className="min-w-0"
          style={{
            flex: `0 1 ${networkRowContentWidthPct}%`,
            maxWidth: `${networkRowContentWidthPct}%`,
          }}
        >
          <NetworkEtalonSection etalonDisplayModel={etalonDisplayModel} />
        </div>
      </div>
      <div
        className="min-w-0 flex items-center justify-end col-start-3 row-start-3"
        style={{ paddingRight: rightInsetPx }}
      >
        {showTopGridLocation ? (
          <MetaLine
            icon={<PlaceOutlinedIcon sx={{ fontSize: 18 }} />}
            title="Локація"
            text={locationDisplayValue}
          />
        ) : null}
      </div>
    </div>
  );
}

export const MessageCardHeader = memo(MessageCardHeaderComponent);
