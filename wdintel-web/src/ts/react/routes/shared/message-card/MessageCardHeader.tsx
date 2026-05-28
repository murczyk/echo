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
import { Box, Button, ButtonGroup, Menu, MenuItem, Stack, Tooltip, Typography, type SxProps, type Theme } from '@mui/material';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { ComponentProps, MouseEvent, ReactNode } from 'react';
import { ELLIPSIS, isPresent } from '../../../utils/misc';

import type { InboxMessage } from '../../../../../Bindings';
import type { MessageEntityExcludeMenuOption, MessageEntityFilterKind } from '../../rer-duty-neo/utils';
import { formatDateNoYear, formatTime } from '../../rer-duty-neo/utils';
import {
  buildMessageCardNavigationMenuItems,
  type MessageCardEtalonDisplayModel,
  type MessageCardNavigationMenuItem,
} from './message-card.utils';

const COPY_TITLE = `Копіювати${ELLIPSIS}`;
const NAVIGATE_TITLE = `Перейти${ELLIPSIS}`;
const EXCLUDE_TITLE = `Виключити${ELLIPSIS}`;

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
  onCopyEtalon?: () => void;
  onCopyLocation?: () => void;
  onDelete?: () => void;
  onEditDetails?: () => void;
  onExcludeMessageEntity?: (entity: MessageEntityFilterKind, value: string) => void;
  sx?: SxProps<Theme>;
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
  buttonProps?: Omit<ComponentProps<typeof Button>, 'children' | 'onClick' | 'startIcon' | 'endIcon'>;
}) {
  return (
    <Tooltip title={title}>
      <Button
        aria-label={title}
        data-selected={selected}
        onClick={onClick}
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
    <Box
      sx={{
        width: '100%',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: trailing ? '30px minmax(0, auto) 30px' : '30px minmax(0, auto)',
          alignItems: 'center',
          columnGap: 0.5,
          minHeight: 30,
          maxWidth: '100%',
        }}
      >
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>{icon}</Box>
        <Box sx={{ minWidth: 0, maxWidth: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          {text}
        </Box>
        {trailing ? (
          <Box
            sx={{ width: 30, minWidth: 30, height: 30, display: 'flex', justifyContent: 'center', alignItems: 'center' }}
          >
            {trailing}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

function CenteredTextOnlyRow({ text }: { text: JSX.Element }) {
  return (
    <Box
      sx={{
        width: '100%',
        justifyContent: 'center',
        display: 'flex',
        alignItems: 'center',
      }}
    >
      {text}
    </Box>
  );
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
  const [excludeMenuAnchorEl, setExcludeMenuAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [copyMenuAnchorEl, setCopyMenuAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [overflowMenuAnchorEl, setOverflowMenuAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [navigationMenuAnchorEl, setNavigationMenuAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [stackedLayout, setStackedLayout] = useState(compact);
  const canShowExcludeMenu = displayMode === 'duty' && isPresent(onExcludeMessageEntity) && excludeMenuOptions.length > 0;
  const canShowNavigationMenu = navigationMenuItems.length > 0;
  const navigationMenuHasNetwork = navigationMenuItems.some((item) => item.kind === 'network');
  const hasFrequencyCopy = isPresent(msg.freq) && String(msg.freq).trim() !== '';
  const hasEtalonCopy = isPresent(onCopyEtalon);
  const canShowLocationCopy = etalonDisplayModel.primaryKind === 'location' && isPresent(onCopyLocation);
  const overflowMenuItems = [
    isPresent(onEditDetails)
        ? {
          key: 'edit-details',
          title: 'Редагувати додаткові поля та позивні',
          icon: <EditIcon fontSize="inherit" />,
          selected: false,
          onClick: onEditDetails,
        }
      : null,
    isPresent(onDelete)
      ? {
          key: 'delete',
          title: 'Видалити',
          icon: <DeleteIcon fontSize="inherit" color="error" />,
          selected: false,
          onClick: onDelete,
        }
      : null,
  ].filter((item): item is { key: string; title: string; icon: JSX.Element; selected: boolean; onClick: () => void } => item != null);
  const canShowOverflowMenu = overflowMenuItems.length > 0;

  function openExcludeMenu(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setExcludeMenuAnchorEl(event.currentTarget);
  }

  function closeExcludeMenu() {
    setExcludeMenuAnchorEl(null);
  }

  function openCopyMenu(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setCopyMenuAnchorEl(event.currentTarget);
  }

  function closeCopyMenu() {
    setCopyMenuAnchorEl(null);
  }

  function openOverflowMenu(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setOverflowMenuAnchorEl(event.currentTarget);
  }

  function closeOverflowMenu() {
    setOverflowMenuAnchorEl(null);
  }

  function openNavigationMenu(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setNavigationMenuAnchorEl(event.currentTarget);
  }

  function closeNavigationMenu() {
    setNavigationMenuAnchorEl(null);
  }

  function handleExcludeMenuItemClick(option: MessageEntityExcludeMenuOption) {
    onExcludeMessageEntity?.(option.entity, option.value);
    closeExcludeMenu();
  }

  function handleCopyMenuItemClick(action: () => void) {
    action();
    closeCopyMenu();
  }

  function handleOverflowMenuItemClick(action: () => void) {
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
      icon={msg.important ? <FlagIcon fontSize="inherit" /> : <FlagOutlinedIcon fontSize="inherit" />}
      onClick={onImportant}
      selected={msg.important}
    />,
    <ActionIconButton
      key="bookmark"
      title={msg.bookmarked ? 'Прибрати з закладок' : 'Додати в закладки'}
      icon={msg.bookmarked ? <BookmarkIcon fontSize="inherit" /> : <BookmarkBorderOutlinedIcon fontSize="inherit" />}
      onClick={onBookmark}
      selected={msg.bookmarked}
    />,
    <ActionIconButton
      key="copy"
      title={COPY_TITLE}
      icon={<ContentCopyOutlinedIcon fontSize="inherit" />}
      onClick={openCopyMenu}
      buttonProps={{
        'aria-controls': copyMenuAnchorEl ? copyMenuId : undefined,
        'aria-haspopup': 'menu',
        'aria-expanded': copyMenuAnchorEl ? 'true' : undefined,
      }}
    />,
    canShowNavigationMenu ? (
      <ActionIconButton
        key="navigate"
        title={NAVIGATE_TITLE}
        icon={<LaunchIcon fontSize="inherit" />}
        onClick={openNavigationMenu}
        buttonProps={{
          'aria-controls': navigationMenuAnchorEl ? navigationMenuId : undefined,
          'aria-haspopup': 'menu',
          'aria-expanded': navigationMenuAnchorEl ? 'true' : undefined,
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
          'aria-controls': excludeMenuAnchorEl ? excludeMenuId : undefined,
          'aria-haspopup': 'menu',
          'aria-expanded': excludeMenuAnchorEl ? 'true' : undefined,
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
          'aria-controls': overflowMenuAnchorEl ? overflowMenuId : undefined,
          'aria-haspopup': 'menu',
          'aria-expanded': overflowMenuAnchorEl ? 'true' : undefined,
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
    const updateLayout = () => {
      setStackedLayout(root.clientWidth < minInlineWidth);
    };

    updateLayout();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(updateLayout);
    observer.observe(root);
    return () => observer.disconnect();
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
      <Menu
        id={overflowMenuId}
        anchorEl={overflowMenuAnchorEl}
        open={isPresent(overflowMenuAnchorEl) && canShowOverflowMenu}
        onClose={closeOverflowMenu}
        MenuListProps={{ 'aria-label': 'Додаткові дії повідомлення' }}
      >
        {overflowMenuItems.map((item) => (
          <MenuItem key={item.key} selected={item.selected} onClick={() => handleOverflowMenuItemClick(item.onClick)}>
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1.25 }}>
              {item.icon}
              <span>{item.title}</span>
            </Box>
          </MenuItem>
        ))}
      </Menu>
      <Menu
        id={copyMenuId}
        anchorEl={copyMenuAnchorEl}
        open={isPresent(copyMenuAnchorEl)}
        onClose={closeCopyMenu}
        MenuListProps={{ 'aria-label': 'Копіювання повідомлення' }}
      >
        <MenuItem onClick={() => handleCopyMenuItemClick(onCopyText)}>
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1.25 }}>
            <MessageIcon fontSize="small" />
            <span>Копіювати повідомлення</span>
          </Box>
        </MenuItem>
        {hasFrequencyCopy ? (
          <MenuItem onClick={() => handleCopyMenuItemClick(onCopyFreq)}>
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1.25 }}>
              <SettingsInputAntennaIcon fontSize="small" />
              <span>Копіювати частоту</span>
            </Box>
          </MenuItem>
        ) : null}
        {canShowLocationCopy ? (
          <MenuItem onClick={() => handleCopyMenuItemClick(onCopyLocation!)}>
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1.25 }}>
              <PlaceIcon fontSize="small" />
              <span>Копіювати локацію</span>
            </Box>
          </MenuItem>
        ) : null}
        {hasEtalonCopy ? (
          <MenuItem onClick={() => handleCopyMenuItemClick(onCopyEtalon!)}>
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1.25 }}>
              <PeopleIcon fontSize="small" />
              <span>Копіювати прив&apos;язку</span>
            </Box>
          </MenuItem>
        ) : null}
      </Menu>
      <Menu
        id={navigationMenuId}
        anchorEl={navigationMenuAnchorEl}
        open={isPresent(navigationMenuAnchorEl) && canShowNavigationMenu}
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
              <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0, width: '100%' }}>
                <PeopleIcon fontSize="small" />
                <Box component="span" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  В мережу{' '}
                  <Box component="strong" sx={{ fontWeight: 700 }}>
                    {item.networkLabel}
                  </Box>
                  {item.badge ? (
                    <Box
                      component="span"
                      className="badge badge-no-unit-sm"
                      sx={{ ml: '0.35em', verticalAlign: 'middle', position: 'relative', top: '-0.06em' }}
                    >
                      в дорозвідці
                    </Box>
                  ) : null}
                </Box>
              </Box>
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
              <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0, width: '100%' }}>
                <MapIcon fontSize="small" />
                <Box component="span" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.label ?? 'На мапу'}
                </Box>
              </Box>
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
              <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0, width: '100%' }}>
                <BarChartIcon fontSize="small" />
                <Box component="span" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.label ?? 'В аналіз'}
                </Box>
              </Box>
            </MenuItem>
          ),
        )}
      </Menu>
      <Menu
        id={excludeMenuId}
        anchorEl={excludeMenuAnchorEl}
        open={isPresent(excludeMenuAnchorEl) && canShowExcludeMenu}
        onClose={closeExcludeMenu}
        MenuListProps={{ 'aria-label': 'Виключення з фільтрів' }}
      >
        {excludeMenuOptions.map((option) => (
          <MenuItem key={`${option.entity}:${option.value}`} onClick={() => handleExcludeMenuItemClick(option)}>
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1.25 }}>
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
                <Box component="strong">{option.label}</Box>
              </span>
            </Box>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

const MESSAGE_CARD_ACTION_COLOR = 'var(--color-action)';

function MetaLine({ icon, title, text }: { icon: JSX.Element; title: string; text: string }) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }} title={text}>
      <Box sx={{ color: MESSAGE_CARD_ACTION_COLOR, lineHeight: 0, flexShrink: 0 }} title={title}>
        {icon}
      </Box>
      <Typography variant="caption" sx={{ minWidth: 0 }} noWrap>
        {text}
      </Typography>
    </Stack>
  );
}

function NetworkEtalonSection({
  etalonDisplayModel,
}: {
  etalonDisplayModel: MessageCardEtalonDisplayModel;
}) {
  const { displayValue, locationDisplayValue, primaryKind, renderedNetworks, showInlineLocationTooltip } =
    etalonDisplayModel;

  const geoButton = showInlineLocationTooltip && locationDisplayValue != null ? (
    <Tooltip title={locationDisplayValue} placement="top">
      <Box
        component="span"
        aria-label={`Локація: ${locationDisplayValue}`}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxSizing: 'border-box',
          width: 24,
          height: 24,
          p: 0,
          border: '1px solid transparent',
          borderRadius: '50%',
          color: MESSAGE_CARD_ACTION_COLOR,
          flexShrink: 0,
          alignSelf: 'center',
          '&:hover': {
            color: MESSAGE_CARD_ACTION_COLOR,
          },
        }}
      >
        <PlaceOutlinedIcon aria-hidden sx={{ fontSize: 16, lineHeight: 1 }} />
      </Box>
    </Tooltip>
  ) : null;

  const networkContent = primaryKind === 'network' ? (
      <Box
        sx={{
          minWidth: 0,
          maxWidth: '100%',
          display: 'flex',
          flexDirection: 'column',
          rowGap: 0.25,
          alignItems: 'flex-start',
        }}
      >
        {renderedNetworks.map(({ networkId, label, badge }) => (
          <Box
            key={networkId}
            sx={{
              minWidth: 0,
              maxWidth: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              flexWrap: 'nowrap',
              lineHeight: 1.1,
            }}
          >
            <Box
              component="span"
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                maxWidth: '100%',
                verticalAlign: 'top',
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
              }}
            >
              <Typography component="strong" variant="body2" sx={{ fontWeight: 700 }}>
                {label}
              </Typography>
              {badge ? (
                <Box
                  component="span"
                  className="badge badge-no-unit-sm"
                  sx={{
                    ml: '0.35em',
                    verticalAlign: 'middle',
                    position: 'relative',
                    top: '-0.06em',
                  }}
                >
                  в дорозвідці
                </Box>
              ) : null}
            </Box>
          </Box>
        ))}
      </Box>
    ) : (
      <Typography
        component="span"
        variant="body2"
        sx={{ minWidth: 0, overflowWrap: 'anywhere', fontWeight: 700, display: 'inline-flex', alignItems: 'center' }}
      >
        {displayValue}
      </Typography>
    );

  const primaryIcon = primaryKind === 'location' ? (
    <PlaceOutlinedIcon
      sx={{ fontSize: 18, color: MESSAGE_CARD_ACTION_COLOR, flexShrink: 0, alignSelf: 'center', mt: '1px' }}
      titleAccess="Локація"
    />
  ) : (
    <PeopleOutlineOutlinedIcon
      sx={{ fontSize: 18, color: MESSAGE_CARD_ACTION_COLOR, flexShrink: 0, alignSelf: 'center', mt: '1px' }}
      titleAccess="Еталонна прив'язка"
    />
  );

  return (
    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0, maxWidth: '100%', width: 'fit-content' }}>
      {primaryIcon}
      <Box
        sx={{
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          rowGap: 0.25,
          alignItems: 'flex-start',
        }}
      >
        {networkContent}
      </Box>
      {geoButton}
    </Stack>
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
  onBookmark: () => void;
  onImportant: () => void;
  onComment: () => void;
  onCopyText: () => void;
  onCopyFreq: () => void;
  onCopyEtalon?: () => void;
  onCopyLocation?: () => void;
  onAddFrequencyToFilter?: (freq: string) => void;
  onDelete?: () => void;
  onEditDetails?: () => void;
  onExcludeMessageEntity?: (entity: MessageEntityFilterKind, value: string) => void;
};

export function MessageCardHeader({
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
  onBookmark,
  onImportant,
  onComment,
  onCopyText,
  onCopyFreq,
  onCopyEtalon,
  onCopyLocation,
  onAddFrequencyToFilter,
  onDelete,
  onEditDetails,
  onExcludeMessageEntity,
}: MessageCardHeaderProps) {
  const navigationMenuItems = buildMessageCardNavigationMenuItems(etalonDisplayModel.renderedNetworks, mapHref, analysisHref);
  const dateTimeBlock = (
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
      <Stack direction="row" spacing={0.75} alignItems="center">
        <ScheduleOutlinedIcon sx={{ color: MESSAGE_CARD_ACTION_COLOR, fontSize: 18 }} />
        <Typography variant="caption">{formatTime(msg.time)}</Typography>
      </Stack>
      {isPresent(msg.date) ? (
        <Stack direction="row" spacing={0.75} alignItems="center">
          <CalendarTodayOutlinedIcon sx={{ color: MESSAGE_CARD_ACTION_COLOR, fontSize: 18 }} />
          <Typography variant="caption">{formatDateNoYear(msg.date)}</Typography>
        </Stack>
      ) : null}
    </Stack>
  );
  const hasFrequencyFilter = isPresent(onAddFrequencyToFilter) && isPresent(msg.freq) && String(msg.freq).trim() !== '';
  function handleAddFrequencyToFilterClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onAddFrequencyToFilter?.(String(msg.freq ?? '').trim());
  }

  const freqBlock =
    isPresent(msg.freq) ? (
      <CenteredInfoRow
        icon={
          <SettingsInputAntennaOutlinedIcon sx={{ color: MESSAGE_CARD_ACTION_COLOR, fontSize: 18 }} titleAccess="Частота" />
        }
        text={
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="caption" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
              {msg.freq}
            </Typography>
          </Box>
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
      <Box
        data-message-header-grid="true"
        sx={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
          gridTemplateRows: 'repeat(3, minmax(0, auto))',
          width: '100%',
          alignItems: 'center',
          columnGap: 2,
          rowGap: 1,
          pb: 1,
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'center', gridColumn: 1, gridRow: 1 }}>
          {dateTimeBlock}
        </Box>
        <Box
          sx={{
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gridColumn: 2,
            gridRow: 1,
          }}
        >
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
            onCopyEtalon={onCopyEtalon}
            onCopyLocation={onCopyLocation}
            onDelete={onDelete}
            onEditDetails={onEditDetails}
            onExcludeMessageEntity={onExcludeMessageEntity}
          />
        </Box>
        <Box
          sx={{
            minWidth: 0,
            pr: `${rightInsetPx}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gridColumn: 3,
            gridRow: 1,
          }}
        >
          {topRight ?? <Box sx={{ minHeight: 28, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }} />}
        </Box>
        <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'flex-start', gridColumn: 1, gridRow: 2 }}>
          <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap" alignItems="center" sx={{ minWidth: 0 }}>
            {isPresent(groupName) ? (
              <MetaLine icon={<GraphicEqOutlinedIcon sx={{ fontSize: 18 }} />} title="Група" text={groupName} />
            ) : (
              <Typography variant="caption" color="text.secondary">
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
              <Typography variant="caption" color="text.secondary">
                —
              </Typography>
            )}
          </Stack>
        </Box>
        <Box
          sx={{
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gridColumn: 2,
            gridRow: 2,
          }}
        >
          {freqBlock ?? (
            <Typography variant="caption" color="text.secondary">
              —
            </Typography>
          )}
        </Box>
        <Box
          sx={{
            minWidth: 0,
            pr: `${rightInsetPx}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gridColumn: 3,
            gridRow: 2,
          }}
        >
          <Box sx={{ minHeight: 28, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }} />
        </Box>
        <Box
          sx={{
            minWidth: 0,
            display: 'flex',
            alignItems: 'flex-start',
            alignSelf: 'start',
            gridColumn: '1 / -1',
            gridRow: 3,
            columnGap: 1,
            pr: `${rightInsetPx}px`,
          }}
        >
          <Box sx={{ flex: `0 1 ${networkRowContentWidthPct}%`, minWidth: 0, maxWidth: `${networkRowContentWidthPct}%` }}>
            <NetworkEtalonSection etalonDisplayModel={etalonDisplayModel} />
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      data-message-header-grid="true"
      sx={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
        gridTemplateRows: 'repeat(3, minmax(0, auto))',
        width: '100%',
        alignItems: 'center',
        columnGap: 4,
        rowGap: 0.75,
      }}
    >
      <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'center', gridColumn: 1, gridRow: 1 }}>{dateTimeBlock}</Box>
      <Box
        sx={{ minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gridColumn: 2, gridRow: 1 }}
      >
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
          onCopyEtalon={onCopyEtalon}
          onCopyLocation={onCopyLocation}
          onDelete={onDelete}
          onEditDetails={onEditDetails}
          onExcludeMessageEntity={onExcludeMessageEntity}
        />
      </Box>
      <Box
        sx={{
          minWidth: 0,
          pr: `${rightInsetPx}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gridColumn: 3,
          gridRow: 1,
        }}
      >
        {topRight ?? <Box sx={{ minHeight: 28, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }} />}
      </Box>
      <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'flex-start', gridColumn: 1, gridRow: 2 }}>
        <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap" alignItems="center" sx={{ minWidth: 0 }}>
          {isPresent(groupName) ? (
            <MetaLine icon={<GraphicEqOutlinedIcon sx={{ fontSize: 18 }} />} title="Група" text={groupName} />
          ) : (
            <Typography variant="caption" color="text.secondary">
              —
            </Typography>
          )}
          {isPresent(senderName) ? (
            <MetaLine icon={<AccountCircleOutlinedIcon sx={{ fontSize: 18 }} />} title="Відправник" text={senderName} />
          ) : (
            <Typography variant="caption" color="text.secondary">
              —
            </Typography>
          )}
        </Stack>
      </Box>
      <Box
        sx={{ minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gridColumn: 2, gridRow: 2 }}
      >
        {freqBlock ?? (
          <CenteredTextOnlyRow
            text={
              <Typography variant="caption" color="text.secondary">
                —
              </Typography>
            }
          />
        )}
      </Box>
      <Box
        sx={{
          minWidth: 0,
          pr: `${rightInsetPx}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gridColumn: 3,
          gridRow: 2,
        }}
      >
        <Box sx={{ minHeight: 28, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }} />
      </Box>
      <Box
        sx={{
          minWidth: 0,
          display: 'flex',
          alignItems: 'flex-start',
          alignSelf: 'start',
          gridColumn: '1 / -1',
          gridRow: 3,
          columnGap: 1,
          pr: `${rightInsetPx}px`,
        }}
      >
        <Box sx={{ flex: `0 1 ${networkRowContentWidthPct}%`, minWidth: 0, maxWidth: `${networkRowContentWidthPct}%` }}>
          <NetworkEtalonSection etalonDisplayModel={etalonDisplayModel} />
        </Box>
      </Box>
    </Box>
  );
}
