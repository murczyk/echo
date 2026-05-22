import { Box, Button, IconButton } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import NotificationsActiveOutlinedIcon from '@mui/icons-material/NotificationsActiveOutlined';
import NotificationsOffOutlinedIcon from '@mui/icons-material/NotificationsOffOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import type { MouseEvent, RefObject } from 'react';
import { FeedFilterPanel, type FeedFilterPanelModel } from './FeedFilterPanel';
import { FeedNotificationPanel } from './FeedNotificationPanel';
import { dutyTopActionButtonSx } from './top-action-styles';

type FeedColumnHeaderProps = {
  canRemove: boolean;
  showFilters: boolean;
  showNotificationPanel: boolean;
  dutyNotificationsOn: boolean;
  onToggleFilters: () => void;
  onToggleNotificationPanel: () => void;
  onToggleDutyNotifications: (event: MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  onRemoveColumn: () => void;
  headerRef: RefObject<HTMLDivElement | null>;
  filtersPanelRef: RefObject<HTMLDivElement | null>;
  notificationPanelRef: RefObject<HTMLDivElement | null>;
  filterPanel: FeedFilterPanelModel;
  feedId: string;
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

export function FeedColumnHeader({
  canRemove,
  showFilters,
  showNotificationPanel,
  dutyNotificationsOn,
  onToggleFilters,
  onToggleNotificationPanel,
  onToggleDutyNotifications,
  onRemoveColumn,
  headerRef,
  filtersPanelRef,
  notificationPanelRef,
  filterPanel,
  feedId,
  notificationStorageSyncKey,
  onNotificationPersisted,
}: FeedColumnHeaderProps) {
  return (
    <Box
      sx={{
        backgroundColor: 'background.paper',
        borderRadius: 0,
        border: '1px solid rgba(148, 163, 184, 0.28)',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <Box
        ref={headerRef}
        className="flex justify-between gap-2 flex-wrap text-sm items-stretch h-[32px] shrink-0"
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          backgroundColor: 'background.paper',
          overflow: 'hidden',
          borderBottomLeftRadius: 0,
          borderBottomRightRadius: 0,
          borderBottom: 'none',
          boxShadow: 'none',
          '& .MuiButton-root': {
            minHeight: 0,
            height: 32,
            maxHeight: 32,
            overflow: 'hidden',
          },
        }}
      >
        <Box className="flex min-w-0 items-stretch">
          <Button
            size="small"
            variant="text"
            className="self-stretch px-4"
            startIcon={<SettingsOutlinedIcon />}
            endIcon={showFilters ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            onClick={onToggleFilters}
            aria-expanded={showFilters}
            sx={{
              borderRadius: 0,
              color: showFilters ? 'primary.light' : 'text.primary',
              backgroundColor: 'transparent',
              '&:hover': {
                backgroundColor: 'action.hover',
              },
            }}
          >
            Фільтри
          </Button>
          <Box
            className="flex items-stretch self-stretch border-l border-solid"
            sx={{ borderColor: 'rgba(148, 163, 184, 0.28)' }}
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
                borderRadius: 0,
                height: 32,
                width: 40,
                maxHeight: 32,
                color: dutyNotificationsOn ? 'primary.main' : 'text.secondary',
                '&:hover': { backgroundColor: 'action.hover' },
              }}
            >
              {dutyNotificationsOn ? (
                <NotificationsActiveOutlinedIcon sx={{ fontSize: 20 }} />
              ) : (
                <Box
                  component="span"
                  sx={{
                    position: 'relative',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 22,
                    height: 22,
                  }}
                >
                  <NotificationsOffOutlinedIcon sx={{ fontSize: 20 }} />
                </Box>
              )}
            </IconButton>
            <Button
              size="small"
              variant="text"
              className="self-stretch px-2 min-w-0"
              endIcon={showNotificationPanel ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              onClick={onToggleNotificationPanel}
              aria-expanded={showNotificationPanel}
              sx={{
                borderRadius: 0,
                color: showNotificationPanel ? 'primary.light' : 'text.primary',
                backgroundColor: 'transparent',
                '&:hover': {
                  backgroundColor: 'action.hover',
                },
              }}
            >
              Сповіщення
            </Button>
          </Box>
        </Box>
        {canRemove && (
          <Button
            size="small"
            color="inherit"
            aria-label="Закрити колонку"
            onClick={onRemoveColumn}
            sx={dutyTopActionButtonSx}
          >
            <CloseIcon />
          </Button>
        )}
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
            <FeedNotificationPanel feedId={feedId} storageSyncKey={notificationStorageSyncKey} onPersisted={onNotificationPersisted} />
          </Box>
        </Box>
      )}
    </Box>
  );
}
