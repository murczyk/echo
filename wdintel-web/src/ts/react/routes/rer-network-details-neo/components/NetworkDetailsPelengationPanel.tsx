import LocationOnOutlinedIcon from '@mui/icons-material/LocationOnOutlined';
import ClearOutlinedIcon from '@mui/icons-material/ClearOutlined';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import WhatshotOutlinedIcon from '@mui/icons-material/WhatshotOutlined';
import { Box, Button, Checkbox, Divider, FormControlLabel, IconButton, InputAdornment, Popover, Stack, Switch, TextField, Tooltip, Typography } from '@mui/material';
import type { NetworkPoint } from '../../../../../Bindings';
import { DateTimeRangeControl } from '../../../components/DateTimeRangeControl';
import { PowerAlert } from '../../../components/PowerAlert';
import { filterPelengationPoints, getPelengationFrequencies } from './NetworkDetailsPelengationMap.shared';
import { NetworkDetailsEmptyState } from './NetworkDetailsEmptyState';
import { NetworkDetailsPelengationMap } from './NetworkDetailsPelengationMap';
import { useId, useMemo, useState } from 'react';

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
  onReloadPelengPoints: () => void;
  onPelengSinceChange: (value: string) => void;
  onPelengTillChange: (value: string) => void;
  onPelengSearchChange: (value: string) => void;
  onPelengEnabledFreqsChange: (freqs: string[]) => void;
  onPelengShowLabelsChange: (value: boolean) => void;
};

type PelengationHeaderProps = {
  headingId: string;
  visiblePointCountLabel: string;
};

function PelengationHeader({ headingId, visiblePointCountLabel }: PelengationHeaderProps) {
  return (
    <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0, flexWrap: 'wrap' }}>
      <Typography id={headingId} component="h2" variant="h6">
        Пеленгація
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.2 }}>
        {visiblePointCountLabel}
      </Typography>
    </Stack>
  );
}

type PelengationControlsProps = {
  pelengSince: string;
  pelengTill: string;
  pelengSearch: string;
  pelengEnabledFreqs: string[];
  pelengShowLabels: boolean;
  searchText: string;
  allFreqs: string[];
  filterButtonId: string;
  filterPopoverId: string;
  filterAnchorEl: HTMLElement | null;
  popoverFreqs: string[];
  onFilterAnchorChange: (anchorEl: HTMLElement | null) => void;
  onPelengSinceChange: (value: string) => void;
  onPelengTillChange: (value: string) => void;
  onPelengSearchChange: (value: string) => void;
  onPelengEnabledFreqsChange: (freqs: string[]) => void;
  onPelengShowLabelsChange: (value: boolean) => void;
};

function PelengationControls({
  pelengSince,
  pelengTill,
  pelengSearch,
  pelengEnabledFreqs,
  pelengShowLabels,
  searchText,
  allFreqs,
  filterButtonId,
  filterPopoverId,
  filterAnchorEl,
  popoverFreqs,
  onFilterAnchorChange,
  onPelengSinceChange,
  onPelengTillChange,
  onPelengSearchChange,
  onPelengEnabledFreqsChange,
  onPelengShowLabelsChange,
}: PelengationControlsProps) {
  return (
    <>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
        <Box sx={{ width: { xs: '100%', sm: 220 }, minWidth: 0, display: 'flex', alignItems: 'center' }}>
          <TextField
            placeholder="Пошук частот"
            size="small"
            value={pelengSearch}
            onChange={(event) => onPelengSearchChange(event.target.value)}
            sx={{
              width: '100%',
              '& .MuiOutlinedInput-root': {
                height: 40,
                minHeight: 40,
                backgroundColor: 'transparent',
                '& .MuiInputBase-input': {
                  fontSize: 14,
                  lineHeight: '20px',
                  boxSizing: 'border-box',
                  padding: '9px 8px 9px 0 !important',
                },
              },
            }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchOutlinedIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                  </InputAdornment>
                ),
                endAdornment: searchText ? (
                  <InputAdornment position="end">
                    <Tooltip title="Очистити пошук" arrow>
                      <IconButton
                        aria-label="Очистити пошук"
                        size="small"
                        onClick={() => onPelengSearchChange('')}
                        sx={{ p: 0.25, color: 'text.secondary' }}
                      >
                        <ClearOutlinedIcon sx={{ fontSize: 18 }} />
                      </IconButton>
                    </Tooltip>
                  </InputAdornment>
                ) : undefined,
              },
            }}
          />
        </Box>

        <Box sx={{ width: { xs: '100%', sm: 280 }, minWidth: 0, display: 'flex', alignItems: 'center' }}>
          <DateTimeRangeControl
            value={{
              fromDateTimeStr: pelengSince,
              toDateTimeStr: pelengTill,
            }}
            onChange={(value) => {
              onPelengSinceChange(value.fromDateTimeStr);
              onPelengTillChange(value.toDateTimeStr);
            }}
          />
        </Box>

        <FormControlLabel
          control={<Switch checked={pelengShowLabels} onChange={(_, checked) => onPelengShowLabelsChange(checked)} />}
          label="Підписи"
          sx={{ m: 0 }}
        />

        <Button
          id={filterButtonId}
          type="button"
          variant="outlined"
          onClick={(event) => onFilterAnchorChange(event.currentTarget)}
          startIcon={<TuneOutlinedIcon />}
          sx={{ borderRadius: 2, px: 1.6, py: 0.8, minWidth: 0, textTransform: 'none', fontWeight: 700 }}
        >
          Частоти
        </Button>

        <Button
          type="button"
          variant="contained"
          onClick={() => onPelengEnabledFreqsChange(allFreqs)}
          startIcon={<LayersOutlinedIcon />}
          sx={{ borderRadius: 2, px: 1.6, py: 0.8, minWidth: 0, textTransform: 'none', fontWeight: 700 }}
        >
          Усі
        </Button>

        <Button
          type="button"
          variant="outlined"
          onClick={() => onPelengEnabledFreqsChange([])}
          startIcon={<WhatshotOutlinedIcon />}
          sx={{ borderRadius: 2, px: 1.6, py: 0.8, minWidth: 0, textTransform: 'none', fontWeight: 700 }}
        >
          Нічого
        </Button>
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
  onReloadPelengPoints,
  onPelengSinceChange,
  onPelengTillChange,
  onPelengSearchChange,
  onPelengEnabledFreqsChange,
  onPelengShowLabelsChange,
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
  const visiblePointCountLabel = useMemo(() => {
    return `${filteredPoints.length} точок · ${visibleFreqs.length} частот`;
  }, [filteredPoints.length, visibleFreqs.length]);
  const pelengHasVisiblePoints = filteredPoints.length > 0;
  const pelengHasLoadedData = pelengPointsLoaded && !pelengPointsLoading;

  if (pelengPointsError) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%', flex: 1, alignItems: 'center' }}>
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

  if (pelengHasLoadedData && pelengPoints.length === 0) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%', flex: 1 }}>
          <Typography id={headingId} component="h2" variant="h6">
            Пеленгація
          </Typography>
          <NetworkDetailsEmptyState
            icon={<LocationOnOutlinedIcon />}
            title="Немає пеленгації"
            description="Підключіть пости, щоб бачити геопросторові дані"
            minHeight={360}
          />
        </Stack>
      </Box>
    );
  }

  if (pelengHasLoadedData && !pelengHasVisiblePoints) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <Stack spacing={1.5} sx={{ minHeight: 0, minWidth: 0, width: '100%', flex: 1 }}>
          <Stack spacing={1} sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="space-between" sx={{ flexWrap: 'wrap', gap: 1 }}>
              <PelengationHeader headingId={headingId} visiblePointCountLabel={visiblePointCountLabel} />
            </Stack>
            <PelengationControls
              pelengSince={pelengSince}
              pelengTill={pelengTill}
              pelengSearch={pelengSearch}
              pelengEnabledFreqs={pelengEnabledFreqs}
              pelengShowLabels={pelengShowLabels}
              searchText={searchText}
              allFreqs={allFreqs}
              filterButtonId={filterButtonId}
              filterPopoverId={filterPopoverId}
              filterAnchorEl={filterAnchorEl}
              popoverFreqs={popoverFreqs}
              onFilterAnchorChange={setFilterAnchorEl}
              onPelengSinceChange={onPelengSinceChange}
              onPelengTillChange={onPelengTillChange}
              onPelengSearchChange={onPelengSearchChange}
              onPelengEnabledFreqsChange={onPelengEnabledFreqsChange}
              onPelengShowLabelsChange={onPelengShowLabelsChange}
            />
          </Stack>
          <NetworkDetailsEmptyState
            icon={<LocationOnOutlinedIcon />}
            title="Немає видимих пеленгів"
            description="Зніміть фільтр частот або очистьте пошук, щоб показати точки на мапі"
            minHeight={360}
          />
        </Stack>
      </Box>
    );
  }

  return (
    <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
      <Stack spacing={1.5} sx={{ minHeight: 0, minWidth: 0, width: '100%', flex: 1 }}>
        <PelengationControls
          pelengSince={pelengSince}
          pelengTill={pelengTill}
          pelengSearch={pelengSearch}
          pelengEnabledFreqs={pelengEnabledFreqs}
          pelengShowLabels={pelengShowLabels}
          searchText={searchText}
          allFreqs={allFreqs}
          filterButtonId={filterButtonId}
          filterPopoverId={filterPopoverId}
          filterAnchorEl={filterAnchorEl}
          popoverFreqs={popoverFreqs}
          onFilterAnchorChange={setFilterAnchorEl}
          onPelengSinceChange={onPelengSinceChange}
          onPelengTillChange={onPelengTillChange}
          onPelengSearchChange={onPelengSearchChange}
          onPelengEnabledFreqsChange={onPelengEnabledFreqsChange}
          onPelengShowLabelsChange={onPelengShowLabelsChange}
        />

        <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', flex: 1, display: 'flex' }}>
          <NetworkDetailsPelengationMap pelengPoints={filteredPoints} showLabels={pelengShowLabels} />
        </Box>
      </Stack>
    </Box>
  );
}
