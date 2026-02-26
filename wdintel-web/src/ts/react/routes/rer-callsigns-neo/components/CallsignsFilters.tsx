import DownloadIcon from '@mui/icons-material/Download';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import CloseIcon from '@mui/icons-material/Close';
import {
  Button,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  InputAdornment,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
} from '@mui/material';

import type { DevelopingFilter } from '../../../../../Bindings';
import type { CallsignsFilterState, DownloadKind } from '../types';

type Props = {
  filters: CallsignsFilterState;
  disabled?: boolean;
  sidebarOpen: boolean;
  selectedCount: number;
  canExport: boolean;
  downloadInProgress: DownloadKind | null;
  onFiltersChange: (updater: (prev: CallsignsFilterState) => CallsignsFilterState) => void;
  onClearFilters: () => void;
  onClearSelectedCallsigns: () => void;
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
  selectedCount,
  canExport,
  downloadInProgress,
  onFiltersChange,
  onClearFilters,
  onClearSelectedCallsigns,
  onToggleSidebar,
  onDownloadCsv,
  onDownloadXlsx,
}: Props) {
  const hasActiveFilters =
    filters.filterCallsign.trim() !== '' ||
    filters.filterPosition.trim() !== '' ||
    filters.filterComment.trim() !== '' ||
    filters.filterUnit.trim() !== '' ||
    filters.filterDeveloping !== 'OnlyNonDeveloping' ||
    !filters.isIgnoringDateFilter;

  function renderClearAdornment(value: string, onClear: () => void, title: string) {
    if (value === '') return undefined;

    return (
      <InputAdornment position="end">
        <Tooltip title={title}>
          <span>
            <IconButton
              size="small"
              edge="end"
              aria-label={title}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onClear}
              disabled={disabled}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </InputAdornment>
    );
  }

  return (
    <Stack spacing={2}>
      <Stack
        direction={{ xs: 'column', lg: 'row' }}
        spacing={1.5}
        alignItems={{ lg: 'center' }}
        justifyContent="space-between"
        useFlexGap
        flexWrap="wrap"
      >
        <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5} alignItems={{ lg: 'center' }} useFlexGap flexWrap="wrap" sx={{ flex: '1 1 auto', minWidth: 0 }}>
          <TextField
            label="Позивний"
            value={filters.filterCallsign}
            onChange={(event) => onFiltersChange((prev) => ({ ...prev, filterCallsign: event.target.value }))}
            size="small"
            disabled={disabled}
            sx={{ minWidth: 200 }}
            InputProps={{
              endAdornment: renderClearAdornment(
                filters.filterCallsign,
                () => onFiltersChange((prev) => ({ ...prev, filterCallsign: '' })),
                'Очистити фільтр позивного',
              ),
            }}
          />
          <TextField
            label="Посада"
            value={filters.filterPosition}
            onChange={(event) => onFiltersChange((prev) => ({ ...prev, filterPosition: event.target.value }))}
            size="small"
            disabled={disabled}
            sx={{ minWidth: 180 }}
            InputProps={{
              endAdornment: renderClearAdornment(
                filters.filterPosition,
                () => onFiltersChange((prev) => ({ ...prev, filterPosition: '' })),
                'Очистити фільтр посади',
              ),
            }}
          />
          <TextField
            label="Коментар"
            value={filters.filterComment}
            onChange={(event) => onFiltersChange((prev) => ({ ...prev, filterComment: event.target.value }))}
            size="small"
            disabled={disabled}
            sx={{ minWidth: 180 }}
            InputProps={{
              endAdornment: renderClearAdornment(
                filters.filterComment,
                () => onFiltersChange((prev) => ({ ...prev, filterComment: '' })),
                'Очистити фільтр коментаря',
              ),
            }}
          />
          <TextField
            label="Підрозділ"
            value={filters.filterUnit}
            onChange={(event) => onFiltersChange((prev) => ({ ...prev, filterUnit: event.target.value }))}
            size="small"
            disabled={disabled}
            sx={{ minWidth: 180 }}
            InputProps={{
              endAdornment: renderClearAdornment(
                filters.filterUnit,
                () => onFiltersChange((prev) => ({ ...prev, filterUnit: '' })),
                'Очистити фільтр підрозділу',
              ),
            }}
          />
          <FormControl size="small" sx={{ minWidth: 200, mr: { lg: 0.5 } }} disabled={disabled}>
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
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <TextField
                label="До"
                type="datetime-local"
                size="small"
                value={filters.toDateTimeLocal}
                onChange={(event) => onFiltersChange((prev) => ({ ...prev, toDateTimeLocal: event.target.value }))}
                disabled={disabled}
                slotProps={{ inputLabel: { shrink: true } }}
              />
            </>
          ) : null}
        </Stack>

        {hasActiveFilters || selectedCount > 0 ? (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ ml: { lg: 'auto' } }} useFlexGap flexWrap="wrap">
            {hasActiveFilters ? (
              <Button size="small" onClick={onClearFilters} disabled={disabled} sx={{ px: 1.5 }}>
                Очистити фільтри
              </Button>
            ) : null}
            {selectedCount > 0 ? (
              <Button size="small" onClick={onClearSelectedCallsigns} disabled={disabled} sx={{ px: 1.5 }}>
                Очистити вибір
              </Button>
            ) : null}
          </Stack>
        ) : null}
      </Stack>

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        alignItems={{ sm: 'center' }}
        justifyContent="space-between"
        flexWrap="wrap"
        useFlexGap
      >
        <Button
          startIcon={sidebarOpen ? <ChevronLeftIcon /> : <ChevronRightIcon />}
          onClick={onToggleSidebar}
          disabled={disabled}
          variant="outlined"
          aria-pressed={sidebarOpen}
          sx={{ whiteSpace: 'nowrap' }}
        >
          {sidebarOpen ? 'Сховати підрозділи' : 'Показати підрозділи'}
        </Button>

        {canExport ? (
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            alignItems={{ sm: 'center' }}
            justifyContent="flex-end"
            sx={{ ml: { sm: 'auto' } }}
            flexWrap="wrap"
            useFlexGap
          >
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
          </Stack>
        ) : null}
      </Stack>
    </Stack>
  );
}
