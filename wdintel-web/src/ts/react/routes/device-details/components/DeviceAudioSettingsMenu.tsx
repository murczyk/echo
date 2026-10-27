import CheckIcon from '@mui/icons-material/Check';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { ListItemIcon, Menu, MenuItem, Tooltip } from '@mui/material';
import { useId, useState } from 'react';
import type { DeviceAudioSettingsState } from '../use-device-audio-settings';
import { PowerIconButton } from '../../../components/PowerIconButton';

export function DeviceAudioSettingsMenu({
  settings,
  showRecordingStart,
  onShowRecordingStartChange,
}: {
  settings: DeviceAudioSettingsState;
  showRecordingStart: boolean;
  onShowRecordingStartChange: (show: boolean) => void;
}) {
  const menuId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <Tooltip title="Налаштування списку аудіо">
        <PowerIconButton
          size="small"
          aria-label="Налаштування списку аудіо"
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          aria-controls={anchor !== null ? menuId : undefined}
          onClick={(event) => {
            setAnchor(event.currentTarget);
            settings.refresh();
          }}
        >
          <MoreVertIcon fontSize="small" />
        </PowerIconButton>
      </Tooltip>
      <Menu
        id={menuId}
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
        <MenuItem
          className="whitespace-normal!"
          role="menuitemcheckbox"
          aria-checked={settings.value?.enabled ?? false}
          selected={settings.value?.enabled ?? false}
          disabled={
            settings.loading ||
            settings.pending ||
            settings.error ||
            !settings.value?.canManageSetting
          }
          onClick={() => settings.setEnabled(!settings.value?.enabled)}
        >
          <ListItemIcon>
            <CheckIcon
              fontSize="small"
              className={settings.value?.enabled ? undefined : 'invisible'}
            />
          </ListItemIcon>
          <div>
            <div>Автотранскрибація аудіо</div>
            {settings.pending ? (
              <div role="status">Збереження…</div>
            ) : settings.loading ? (
              <div role="status">Завантаження…</div>
            ) : settings.error ? (
              <div>Не вдалося завантажити налаштування. Відкрийте меню повторно.</div>
            ) : settings.value?.blockedReason ? (
              <div>{settings.value.blockedReason}</div>
            ) : null}
          </div>
        </MenuItem>
      </Menu>
    </>
  );
}
