import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import {
  Box,
  IconButton,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';

import type { MessageCardPreviewNavigation } from './attachment-preview/message-card-preview.types';

type BaseLayerId = 'googleHybrid' | 'openStreetMap';

export function CoordinateMapPreviewControls({
  baseLayerId,
  onBaseLayerChange,
  pointNavigation,
}: {
  baseLayerId: BaseLayerId;
  onBaseLayerChange: (baseLayerId: BaseLayerId) => void;
  pointNavigation: MessageCardPreviewNavigation;
}) {
  return (
    <Box
      sx={{
        position: 'absolute',
        bottom: 16,
        left: 16,
        zIndex: 1300,
        pointerEvents: 'auto',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'background.paper',
          backdropFilter: 'blur(12px)',
          borderRadius: 2,
          boxShadow: (theme) =>
            theme.palette.mode === 'dark'
              ? '0 4px 20px rgba(0, 0, 0, 0.35)'
              : '0 4px 20px rgba(0, 0, 0, 0.12)',
          p: 0.5,
          color: 'text.primary',
          border: 1,
          borderColor: 'divider',
        }}
      >
        {pointNavigation.count > 1 ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, mr: 0.5 }}>
            <Tooltip title="Попередня координата" enterDelay={300}>
              <IconButton
                type="button"
                size="small"
                aria-label="Попередня координата"
                onClick={pointNavigation.onPrevious}
              >
                <ChevronLeftIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Typography
              variant="caption"
              data-coordinate-point-counter="true"
              sx={{ minWidth: 32, textAlign: 'center', color: 'text.primary' }}
            >
              {pointNavigation.index + 1} / {pointNavigation.count}
            </Typography>
            <Tooltip title="Наступна координата" enterDelay={300}>
              <IconButton
                type="button"
                size="small"
                aria-label="Наступна координата"
                onClick={pointNavigation.onNext}
              >
                <ChevronRightIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        ) : null}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={baseLayerId}
            onChange={(_, nextLayerId: BaseLayerId | null) => {
              if (nextLayerId != null) {
                onBaseLayerChange(nextLayerId);
              }
            }}
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexWrap: 'wrap',
              gap: 0.5,
              backgroundColor: 'transparent',
              '& .MuiToggleButtonGroup-grouped': {
                border: 0,
                borderRadius: 1.5,
                minWidth: 30,
                width: 30,
                height: 30,
                padding: 0,
                color: 'text.secondary',
                backgroundColor: 'transparent',
                '&:hover': {
                  color: 'text.primary',
                  backgroundColor: 'action.hover',
                },
                '&.Mui-selected': {
                  color: 'text.primary',
                  backgroundColor: 'action.selected',
                },
                '&.Mui-selected:hover': {
                  backgroundColor: 'action.selected',
                },
              },
            }}
          >
            <Tooltip title="Супутник" enterDelay={300}>
              <ToggleButton aria-label="Супутник" value="googleHybrid">
                <LayersOutlinedIcon fontSize="small" />
              </ToggleButton>
            </Tooltip>
            <Tooltip title="OpenStreetMap" enterDelay={300}>
              <ToggleButton aria-label="OpenStreetMap" value="openStreetMap">
                <MapOutlinedIcon fontSize="small" />
              </ToggleButton>
            </Tooltip>
          </ToggleButtonGroup>
        </Box>
      </Box>
    </Box>
  );
}
