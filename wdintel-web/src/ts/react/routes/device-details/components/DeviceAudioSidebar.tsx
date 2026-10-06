import CheckIcon from '@mui/icons-material/Check';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import { ListItemIcon, Menu, MenuItem, Tooltip } from '@mui/material';
import { useState } from 'react';
import { PowerIconButton } from '../../../components/PowerIconButton';
import type { DeviceAudioState } from '../use-device-audio';
import { DeviceAudioList } from './DeviceAudioList';

export function DeviceAudioSidebar({ audio }: { audio: DeviceAudioState }) {
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const filterLabel = audio.unprocessedOnly ? 'Фільтри аудіо: тільки необроблені' : 'Фільтри аудіо';
  return (
    <aside
      aria-labelledby="device-audio-sidebar-title"
      data-testid="device-audio-sidebar"
      aria-busy={audio.loading}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-echo-md border border-echo-border bg-echo-surface"
    >
      <header className="flex h-[58px] shrink-0 items-center justify-between gap-echo-sm border-b border-echo-border px-echo-lg py-echo-sm">
        <h2
          id="device-audio-sidebar-title"
          className="m-0 min-w-0 truncate text-[20px]! font-semibold! text-echo-text"
        >
          Аудіо
        </h2>
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
      </header>
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
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-echo-sm">
        <DeviceAudioList audio={audio} />
      </div>
    </aside>
  );
}
