import { Box, Button, IconButton, Tooltip } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import NotificationsOutlinedIcon from '@mui/icons-material/NotificationsOutlined';
import NotificationsActiveOutlinedIcon from '@mui/icons-material/NotificationsActiveOutlined';
import NotificationsOffOutlinedIcon from '@mui/icons-material/NotificationsOffOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import SpellcheckIcon from '@mui/icons-material/Spellcheck';
import type { MouseEvent, ReactNode, RefObject } from 'react';
import type {
  OrganismKeywordSetDto,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
} from '../../../../Bindings';
import { FeedFilterPanel, type FeedFilterPanelModel } from './FeedFilterPanel';
import { FeedKeywordsPanel } from './FeedKeywordsPanel';
import { FeedNotificationPanel } from './FeedNotificationPanel';
import type { DutyNotificationBellState } from './notifications';
import { dutyTopActionButtonSx } from './top-action-styles';

/** At this many side-by-side feeds, column header actions use icons only (4+). */
export const DUTY_ICON_ONLY_COLUMN_HEADER_MIN_FEEDS = 4;

/** At this many feeds on narrow layout, stream tabs show compact numbered badges. */
export const DUTY_ICON_ONLY_FEED_TAB_MIN_FEEDS = 4;

type FeedColumnHeaderProps = {
  feedCount: number;
  canRemove: boolean;
  showFilters: boolean;
  showNotificationPanel: boolean;
  showKeywordsPanel: boolean;
  dutyNotificationBellState: DutyNotificationBellState;
  onCreateFeed?: () => void;
  onToggleFilters: () => void;
  onToggleNotificationPanel: () => void;
  onToggleKeywordsPanel: () => void;
  onToggleDutyNotifications: (event: MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  onRemoveColumn: () => void;
  headerRef: RefObject<HTMLDivElement | null>;
  filtersPanelRef: RefObject<HTMLDivElement | null>;
  notificationPanelRef: RefObject<HTMLDivElement | null>;
  keywordsPanelRef: RefObject<HTMLDivElement | null>;
  filterPanel: FeedFilterPanelModel;
  feedId: string;
  feedFilter: RerDutyFeedFilterState;
  keywordsPanel: {
    keywordSets: OrganismKeywordSetDto[];
    onFilterChange: (feedId: string, nextFilter: RerDutyFeedFilterState) => void;
    onKeywordSetsReload: () => Promise<void>;
  };
  notificationStorageSyncKey: number;
  onNotificationPersisted: () => void;
  notificationStorageError: string | null;
  onNotificationStorageErrorChange: (error: string | null) => void;
  onNotificationStatusChanged: () => void;
};

const columnPanelOverlaySx = {
  position: 'absolute',
  top: 32,
  left: 0,
  right: 0,
  bottom: 0,
  display: 'flex',
  alignItems: 'flex-start',
  zIndex: 2,
  pointerEvents: 'auto',
} as const;

const columnPanelInnerSx = {
  width: '100%',
  maxHeight: '100%',
  minHeight: 0,
  display: 'flex',
  alignItems: 'flex-start',
  pointerEvents: 'auto',
} as const;

const headerIconButtonSx = {
  borderRadius: 0,
  height: 32,
  width: 40,
  maxHeight: 32,
  flexShrink: 0,
  '&:hover': { backgroundColor: 'action.hover' },
} as const;

type HeaderPanelToggleProps = {
  iconOnly: boolean;
  label: string;
  icon?: ReactNode;
  expanded: boolean;
  onClick: () => void;
  borderLeft?: boolean;
  borderRight?: boolean;
};

function HeaderPanelToggle({
  iconOnly,
  label,
  icon,
  expanded,
  onClick,
  borderLeft = false,
  borderRight = false,
}: HeaderPanelToggleProps) {
  const activeColor = expanded ? 'primary.light' : 'text.primary';
  const borderSx = {
    ...(borderLeft ? { borderLeft: '1px solid', borderColor: 'rgba(148, 163, 184, 0.28)' } : {}),
    ...(borderRight
      ? { borderRight: '1px solid', borderRightColor: 'rgba(148, 163, 184, 0.28)' }
      : {}),
  };

  if (iconOnly) {
    return (
      <Tooltip title={label}>
        <IconButton
          className="duty-header-panel-toggle"
          size="small"
          aria-label={label}
          aria-expanded={expanded}
          onClick={onClick}
          sx={{
            ...headerIconButtonSx,
            width: '100%',
            maxWidth: '100%',
            ...borderSx,
            color: activeColor,
          }}
        >
          {icon}
        </IconButton>
      </Tooltip>
    );
  }

  return (
    <Tooltip title={label}>
      <Button
        size="small"
        variant="text"
        className="duty-header-panel-toggle self-stretch min-w-0"
        {...(icon != null ? { startIcon: icon } : {})}
        endIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        onClick={onClick}
        aria-expanded={expanded}
        aria-label={label}
        sx={{
          borderRadius: 0,
          width: '100%',
          minWidth: 0,
          maxWidth: '100%',
          px: 1,
          color: activeColor,
          backgroundColor: 'transparent',
          ...borderSx,
          '& .MuiButton-startIcon': { flexShrink: 0, mr: 0.25 },
          '& .MuiButton-endIcon': { flexShrink: 0, ml: 0 },
          '&:hover': {
            backgroundColor: 'action.hover',
          },
        }}
      >
        <Box
          component="span"
          sx={{
            display: 'block',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </Box>
      </Button>
    </Tooltip>
  );
}

export function FeedColumnHeader({
  feedCount,
  canRemove,
  showFilters,
  showNotificationPanel,
  showKeywordsPanel,
  dutyNotificationBellState,
  onCreateFeed,
  onToggleFilters,
  onToggleNotificationPanel,
  onToggleKeywordsPanel,
  onToggleDutyNotifications,
  onRemoveColumn,
  headerRef,
  filtersPanelRef,
  notificationPanelRef,
  keywordsPanelRef,
  filterPanel,
  feedId,
  feedFilter,
  keywordsPanel,
  notificationStorageSyncKey,
  onNotificationPersisted,
  notificationStorageError,
  onNotificationStorageErrorChange,
  onNotificationStatusChanged,
}: FeedColumnHeaderProps) {
  const iconOnlyHeader = feedCount >= DUTY_ICON_ONLY_COLUMN_HEADER_MIN_FEEDS;

  return (
    <Box
      sx={{
        backgroundColor: 'background.paper',
        borderRadius: 0,
        border: '1px solid rgba(148, 163, 184, 0.28)',
        flexShrink: 0,
      }}
    >
      <Box
        ref={headerRef}
        data-duty-feed-header-layout="flex"
        sx={{
          display: 'flex',
          alignItems: 'stretch',
          height: 32,
          minWidth: 0,
          width: '100%',
          position: 'sticky',
          top: 0,
          zIndex: 1,
          backgroundColor: 'background.paper',
          borderBottomLeftRadius: 0,
          borderBottomRightRadius: 0,
          borderBottom: 'none',
          boxShadow: 'none',
          '& .MuiButton-root': {
            minHeight: 0,
            height: 32,
            maxHeight: 32,
          },
          '& .duty-header-panel-toggle': {
            width: '100%',
          },
        }}
      >
        <Box
          data-duty-feed-header-controls
          sx={{
            display: 'flex',
            flex: '1 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            alignItems: 'stretch',
          }}
        >
          <Box sx={{ display: 'flex', flex: '1 1 0', minWidth: 0, minHeight: 0 }}>
            <HeaderPanelToggle
              iconOnly={iconOnlyHeader}
              label="Фільтри"
              icon={<SettingsOutlinedIcon />}
              expanded={showFilters}
              onClick={onToggleFilters}
            />
          </Box>
          <Box
            className="flex items-stretch self-stretch border-l border-solid min-w-0"
            sx={{
              borderColor: 'rgba(148, 163, 184, 0.28)',
              display: 'flex',
              flex: '1 1 0',
              minWidth: 0,
              minHeight: 0,
            }}
          >
            {!iconOnlyHeader ? (
              <Tooltip title={bellStateLabel[dutyNotificationBellState]}>
                <IconButton
                  type="button"
                  size="small"
                  aria-label={bellStateLabel[dutyNotificationBellState]}
                  aria-pressed={dutyNotificationBellState !== 'off'}
                  onClick={onToggleDutyNotifications}
                  sx={{
                    ...headerIconButtonSx,
                    flexShrink: 0,
                    borderRight: '1px solid',
                    borderRightColor: 'rgba(148, 163, 184, 0.28)',
                    color: bellStateColor[dutyNotificationBellState],
                  }}
                >
                  {dutyNotificationBellState === 'off' ? (
                    <NotificationsOffOutlinedIcon sx={{ fontSize: 20 }} />
                  ) : (
                    <NotificationsActiveOutlinedIcon sx={{ fontSize: 20 }} />
                  )}
                </IconButton>
              </Tooltip>
            ) : null}
            <Box sx={{ display: 'flex', flex: '1 1 0', minWidth: 0, minHeight: 0 }}>
              <HeaderPanelToggle
                iconOnly={iconOnlyHeader}
                label={
                  iconOnlyHeader
                    ? `Сповіщення — ${bellStateLabel[dutyNotificationBellState]}`
                    : 'Сповіщення'
                }
                icon={
                  iconOnlyHeader ? (
                    <NotificationsOutlinedIcon
                      sx={{ color: bellStateColor[dutyNotificationBellState] }}
                    />
                  ) : undefined
                }
                expanded={showNotificationPanel}
                onClick={onToggleNotificationPanel}
                borderRight
              />
            </Box>
          </Box>
          <Box sx={{ display: 'flex', flex: '1 1 0', minWidth: 0, minHeight: 0 }}>
            <HeaderPanelToggle
              iconOnly={iconOnlyHeader}
              label="Підсвітка"
              icon={<SpellcheckIcon />}
              expanded={showKeywordsPanel}
              onClick={onToggleKeywordsPanel}
            />
          </Box>
        </Box>
        <Box
          data-duty-feed-header-actions
          sx={{
            display: 'flex',
            alignItems: 'stretch',
            flexShrink: 0,
            minWidth: 0,
            minHeight: 0,
          }}
        >
          {onCreateFeed ? (
            <Tooltip title="Додати стрічку">
              <IconButton
                size="small"
                aria-label="Додати стрічку"
                onClick={onCreateFeed}
                sx={{
                  ...dutyTopActionButtonSx,
                  borderLeft: '1px solid',
                  borderLeftColor: 'divider',
                  borderRadius: 0,
                  flexShrink: 0,
                }}
              >
                <AddIcon />
              </IconButton>
            </Tooltip>
          ) : null}
          {canRemove ? (
            <Tooltip title="Закрити стрічку">
              <IconButton
                size="small"
                aria-label="Закрити стрічку"
                onClick={onRemoveColumn}
                sx={{
                  ...dutyTopActionButtonSx,
                  flexShrink: 0,
                  borderLeft: '1px solid',
                  borderLeftColor: 'divider',
                  borderRadius: 0,
                }}
              >
                <CloseIcon />
              </IconButton>
            </Tooltip>
          ) : null}
        </Box>
      </Box>
      {showFilters && (
        <Box sx={columnPanelOverlaySx}>
          <Box ref={filtersPanelRef} sx={columnPanelInnerSx}>
            <FeedFilterPanel panel={filterPanel} />
          </Box>
        </Box>
      )}
      {showNotificationPanel && (
        <Box sx={columnPanelOverlaySx}>
          <Box ref={notificationPanelRef} sx={columnPanelInnerSx}>
            <FeedNotificationPanel
              feedId={feedId}
              storageSyncKey={notificationStorageSyncKey}
              onPersisted={onNotificationPersisted}
              storageError={notificationStorageError}
              onStorageErrorChange={onNotificationStorageErrorChange}
              onNotificationStatusChanged={onNotificationStatusChanged}
            />
          </Box>
        </Box>
      )}
      {showKeywordsPanel && (
        <Box sx={columnPanelOverlaySx}>
          <Box ref={keywordsPanelRef} sx={columnPanelInnerSx}>
            <FeedKeywordsPanel
              feedId={feedId}
              filter={feedFilter}
              keywordSets={keywordsPanel.keywordSets}
              onFilterChange={keywordsPanel.onFilterChange}
              onKeywordSetsReload={keywordsPanel.onKeywordSetsReload}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}

const bellStateLabel = {
  off: 'Сповіщення вимкнені для стрічки',
  ready: 'Сповіщення готові; вимкнути для стрічки',
  degraded: 'Сповіщення потребують налаштування або взаємодії',
  unsupported: 'Запитані сповіщення не підтримуються',
} satisfies Record<DutyNotificationBellState, string>;
const bellStateColor = {
  off: 'text.secondary',
  ready: 'primary.main',
  degraded: 'warning.main',
  unsupported: 'error.main',
} satisfies Record<DutyNotificationBellState, string>;
