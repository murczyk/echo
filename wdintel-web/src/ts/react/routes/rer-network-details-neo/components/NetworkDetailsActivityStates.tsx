import { Box, Button, CircularProgress, Paper, Skeleton, Stack, Typography } from '@mui/material';

import { PowerAlert } from '../../../components/PowerAlert';
import {
  BAR_GAP,
  CHART_MARGIN,
  CHART_VIEWBOX_HEIGHT,
  CHART_VIEWBOX_WIDTH,
  LOADING_CHART_HEIGHT,
  PLACEHOLDER_BAR_HEIGHTS,
  buildRoundedTopRectPath,
} from './NetworkDetailsActivityPanel.utils';

export function NetworkDetailsActivityLoadingState() {
  const chartInnerWidth = CHART_VIEWBOX_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
  const chartInnerHeight = CHART_VIEWBOX_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;

  return (
    <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <CircularProgress size={18} />
        <Typography variant="body2" color="text.secondary">
          Завантаження активності мережі
        </Typography>
      </Stack>
      <Box
        sx={{
          position: 'relative',
          minHeight: 0,
          minWidth: 0,
          width: '100%',
          maxWidth: 1280,
          height: LOADING_CHART_HEIGHT,
          alignSelf: 'stretch',
        }}
      >
        <Box
          component="svg"
          aria-hidden="true"
          viewBox={`0 0 ${CHART_VIEWBOX_WIDTH} ${CHART_VIEWBOX_HEIGHT}`}
          preserveAspectRatio="none"
          sx={{
            display: 'block',
            width: '100%',
            height: '100%',
            overflow: 'visible',
          }}
        >
          {[0, 1, 2, 3, 4].map((tickIndex) => {
            const y = CHART_MARGIN.top + (chartInnerHeight / 4) * tickIndex;
            return (
              <g key={tickIndex}>
                <line
                  x1={CHART_MARGIN.left}
                  x2={CHART_VIEWBOX_WIDTH - CHART_MARGIN.right}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeOpacity={tickIndex === 4 ? 0.2 : 0.12}
                  strokeDasharray={tickIndex === 4 ? undefined : '6 6'}
                />
              </g>
            );
          })}

          {PLACEHOLDER_BAR_HEIGHTS.map((heightValue, index) => {
            const bandWidth = chartInnerWidth / PLACEHOLDER_BAR_HEIGHTS.length;
            const barWidth = Math.max(18, bandWidth - BAR_GAP);
            const x = CHART_MARGIN.left + index * bandWidth + (bandWidth - barWidth) / 2;
            const barHeight = (heightValue / 100) * chartInnerHeight;
            const y = CHART_MARGIN.top + chartInnerHeight - barHeight;
            const path = buildRoundedTopRectPath(x, y, barWidth, barHeight);
            return <path key={index} d={path} fill="rgba(255,255,255,0.12)" />;
          })}
        </Box>
      </Box>
    </Stack>
  );
}

export function NetworkDetailsActivityEmptyState() {
  return (
    <Box
      sx={{
        minHeight: 180,
        width: '100%',
        display: 'grid',
        placeItems: 'center',
        borderRadius: 2,
        border: '1px dashed',
        borderColor: 'divider',
        bgcolor: 'background.default',
      }}
    >
      <Typography variant="body2" color="text.secondary">
        Відсутня активність за останні 10 днів
      </Typography>
    </Box>
  );
}

export function NetworkDetailsActivityErrorState({ error, onReload }: { error: string; onReload: () => void }) {
  return (
    <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
      <PowerAlert severity="error" autoHideDuration={null} sx={{ width: '100%' }}>
        {error}
      </PowerAlert>
      <Button variant="outlined" onClick={onReload}>
        Спробувати ще раз
      </Button>
    </Stack>
  );
}
