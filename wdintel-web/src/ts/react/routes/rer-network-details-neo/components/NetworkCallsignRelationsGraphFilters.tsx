import ClearOutlinedIcon from '@mui/icons-material/ClearOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import {
  Box,
  Checkbox,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Popover,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { useEffect, useMemo, useState } from 'react';

import type { NetworkCallsignRelationFreqView } from '../network-relations';
import {
  NETWORK_RELATIONS_FULLSCREEN_Z_INDEX,
  getNetworkRelationsGraphTheme,
} from './network-relations-graph-theme';

type Props = {
  anchorEl: HTMLElement | null;
  popoverId: string;
  legendFreqs: NetworkCallsignRelationFreqView[];
  enabledFreqs: string[];
  isFullscreen: boolean;
  onClose: () => void;
  onEnabledFreqToggle: (freq: string, checked: boolean) => void;
};

export function NetworkCallsignRelationsGraphFilters({
  anchorEl,
  popoverId,
  legendFreqs,
  enabledFreqs,
  isFullscreen,
  onClose,
  onEnabledFreqToggle,
}: Props) {
  const theme = useTheme();
  const graphTheme = getNetworkRelationsGraphTheme(theme);
  const [frequencySearch, setFrequencySearch] = useState('');
  const visibleFreqs = useMemo(() => {
    const query = frequencySearch.trim().toLocaleLowerCase();
    if (query === '') return legendFreqs;
    return legendFreqs.filter((freq) => freq.freq.toLocaleLowerCase().includes(query));
  }, [frequencySearch, legendFreqs]);

  useEffect(() => {
    if (anchorEl === null) setFrequencySearch('');
  }, [anchorEl]);

  return (
    <Popover
      id={popoverId}
      data-testid="graph-filters-popover-root"
      open={anchorEl !== null}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      sx={{ zIndex: isFullscreen ? NETWORK_RELATIONS_FULLSCREEN_Z_INDEX + 1 : undefined }}
      slotProps={{
        paper: {
          style: {
            zIndex: isFullscreen ? NETWORK_RELATIONS_FULLSCREEN_Z_INDEX + 1 : undefined,
          },
          sx: {
            borderRadius: 1,
            overflow: 'hidden',
            bgcolor: alpha(
              theme.palette.background.paper,
              theme.palette.mode === 'dark' ? 0.86 : 0.92,
            ),
            backgroundImage: 'none',
            backdropFilter: 'blur(6px)',
            border: `1px solid ${alpha(
              theme.palette.text.primary,
              theme.palette.mode === 'dark' ? 0.14 : 0.12,
            )}`,
            boxShadow:
              theme.palette.mode === 'dark'
                ? '0 4px 12px rgba(0,0,0,0.18)'
                : '0 4px 12px rgba(0,0,0,0.06)',
          },
        },
      }}
    >
      <Box
        data-testid="graph-filters-popover"
        data-zindex={isFullscreen ? NETWORK_RELATIONS_FULLSCREEN_Z_INDEX + 1 : undefined}
        style={{ zIndex: isFullscreen ? NETWORK_RELATIONS_FULLSCREEN_Z_INDEX + 1 : undefined }}
        sx={{ width: 230, p: 1.25, color: graphTheme.overlayText, position: 'relative' }}
      >
        <Stack spacing={1}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            Налаштування
          </Typography>
          <TextField
            size="small"
            value={frequencySearch}
            onChange={(event) => setFrequencySearch(event.target.value)}
            placeholder="Пошук частоти"
            fullWidth
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchOutlinedIcon sx={{ fontSize: 17 }} />
                </InputAdornment>
              ),
              endAdornment:
                frequencySearch !== '' ? (
                  <InputAdornment position="end">
                    <IconButton
                      aria-label="Очистити пошук частот"
                      size="small"
                      onClick={() => setFrequencySearch('')}
                      sx={{ p: 0.25 }}
                    >
                      <ClearOutlinedIcon sx={{ fontSize: 17 }} />
                    </IconButton>
                  </InputAdornment>
                ) : undefined,
            }}
            sx={{
              '& .MuiOutlinedInput-root': { height: 34 },
              '& .MuiInputBase-input': { py: 0.5, fontSize: '0.8125rem' },
            }}
          />
          <Stack sx={{ maxHeight: 170, overflowY: 'auto' }}>
            {visibleFreqs.map((freq) => {
              const enabled = enabledFreqs.includes(freq.freq);
              const disableToggle = enabled && enabledFreqs.length === 1;
              return (
                <Tooltip
                  key={freq.freq}
                  title={disableToggle ? 'Має бути вибрана хоча б одна частота' : undefined}
                  disableHoverListener={!disableToggle}
                  disableFocusListener={!disableToggle}
                  disableTouchListener={!disableToggle}
                >
                  <Box component="span" sx={{ display: 'block' }}>
                    <FormControlLabel
                      control={
                        <Checkbox
                          size="small"
                          checked={enabled}
                          disabled={disableToggle}
                          onChange={(_, checked) => onEnabledFreqToggle(freq.freq, checked)}
                          sx={{ p: 0.75 }}
                        />
                      }
                      label={
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Box
                            sx={{ width: 14, height: 3, borderRadius: 999, bgcolor: freq.color }}
                          />
                          <span>{freq.freq}</span>
                        </Stack>
                      }
                      sx={{
                        m: 0,
                        minHeight: 34,
                        '& .MuiFormControlLabel-label': { fontSize: '0.75rem' },
                      }}
                    />
                  </Box>
                </Tooltip>
              );
            })}
            {visibleFreqs.length === 0 ? (
              <Typography
                variant="caption"
                sx={{ py: 1.25, color: graphTheme.overlayTextSecondary }}
              >
                Частот не знайдено
              </Typography>
            ) : null}
          </Stack>
        </Stack>
      </Box>
    </Popover>
  );
}
