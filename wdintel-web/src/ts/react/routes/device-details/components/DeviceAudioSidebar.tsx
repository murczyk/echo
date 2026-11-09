import type { DeviceAudioSettingsState } from '../use-device-audio-settings';
import CheckIcon from '@mui/icons-material/Check';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import { ListItemIcon, Menu, MenuItem, Tooltip } from '@mui/material';
import { useState } from 'react';
import { PowerIconButton } from '../../../components/PowerIconButton';
import type { DeviceAudioState } from '../use-device-audio';
import { DeviceAudioList } from './DeviceAudioList';
import { DeviceAudioSettingsMenu } from './DeviceAudioSettingsMenu';
import { DeviceSidebarHeader, deviceSidebarClassName } from './DeviceSidebar';

const SHOW_RECORDING_START_KEY = 'device-audio.show-recording-start';

function readShowRecordingStart() {
  try {
    return localStorage.getItem(SHOW_RECORDING_START_KEY) === 'true';
  } catch {
    return false;
  }
}

export function DeviceAudioSidebar({
  audio,
  settings,
}: {
  audio: DeviceAudioState;
  settings: DeviceAudioSettingsState;
}) {
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const [showRecordingStart, setShowRecordingStart] = useState(readShowRecordingStart);
  const updateShowRecordingStart = (show: boolean) => {
    setShowRecordingStart(show);
    try {
      localStorage.setItem(SHOW_RECORDING_START_KEY, String(show));
    } catch {
      // Keep the setting for this view when browser storage is unavailable.
    }
  };
  const filterLabel = audio.unprocessedOnly ? 'Фільтри аудіо: тільки необроблені' : 'Фільтри аудіо';
  return (
    <aside
      aria-labelledby="device-audio-sidebar-title"
      data-testid="device-audio-sidebar"
      aria-busy={audio.loading}
      className={`${deviceSidebarClassName} flex h-full flex-col overflow-hidden`}
    >
      <DeviceSidebarHeader
        id="device-audio-sidebar-title"
        title="Аудіо"
        actions={
          <>
            <Tooltip title={filterLabel}>
              <PowerIconButton
                size="small"
                aria-label={filterLabel}
                aria-haspopup="menu"
                aria-expanded={filterAnchor !== null}
                aria-controls={filterAnchor !== null ? 'device-audio-filters-menu' : undefined}
                color={audio.unprocessedOnly ? 'primary' : 'inherit'}
                onClick={(event) => setFilterAnchor(event.currentTarget)}
              >
                <FilterAltOutlinedIcon fontSize="small" />
              </PowerIconButton>
            </Tooltip>
            <DeviceAudioSettingsMenu
              settings={settings}
              showRecordingStart={showRecordingStart}
              onShowRecordingStartChange={updateShowRecordingStart}
            />
          </>
        }
      />
      <Menu
        id="device-audio-filters-menu"
        anchorEl={filterAnchor}
        open={filterAnchor !== null}
        onClose={() => setFilterAnchor(null)}
        MenuListProps={{ 'aria-label': 'Фільтри аудіо' }}
      >
        <MenuItem
          role="menuitemcheckbox"
          aria-checked={audio.unprocessedOnly}
          selected={audio.unprocessedOnly}
          onClick={() => {
            setFilterAnchor(null);
            audio.setUnprocessedOnly(!audio.unprocessedOnly);
          }}
        >
          <ListItemIcon>
            <CheckIcon
              fontSize="small"
              className={audio.unprocessedOnly ? undefined : 'invisible'}
            />
          </ListItemIcon>
          Тільки необроблені
        </MenuItem>
      </Menu>
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
        <DeviceAudioList audio={audio} showRecordingStart={showRecordingStart} />
      </div>
    </aside>
  );
}
