import CheckIcon from '@mui/icons-material/Check';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import { ListItemIcon, Menu, MenuItem, Tooltip } from '@mui/material';
import { useId, useState } from 'react';

import { PowerIconButton } from '../../../components/PowerIconButton';
import type { DeviceFilesState } from '../use-device-files';

const CONTENT_FILTERS = [
  { value: null, label: 'Усі файли' },
  { value: true, label: 'З контентом' },
  { value: false, label: 'Без контенту' },
];

export function DeviceFileFiltersMenu({
  contentFilter,
  setContentFilter,
}: Pick<DeviceFilesState, 'contentFilter' | 'setContentFilter'>) {
  const menuId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const filterLabel =
    contentFilter === null
      ? 'Фільтри файлів'
      : contentFilter
        ? 'Фільтри файлів: з контентом'
        : 'Фільтри файлів: без контенту';

  return (
    <>
      <Tooltip title={filterLabel}>
        <PowerIconButton
          size="small"
          aria-label={filterLabel}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          aria-controls={anchor !== null ? menuId : undefined}
          color={contentFilter !== null ? 'primary' : 'inherit'}
          onClick={(event) => setAnchor(event.currentTarget)}
        >
          <FilterAltOutlinedIcon fontSize="small" />
        </PowerIconButton>
      </Tooltip>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        MenuListProps={{ 'aria-label': 'Фільтри файлів' }}
      >
        {CONTENT_FILTERS.map(({ value, label }) => (
          <MenuItem
            key={label}
            role="menuitemradio"
            aria-checked={contentFilter === value}
            selected={contentFilter === value}
            onClick={() => {
              setAnchor(null);
              setContentFilter(value);
            }}
          >
            <ListItemIcon>
              <CheckIcon
                fontSize="small"
                className={contentFilter === value ? undefined : 'invisible'}
              />
            </ListItemIcon>
            {label}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
