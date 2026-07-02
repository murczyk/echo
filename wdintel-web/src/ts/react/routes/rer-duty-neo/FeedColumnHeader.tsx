import { Box, Button, IconButton, Tooltip } from '@mui/material';
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
  dutyNotificationsOn: boolean;
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
  dutyNotificationsOn,
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
        sx={{
          display: 'grid',
          gridTemplateColumns: canRemove ? 'minmax(0, 1fr) auto' : 'minmax(0, 1fr)',
          alignItems: 'stretch',
          height: 32,
          minWidth: 0,
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
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            width: '100%',
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          <Box sx={{ display: 'flex', minWidth: 0, minHeight: 0 }}>
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
              minWidth: 0,
              minHeight: 0,
            }}
          >
            {!iconOnlyHeader ? (
              <Tooltip
                title={
                  dutyNotificationsOn
                    ? 'Вимкнути звукові та браузерні сповіщення для стрічки'
                    : 'Увімкнути звукові та браузерні сповіщення для стрічки'
                }
              >
                <IconButton
                  type="button"
                  size="small"
                  aria-label={
                    dutyNotificationsOn
                      ? 'Вимкнути звукові та браузерні сповіщення для стрічки'
                      : 'Увімкнути звукові та браузерні сповіщення для стрічки'
                  }
                  aria-pressed={dutyNotificationsOn}
                  onClick={onToggleDutyNotifications}
                  sx={{
                    ...headerIconButtonSx,
                    flexShrink: 0,
                    borderRight: '1px solid',
                    borderRightColor: 'rgba(148, 163, 184, 0.28)',
                    color: dutyNotificationsOn ? 'primary.main' : 'text.secondary',
                  }}
                >
                  {dutyNotificationsOn ? (
                    <NotificationsActiveOutlinedIcon sx={{ fontSize: 20 }} />
                  ) : (
                    <NotificationsOffOutlinedIcon sx={{ fontSize: 20 }} />
                  )}
                </IconButton>
              </Tooltip>
            ) : null}
            <Box sx={{ display: 'flex', flex: '1 1 auto', minWidth: 0, minHeight: 0 }}>
              <HeaderPanelToggle
                iconOnly={iconOnlyHeader}
                label="Сповіщення"
                icon={iconOnlyHeader ? <NotificationsOutlinedIcon /> : undefined}
                expanded={showNotificationPanel}
                onClick={onToggleNotificationPanel}
                borderRight
              />
            </Box>
          </Box>
          <Box sx={{ display: 'flex', minWidth: 0, minHeight: 0 }}>
            <HeaderPanelToggle
              iconOnly={iconOnlyHeader}
              label="Підсвітка"
              icon={<SpellcheckIcon />}
              expanded={showKeywordsPanel}
              onClick={onToggleKeywordsPanel}
              borderLeft
            />
          </Box>
        </Box>
        {canRemove ? (
          <Tooltip title="Закрити колонку">
            <IconButton
              size="small"
              aria-label="Закрити колонку"
              onClick={onRemoveColumn}
              sx={{
                ...dutyTopActionButtonSx,
                position: 'sticky',
                right: 0,
                zIndex: 1,
                flexShrink: 0,
                borderLeft: '1px solid',
                borderLeftColor: 'divider',
              }}
            >
              <CloseIcon />
            </IconButton>
          </Tooltip>
        ) : null}
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
