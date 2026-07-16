import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { Box, Button, DialogActions, IconButton, Tooltip, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import { getMessageCardPreviewActionBarSx } from './message-card-preview-shell';

export function MessageCardCoordinateMapActions({
  currentIndex,
  pointCount,
  onClose,
  onIndexChange,
}: {
  currentIndex: number;
  pointCount: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}) {
  const theme = useTheme();
  const hasCarousel = pointCount > 1;
  const isFirst = currentIndex <= 0;
  const isLast = currentIndex >= pointCount - 1;

  return (
    <DialogActions sx={getMessageCardPreviewActionBarSx(theme)}>
      <Box />
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
        {hasCarousel ? (
          <>
            <Tooltip title="Попереднє" enterDelay={300}>
              <span>
                <IconButton
                  aria-label="Попереднє"
                  size="small"
                  onClick={() => onIndexChange(currentIndex - 1)}
                  disabled={isFirst}
                  sx={{ color: 'text.secondary' }}
                >
                  <ChevronLeftIcon />
                </IconButton>
              </span>
            </Tooltip>
            <Typography
              variant="body2"
              sx={{
                backgroundColor: 'action.hover',
                color: 'text.primary',
                fontWeight: 700,
                letterSpacing: 0,
                px: 1,
                py: 0.25,
                borderRadius: 1,
              }}
            >
              {`${currentIndex + 1} / ${pointCount}`}
            </Typography>
            <Tooltip title="Наступне" enterDelay={300}>
              <span>
                <IconButton
                  aria-label="Наступне"
                  size="small"
                  onClick={() => onIndexChange(currentIndex + 1)}
                  disabled={isLast}
                  sx={{ color: 'text.secondary' }}
                >
                  <ChevronRightIcon />
                </IconButton>
              </span>
            </Tooltip>
          </>
        ) : null}
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button aria-label="Закрити" onClick={onClose} sx={{ flexShrink: 0, ml: 1 }}>
          Закрити
        </Button>
      </Box>
    </DialogActions>
  );
}
