import { Box, Checkbox, FormControlLabel, Popover, Stack, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import type { NetworkCallsignRelationFreqView } from '../network-relations';
import { NETWORK_RELATIONS_FULLSCREEN_Z_INDEX, getNetworkRelationsGraphTheme } from './network-relations-graph-theme';

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

  return (
    <Popover
      id={popoverId}
      open={anchorEl !== null}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{
        root: {
          style: {
            zIndex: isFullscreen ? NETWORK_RELATIONS_FULLSCREEN_Z_INDEX + 1 : undefined,
          },
        },
        paper: {
          sx: {
            borderRadius: 2,
            overflow: 'hidden',
            bgcolor: graphTheme.overlayBg,
            border: `1px solid ${graphTheme.overlayBorder}`,
            boxShadow: graphTheme.overlayShadow,
          },
        },
      }}
    >
      <Box data-testid="graph-filters-popover" sx={{ width: 320, p: 2, color: graphTheme.overlayText, position: 'relative' }}>
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
        </Stack>
      </Box>
    </Popover>
  );
}
