import { Box, Checkbox, Divider, FormControlLabel, Popover, Slider, Stack, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';

import type { NetworkCallsignRelationFreqView } from '../network-relations';

type Props = {
  anchorEl: HTMLElement | null;
  popoverId: string;
  legendFreqs: NetworkCallsignRelationFreqView[];
  enabledFreqs: string[];
  minIntensity: number;
  intensitySliderMax: number;
  onClose: () => void;
  onEnabledFreqToggle: (freq: string, checked: boolean) => void;
  onMinIntensityChange: (value: number) => void;
};

export function NetworkCallsignRelationsGraphFilters({
  anchorEl,
  popoverId,
  legendFreqs,
  enabledFreqs,
  minIntensity,
  intensitySliderMax,
  onClose,
  onEnabledFreqToggle,
  onMinIntensityChange,
}: Props) {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';
  const overlayBg = isDarkMode ? 'rgba(12,12,12,0.94)' : alpha(theme.palette.background.paper, 0.98);
  const overlayBorder = alpha(theme.palette.divider, isDarkMode ? 0.5 : 0.85);
  const overlayShadow = isDarkMode ? '0 12px 28px rgba(0,0,0,0.35)' : '0 12px 24px rgba(0,0,0,0.10)';
  const overlayText = theme.palette.text.primary;
  const overlayTextSecondary = alpha(theme.palette.text.primary, isDarkMode ? 0.72 : 0.62);

  return (
    <Popover
      id={popoverId}
      open={anchorEl !== null}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{
        paper: {
          sx: {
            borderRadius: 2,
            overflow: 'hidden',
            bgcolor: overlayBg,
            border: `1px solid ${overlayBorder}`,
            boxShadow: overlayShadow,
          },
        },
      }}
    >
      <Box sx={{ width: 320, p: 2, color: overlayText, position: 'relative' }}>
        <Stack spacing={1.5}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            Налаштування
          </Typography>
          <Stack spacing={0.75}>
            {legendFreqs.map((freq) => {
              const enabled = enabledFreqs.includes(freq.freq);
              return (
                <FormControlLabel
                  key={freq.freq}
                  control={<Checkbox checked={enabled} onChange={(_, checked) => onEnabledFreqToggle(freq.freq, checked)} />}
                  label={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Box sx={{ width: 18, height: 3, borderRadius: 999, bgcolor: freq.color }} />
                      <span>{freq.freq}</span>
                    </Stack>
                  }
                  sx={{ m: 0 }}
                />
              );
            })}
          </Stack>
          <Divider />
          <Stack spacing={0.5}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                Інтенсивність
              </Typography>
              <Typography variant="caption" sx={{ color: overlayTextSecondary }}>
                {minIntensity}
              </Typography>
            </Stack>
            <Slider
              value={minIntensity}
              min={1}
              max={intensitySliderMax}
              step={1}
              track="normal"
              onChange={(_, value) => onMinIntensityChange(Array.isArray(value) ? value[0] ?? minIntensity : value)}
              sx={{
                '& .MuiSlider-track': {
                  border: 'none',
                },
                '& .MuiSlider-rail': {
                  opacity: 0.38,
                },
                '& .MuiSlider-mark': {
                  display: 'none',
                },
              }}
            />
          </Stack>
        </Stack>
      </Box>
    </Popover>
  );
}
