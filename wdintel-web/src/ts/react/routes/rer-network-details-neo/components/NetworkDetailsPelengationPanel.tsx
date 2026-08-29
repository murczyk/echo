import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import ClearOutlinedIcon from '@mui/icons-material/ClearOutlined';
import LocationOnOutlinedIcon from '@mui/icons-material/LocationOnOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import WhatshotOutlinedIcon from '@mui/icons-material/WhatshotOutlined';
import {
  Box,
  Button,
  Checkbox,
  Divider,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Popover,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { NetworkPoint } from '../../../../../Bindings';
import { APP_DATETIME_INPUT_MIN } from '../../../utils/misc';
import { NetworkDatePickerField } from './NetworkDatePickerField';
import { PowerAlert } from '../../../components/PowerAlert';
import {
  filterPelengationPoints,
  getPelengationFrequencies,
} from './NetworkDetailsPelengationMap.shared';
import { NetworkDetailsEmptyState } from './NetworkDetailsEmptyState';
import { NetworkDetailsLoadingState } from './NetworkDetailsLoadingState';
import { NetworkDetailsPelengationMap } from './NetworkDetailsPelengationMap';
import { BASE_LAYER_IDS, BASE_LAYER_LABELS, type BaseLayerId } from '../../../../maps/base-layers';

type Props = {
  pelengPoints: NetworkPoint[];
  pelengPointsLoaded: boolean;
  pelengPointsLoading: boolean;
  pelengPointsError: string | null;
  pelengSince: string;
  pelengTill: string;
  pelengSearch: string;
  pelengEnabledFreqs: string[];
  pelengShowLabels: boolean;
  pelengBaseLayerId: BaseLayerId;
  pelengHeatmapEnabled: boolean;
  onReloadPelengPoints: () => void;
  onPelengSinceChange: (value: string) => void;
  onPelengTillChange: (value: string) => void;
  onPelengSearchChange: (value: string) => void;
  onPelengEnabledFreqsChange: (freqs: string[]) => void;
  onPelengShowLabelsChange: (value: boolean) => void;
  onPelengBaseLayerIdChange: (value: BaseLayerId) => void;
  onPelengHeatmapEnabledChange: (value: boolean) => void;
};

type PelengationToolbarProps = {
  headingId: string;
  summaryLabel: string;
  pelengSince: string;
  pelengTill: string;
  pelengSearch: string;
  pelengEnabledFreqs: string[];
  pelengShowLabels: boolean;
  pelengBaseLayerId: BaseLayerId;
  pelengHeatmapEnabled: boolean;
  searchText: string;
  allFreqs: string[];
  filterButtonId: string;
  filterPopoverId: string;
  filterAnchorEl: HTMLElement | null;
  popoverFreqs: string[];
  pelengDateMin: Dayjs;
  pelengDateMax: Dayjs;
  pelengSinceMax: Dayjs;
  pelengTillMin: Dayjs;
  onFilterAnchorChange: (anchorEl: HTMLElement | null) => void;
  onPelengSinceChange: (value: string) => void;
  onPelengTillChange: (value: string) => void;
  onPelengSearchChange: (value: string) => void;
  onPelengEnabledFreqsChange: (freqs: string[]) => void;
  onPelengShowLabelsChange: (value: boolean) => void;
  onPelengBaseLayerIdChange: (value: BaseLayerId) => void;
  onPelengHeatmapEnabledChange: (value: boolean) => void;
};

function PelengationToolbar({
  headingId,
  summaryLabel,
  pelengSince,
  pelengTill,
  pelengSearch,
  pelengEnabledFreqs,
  pelengShowLabels,
  pelengBaseLayerId,
  pelengHeatmapEnabled,
  searchText,
  allFreqs,
  filterButtonId,
  filterPopoverId,
  filterAnchorEl,
  popoverFreqs,
  pelengDateMin,
  pelengDateMax,
  pelengSinceMax,
  pelengTillMin,
  onFilterAnchorChange,
  onPelengSinceChange,
  onPelengTillChange,
  onPelengSearchChange,
  onPelengEnabledFreqsChange,
  onPelengShowLabelsChange,
  onPelengBaseLayerIdChange,
  onPelengHeatmapEnabledChange,
}: PelengationToolbarProps) {
  return (
    <>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={2}
        useFlexGap
        sx={{ flexWrap: 'wrap' }}
      >
        <Typography id={headingId} component="h2" variant="h6">
          Пеленгація
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'right' }}>
          {summaryLabel}
        </Typography>
      </Stack>

      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={2}
        useFlexGap
        sx={{ flexWrap: 'wrap' }}
      >
        <Stack
          direction="row"
          alignItems="center"
          spacing={1.5}
          useFlexGap
          sx={{ flexWrap: 'wrap', minWidth: 0, flex: 1 }}
        >
          <TextField
            size="small"
            value={pelengSearch}
            onChange={(event) => onPelengSearchChange(event.target.value)}
            placeholder="Пошук"
            sx={{
              width: { xs: 180, sm: 220 },
              flexShrink: 0,
              '& .MuiOutlinedInput-root': {
                height: 40,
                minHeight: 40,
                backgroundColor: 'transparent',
                '& .MuiInputBase-input': {
                  fontSize: '0.875rem',
                  lineHeight: '20px',
                  boxSizing: 'border-box',
                  padding: '9px 8px 9px 0 !important',
                },
              },
            }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchOutlinedIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment:
                searchText !== '' ? (
                  <InputAdornment position="end">
                    <Tooltip title="Очистити пошук">
                      <IconButton
                        aria-label="Очистити пошук"
                        size="small"
                        onClick={() => onPelengSearchChange('')}
                        sx={{ p: 0.25 }}
                      >
                        <ClearOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </InputAdornment>
                ) : undefined,
            }}
          />
          <NetworkDatePickerField
            label="Від"
            value={pelengSince}
            onChange={onPelengSinceChange}
            minDate={pelengDateMin}
            maxDate={pelengSinceMax}
            allowEmpty={false}
            width={148}
          />
          <NetworkDatePickerField
            label="До"
            value={pelengTill}
            onChange={onPelengTillChange}
            minDate={pelengTillMin}
            maxDate={pelengDateMax}
            allowEmpty={false}
            width={148}
          />
          <Stack direction="row" alignItems="center" spacing={2} sx={{ flexShrink: 0 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={pelengShowLabels}
                  onChange={(_, checked) => onPelengShowLabelsChange(checked)}
                />
              }
              label="Підписи"
              sx={{ m: 0, flexShrink: 0 }}
            />
            <Button
              id={filterButtonId}
              type="button"
              variant="outlined"
              onClick={(event) => onFilterAnchorChange(event.currentTarget)}
              startIcon={<TuneOutlinedIcon />}
              sx={{
                borderRadius: 2,
                px: 1.6,
                py: 0.8,
                minWidth: 0,
                height: 40,
                textTransform: 'none',
                fontWeight: 700,
              }}
            >
              Частоти
            </Button>
          </Stack>
        </Stack>

        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: 'wrap', flexShrink: 0 }}
        >
          {BASE_LAYER_IDS.map((baseLayerId) => (
            <Button
              key={baseLayerId}
              type="button"
              variant={pelengBaseLayerId === baseLayerId ? 'contained' : 'outlined'}
              onClick={() => onPelengBaseLayerIdChange(baseLayerId)}
              startIcon={<LayersOutlinedIcon />}
            >
              {BASE_LAYER_LABELS[baseLayerId]}
            </Button>
          ))}
          <Button
            type="button"
            variant={pelengHeatmapEnabled ? 'contained' : 'outlined'}
            onClick={() => onPelengHeatmapEnabledChange(!pelengHeatmapEnabled)}
            startIcon={<WhatshotOutlinedIcon />}
            sx={(theme) => ({
              borderRadius: 2,
              px: 1.4,
              py: 0.7,
              minWidth: 0,
              height: 40,
              textTransform: 'none',
              fontWeight: 700,
              backgroundColor: pelengHeatmapEnabled ? theme.palette.primary.main : 'transparent',
              color: pelengHeatmapEnabled
                ? theme.palette.primary.contrastText
                : theme.palette.text.secondary,
              borderColor: pelengHeatmapEnabled
                ? theme.palette.primary.main
                : theme.palette.divider,
              '&:hover': {
                backgroundColor: pelengHeatmapEnabled
                  ? theme.palette.primary.dark
                  : theme.palette.action.hover,
                borderColor: pelengHeatmapEnabled
                  ? theme.palette.primary.dark
                  : theme.palette.text.primary,
              },
            })}
          >
            Теплова карта
          </Button>
        </Stack>
      </Stack>

      <Popover
        id={filterPopoverId}
        open={filterAnchorEl !== null}
        anchorEl={filterAnchorEl}
        onClose={() => onFilterAnchorChange(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: {
              borderRadius: 2,
              overflow: 'hidden',
              width: 320,
              boxShadow: 6,
            },
          },
        }}
      >
        <Box sx={{ p: 2 }}>
          <Stack spacing={1.5}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                Частоти
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {pelengEnabledFreqs.length}/{allFreqs.length}
              </Typography>
            </Stack>
            <Divider />
            <Stack spacing={0.75} sx={{ maxHeight: 320, overflowY: 'auto' }}>
              {popoverFreqs.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  Немає частот
                </Typography>
              ) : (
                popoverFreqs.map((freq) => {
                  const checked = pelengEnabledFreqs.includes(freq);
                  return (
                    <FormControlLabel
                      key={freq}
                      control={
                        <Checkbox
                          checked={checked}
                          onChange={(_, nextChecked) => {
                            const nextFreqs = nextChecked
                              ? [...new Set([...pelengEnabledFreqs, freq])]
                              : pelengEnabledFreqs.filter((item) => item !== freq);
                            onPelengEnabledFreqsChange(nextFreqs);
                          }}
                        />
                      }
                      label={<span>{freq}</span>}
                      sx={{ m: 0 }}
                    />
                  );
                })
              )}
            </Stack>
          </Stack>
        </Box>
      </Popover>
    </>
  );
}

function PelengationShell({ children, toolbar }: { children: ReactNode; toolbar: ReactNode }) {
  return (
    <Box
      sx={{
        minHeight: 0,
        minWidth: 0,
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
      }}
    >
      <Stack spacing={1.5} sx={{ minHeight: 0, minWidth: 0, width: '100%', flex: 1 }}>
        {toolbar}
        <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', flex: 1, display: 'flex' }}>
          {children}
        </Box>
      </Stack>
    </Box>
  );
}

export function NetworkDetailsPelengationPanel({
  pelengPoints,
  pelengPointsLoaded,
  pelengPointsLoading,
  pelengPointsError,
  pelengSince,
  pelengTill,
  pelengSearch,
  pelengEnabledFreqs,
  pelengShowLabels,
  pelengBaseLayerId,
  pelengHeatmapEnabled,
  onReloadPelengPoints,
  onPelengSinceChange,
  onPelengTillChange,
  onPelengSearchChange,
  onPelengEnabledFreqsChange,
  onPelengShowLabelsChange,
  onPelengBaseLayerIdChange,
  onPelengHeatmapEnabledChange,
}: Props) {
  const headingId = useId().replace(/:/g, '-');
  const filterButtonId = `${headingId}-freqs`;
  const filterPopoverId = `${filterButtonId}-popover`;
  const [filterAnchorEl, setFilterAnchorEl] = useState<HTMLElement | null>(null);
  const filteredPoints = useMemo(
    () => filterPelengationPoints(pelengPoints, pelengSearch, pelengEnabledFreqs),
    [pelengEnabledFreqs, pelengPoints, pelengSearch],
  );
  const allFreqs = useMemo(() => getPelengationFrequencies(pelengPoints), [pelengPoints]);
  const searchText = pelengSearch.trim();
  const popoverFreqs = useMemo(() => {
    const normalizedSearch = searchText.toLocaleUpperCase('uk-UA');
    if (normalizedSearch === '') return allFreqs;
    return allFreqs.filter((freq) => freq.toLocaleUpperCase('uk-UA').includes(normalizedSearch));
  }, [allFreqs, searchText]);
  const visibleFreqs = useMemo(() => getPelengationFrequencies(filteredPoints), [filteredPoints]);
  const summaryLabel = useMemo(
    () => `${filteredPoints.length} точок · ${visibleFreqs.length} частот`,
    [filteredPoints.length, visibleFreqs.length],
  );
  const pelengHasVisiblePoints = filteredPoints.length > 0;
  const pelengHasLoadedData = pelengPointsLoaded && !pelengPointsLoading;
  const pelengDateMin = useMemo(() => dayjs(APP_DATETIME_INPUT_MIN).startOf('day'), []);
  const pelengDateMax = useMemo(() => dayjs().startOf('day'), []);
  const pelengSinceMax = useMemo(() => {
    const parsed = dayjs(pelengTill);
    return parsed.isValid() ? parsed.startOf('day') : pelengDateMax;
  }, [pelengDateMax, pelengTill]);
  const pelengTillMin = useMemo(() => {
    const parsed = dayjs(pelengSince);
    return parsed.isValid() ? parsed.startOf('day') : pelengDateMin;
  }, [pelengDateMin, pelengSince]);

  if (pelengPointsError) {
    return (
      <Box
        sx={{
          minHeight: 0,
          minWidth: 0,
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
        }}
      >
        <Stack
          spacing={2}
          sx={{ minHeight: 0, minWidth: 0, width: '100%', flex: 1, alignItems: 'center' }}
        >
          <Typography id={headingId} component="h2" variant="h6">
            Пеленгація
          </Typography>
          <PowerAlert severity="error" autoHideDuration={null} sx={{ width: '100%' }}>
            {pelengPointsError}
          </PowerAlert>
          <Button variant="outlined" onClick={onReloadPelengPoints}>
            Спробувати ще раз
          </Button>
        </Stack>
      </Box>
    );
  }

  const toolbar = (
    <PelengationToolbar
      headingId={headingId}
      summaryLabel={summaryLabel}
      pelengSince={pelengSince}
      pelengTill={pelengTill}
      pelengSearch={pelengSearch}
      pelengEnabledFreqs={pelengEnabledFreqs}
      pelengShowLabels={pelengShowLabels}
      pelengBaseLayerId={pelengBaseLayerId}
      pelengHeatmapEnabled={pelengHeatmapEnabled}
      searchText={searchText}
      allFreqs={allFreqs}
      filterButtonId={filterButtonId}
      filterPopoverId={filterPopoverId}
      filterAnchorEl={filterAnchorEl}
      popoverFreqs={popoverFreqs}
      pelengDateMin={pelengDateMin}
      pelengDateMax={pelengDateMax}
      pelengSinceMax={pelengSinceMax}
      pelengTillMin={pelengTillMin}
      onFilterAnchorChange={setFilterAnchorEl}
      onPelengSinceChange={onPelengSinceChange}
      onPelengTillChange={onPelengTillChange}
      onPelengSearchChange={onPelengSearchChange}
      onPelengEnabledFreqsChange={onPelengEnabledFreqsChange}
      onPelengShowLabelsChange={onPelengShowLabelsChange}
      onPelengBaseLayerIdChange={onPelengBaseLayerIdChange}
      onPelengHeatmapEnabledChange={onPelengHeatmapEnabledChange}
    />
  );

  if (!pelengHasLoadedData) {
    return (
      <PelengationShell toolbar={toolbar}>
        <NetworkDetailsLoadingState message="Завантажуємо пеленги…" minHeight={360} />
      </PelengationShell>
    );
  }

  if (pelengPoints.length === 0) {
    return (
      <PelengationShell toolbar={toolbar}>
        <NetworkDetailsEmptyState
          icon={<LocationOnOutlinedIcon />}
          title="Немає пеленгації"
          description="Підключіть пости, щоб бачити геопросторові дані"
          minHeight={360}
        />
      </PelengationShell>
    );
  }

  if (!pelengHasVisiblePoints) {
    return (
      <PelengationShell toolbar={toolbar}>
        <NetworkDetailsEmptyState
          icon={<LocationOnOutlinedIcon />}
          title="Немає видимих пеленгів"
          description="Зніміть фільтр частот або очистьте пошук, щоб показати точки на мапі"
          minHeight={360}
        />
      </PelengationShell>
    );
  }

  return (
    <PelengationShell toolbar={toolbar}>
      <NetworkDetailsPelengationMap
        pelengPoints={filteredPoints}
        showLabels={pelengShowLabels}
        baseLayerId={pelengBaseLayerId}
        heatmapEnabled={pelengHeatmapEnabled}
      />
    </PelengationShell>
  );
}
