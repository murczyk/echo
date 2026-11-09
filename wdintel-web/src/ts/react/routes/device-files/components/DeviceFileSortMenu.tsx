import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import SortIcon from '@mui/icons-material/Sort';
import { Badge, Menu, MenuItem, Tooltip } from '@mui/material';
import { useId, useState } from 'react';
import type { DeviceFileSortBy } from '../../../../../Bindings';
import { PowerIconButton } from '../../../components/PowerIconButton';
import type { DeviceFilesState } from '../use-device-files';

const fields: { by: DeviceFileSortBy; label: string }[] = [
  { by: 'name', label: 'Назва' },
  { by: 'size', label: 'Розмір' },
  { by: 'uploaded_at', label: 'Дата завантаження' },
  { by: 'created_at', label: 'Дата створення' },
  { by: 'modified_at', label: 'Дата зміни' },
];

export function DeviceFileSortMenu({ files }: { files: DeviceFilesState }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  const ascending = files.sorting.direction === 'ascending';
  const direction = ascending ? 'За зростанням' : 'За спаданням';
  const label = fields.find((field) => field.by === files.sorting.by)!.label;
  return (
    <>
      <Tooltip title={`${label}: ${direction.toLowerCase()}`}>
        <PowerIconButton
          size="small"
          aria-label="Сортування файлів"
          aria-description={`${label}: ${direction.toLowerCase()}`}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          aria-controls={anchor ? menuId : undefined}
          color={anchor !== null ? 'primary' : 'inherit'}
          onClick={(event) => setAnchor(event.currentTarget)}
        >
          <Badge
            color="error"
            variant="dot"
            overlap="circular"
            invisible={files.sorting.by === 'name' && ascending}
          >
            <SortIcon />
          </Badge>
        </PowerIconButton>
      </Tooltip>
      <Menu
        open={anchor !== null}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        elevation={3}
        MenuListProps={{ id: menuId, 'aria-label': 'Сортування файлів' }}
      >
        {fields.map((field) => {
          const selected = field.by === files.sorting.by;
          return (
            <MenuItem
              key={field.by}
              role="menuitemradio"
              aria-checked={selected}
              aria-description={selected ? direction : 'За зростанням'}
              selected={selected}
              onClick={() => {
                files.selectSort(field.by);
                setAnchor(null);
              }}
              className="gap-echo-lg!"
            >
              <span className="flex-1">{field.label}</span>
              {selected &&
                (ascending ? (
                  <ArrowUpwardIcon fontSize="small" aria-hidden />
                ) : (
                  <ArrowDownwardIcon fontSize="small" aria-hidden />
                ))}
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
}
