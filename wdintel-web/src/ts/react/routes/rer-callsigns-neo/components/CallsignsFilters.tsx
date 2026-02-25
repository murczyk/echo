import DownloadIcon from '@mui/icons-material/Download';
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff';
import RefreshIcon from '@mui/icons-material/Refresh';
import ViewSidebarIcon from '@mui/icons-material/ViewSidebar';
import {
  Button,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
} from '@mui/material';

import type { DevelopingFilter } from '../../../../../Bindings';
import type { CallsignsFilterState, DownloadKind } from '../types';

type Props = {
  filters: CallsignsFilterState;
  disabled?: boolean;
  sidebarOpen: boolean;
  canExport: boolean;
  downloadInProgress: DownloadKind | null;
  onFiltersChange: (updater: (prev: CallsignsFilterState) => CallsignsFilterState) => void;
  onRefresh: () => void;
  onClearFilters: () => void;
  onToggleSidebar: () => void;
  onDownloadCsv: () => void;
  onDownloadXlsx: () => void;
};

const developingOptions: Array<{ value: DevelopingFilter; label: string }> = [
  { value: 'OnlyNonDeveloping', label: 'Відомі' },
  { value: 'OnlyDeveloping', label: 'В дорозвідці' },
  { value: 'All', label: 'Усі' },
];

export function CallsignsFilters({
  filters,
  disabled = false,
  sidebarOpen,
  canExport,
  downloadInProgress,
  onFiltersChange,
  onRefresh,
  onClearFilters,
  onToggleSidebar,
  onDownloadCsv,
  onDownloadXlsx,
}: Props) {
  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5} alignItems={{ lg: 'center' }}>
        <TextField
          label="Позивний"
          value={filters.filterCallsign}
          onChange={(event) => onFiltersChange((prev) => ({ ...prev, filterCallsign: event.target.value }))}
          size="small"
          disabled={disabled}
          sx={{ minWidth: 200 }}
        />
        <TextField
          label="Посада"
          value={filters.filterPosition}
          onChange={(event) => onFiltersChange((prev) => ({ ...prev, filterPosition: event.target.value }))}
          size="small"
          disabled={disabled}
          sx={{ minWidth: 180 }}
        />
        <TextField
          label="Коментар"
          value={filters.filterComment}
          onChange={(event) => onFiltersChange((prev) => ({ ...prev, filterComment: event.target.value }))}
          size="small"
          disabled={disabled}
          sx={{ minWidth: 180 }}
        />
        <TextField
          label="Підрозділ"
          value={filters.filterUnit}
          onChange={(event) => onFiltersChange((prev) => ({ ...prev, filterUnit: event.target.value }))}
          size="small"
          disabled={disabled}
          sx={{ minWidth: 180 }}
        />
        <FormControl size="small" sx={{ minWidth: 200 }} disabled={disabled}>
          <InputLabel id="callsigns-developing-filter-label">Статус</InputLabel>
          <Select
            labelId="callsigns-developing-filter-label"
            label="Статус"
            value={filters.filterDeveloping}
            onChange={(event) =>
              onFiltersChange((prev) => ({
                ...prev,
                filterDeveloping: event.target.value as DevelopingFilter,
              }))
            }
          >
            {developingOptions.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>

      <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5} alignItems={{ lg: 'center' }} flexWrap="wrap" useFlexGap>
        <FormControlLabel
          control={
            <Switch
              checked={!filters.isIgnoringDateFilter}
              onChange={(event) => onFiltersChange((prev) => ({ ...prev, isIgnoringDateFilter: !event.target.checked }))}
              disabled={disabled}
            />
          }
          label="Фільтр за датою"
        />

        {!filters.isIgnoringDateFilter ? (
          <>
            <TextField
              label="Від"
              type="datetime-local"
              size="small"
              value={filters.fromDateTimeLocal}
              onChange={(event) => onFiltersChange((prev) => ({ ...prev, fromDateTimeLocal: event.target.value }))}
              disabled={disabled}
              InputLabelProps={{ shrink: true }}
            />
            <TextField
              label="До"
              type="datetime-local"
              size="small"
              value={filters.toDateTimeLocal}
              onChange={(event) => onFiltersChange((prev) => ({ ...prev, toDateTimeLocal: event.target.value }))}
              disabled={disabled}
              InputLabelProps={{ shrink: true }}
            />
          </>
        ) : null}

        <Button startIcon={<RefreshIcon />} onClick={onRefresh} disabled={disabled} variant="outlined">
          Оновити
        </Button>
        <Button startIcon={<FilterAltOffIcon />} onClick={onClearFilters} disabled={disabled} variant="outlined">
          Скинути фільтри
        </Button>
        <Button startIcon={<ViewSidebarIcon />} onClick={onToggleSidebar} disabled={disabled} variant="outlined">
          {sidebarOpen ? 'Сховати підрозділи' : 'Показати підрозділи'}
        </Button>

        {canExport ? (
          <>
            <Button
              startIcon={<DownloadIcon />}
              onClick={onDownloadCsv}
              disabled={disabled || downloadInProgress !== null}
              variant="outlined"
            >
              {downloadInProgress === 'csv' ? 'Завантаження CSV…' : 'Завантажити CSV'}
            </Button>
            <Button
              startIcon={<DownloadIcon />}
              onClick={onDownloadXlsx}
              disabled={disabled || downloadInProgress !== null}
              variant="outlined"
            >
              {downloadInProgress === 'xlsx' ? 'Завантаження XLSX…' : 'Завантажити XLSX'}
            </Button>
          </>
        ) : null}
      </Stack>
    </Stack>
  );
}
