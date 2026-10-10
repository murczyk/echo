import CheckIcon from '@mui/icons-material/Check';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { ListItemIcon, Menu, MenuItem, Tooltip } from '@mui/material';
import { useState } from 'react';
import { PowerIconButton } from '../../../components/PowerIconButton';

export function DeviceAudioSettingsMenu({
  showRecordingStart,
  onShowRecordingStartChange,
}: {
  showRecordingStart: boolean;
  onShowRecordingStartChange: (show: boolean) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <Tooltip title="Налаштування списку аудіо">
        <PowerIconButton
          size="small"
          aria-label="Налаштування списку аудіо"
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          aria-controls={anchor !== null ? 'device-audio-settings-menu' : undefined}
          onClick={(event) => setAnchor(event.currentTarget)}
        >
          <MoreVertIcon fontSize="small" />
        </PowerIconButton>
      </Tooltip>
      <Menu
        id="device-audio-settings-menu"
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        MenuListProps={{ 'aria-label': 'Налаштування списку аудіо' }}
      >
        <MenuItem
          className="whitespace-normal!"
          role="menuitemcheckbox"
          aria-checked={showRecordingStart}
          selected={showRecordingStart}
          onClick={() => {
            setAnchor(null);
            onShowRecordingStartChange(!showRecordingStart);
          }}
        >
          <ListItemIcon>
            <CheckIcon fontSize="small" className={showRecordingStart ? undefined : 'invisible'} />
          </ListItemIcon>
          Показувати дату й час початку
        </MenuItem>
      </Menu>
    </>
  );
}
