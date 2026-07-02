import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import {
  Box,
  IconButton,
  MenuItem,
  Select,
  SelectChangeEvent,
  ThemeProvider,
  Typography,
} from '@mui/material';
import { useCallback, useMemo, useState } from 'react';

import { copyTextToClipboard } from '../copy-to-clipboard';
import { CoordFormat, getCoordinateText } from '../maps/coordinate-format';
import { useNeoMuiTheme } from './mui-theme';

type AnalysisMapCoordMenuProps = {
  lat: number;
  lng: number;
  mgrsCoords?: string | null;
  onClose: () => void;
};

function AnalysisMapCoordMenuInner(props: AnalysisMapCoordMenuProps) {
  const { lat, lng, mgrsCoords, onClose } = props;
  const [format, setFormat] = useState<CoordFormat>('mgrs');

  const value = useMemo(
    () => getCoordinateText(format, { lat, lng }, mgrsCoords),
    [format, lat, lng, mgrsCoords],
  );

  const handleCopy = useCallback(() => {
    void copyTextToClipboard(value);
  }, [value]);

  const handleFormatChange = useCallback(
    (event: SelectChangeEvent<CoordFormat>) => {
      const nextFormat = event.target.value as CoordFormat;
      setFormat(nextFormat);
      void copyTextToClipboard(getCoordinateText(nextFormat, { lat, lng }, mgrsCoords));
    },
    [lat, lng, mgrsCoords],
  );

  return (
    <Box
      className="analysis-map-coord-menu"
      sx={{
        '--analysis-map-coord-menu-bg': 'rgba(31, 36, 42, 0.96)',
        '--analysis-map-coord-menu-border': 'rgba(255, 255, 255, 0.12)',
        '--analysis-map-coord-menu-accent': 'rgba(255, 255, 255, 0.18)',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.25,
        minWidth: 196,
        width: 'max-content',
        maxWidth: 'min(calc(100vw - 24px), 560px)',
        px: 1.25,
        pt: 1.25,
        pb: 1.125,
        borderRadius: 2.5,
        bgcolor: 'var(--analysis-map-coord-menu-bg)',
        color: '#fff',
        border: 1,
        borderColor: 'var(--analysis-map-coord-menu-border)',
        boxShadow: '0 14px 32px rgba(0, 0, 0, 0.36)',
        backdropFilter: 'blur(8px)',
      }}
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'auto 28px',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
        }}
      >
        <Select<CoordFormat>
          value={format}
          onChange={handleFormatChange}
          size="small"
          variant="outlined"
          aria-label="Формат координат"
          MenuProps={{
            slotProps: {
              root: {
                sx: {
                  zIndex: 11001,
                },
              },
              backdrop: {
                sx: {
                  zIndex: 11000,
                },
              },
              paper: {
                sx: {
                  zIndex: 11001,
                },
              },
            },
          }}
          sx={{
            minHeight: 36,
            width: 'fit-content',
            minWidth: 110,
            borderRadius: 1.5,
            fontSize: 13,
            fontWeight: 600,
            color: '#fff',
            bgcolor: 'rgba(255, 255, 255, 0.04)',
            '& .MuiOutlinedInput-notchedOutline': {
              borderColor: 'var(--analysis-map-coord-menu-accent)',
            },
            '&:hover .MuiOutlinedInput-notchedOutline': {
              borderColor: 'rgba(255, 255, 255, 0.24)',
            },
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
              borderColor: 'rgba(255, 255, 255, 0.32)',
            },
            '& .MuiSvgIcon-root': {
              color: '#fff',
            },
            '& .MuiSelect-select': {
              display: 'flex',
              alignItems: 'center',
              minHeight: '36px !important',
              py: 0,
              px: 1.25,
            },
          }}
        >
          <MenuItem value="mgrs">MGRS</MenuItem>
          <MenuItem value="wgs">WGS</MenuItem>
        </Select>

        <IconButton
          aria-label="Закрити меню координат"
          onClick={onClose}
          size="small"
          sx={{
            justifySelf: 'end',
            width: 28,
            height: 28,
            borderRadius: 1.25,
            color: 'rgba(255, 255, 255, 0.92)',
            '&:hover': {
              bgcolor: 'rgba(255, 255, 255, 0.08)',
            },
            '&.Mui-focusVisible': {
              outline: 'none',
              boxShadow: 'none',
            },
          }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 28px',
          alignItems: 'center',
          gap: 1.25,
        }}
      >
        <Typography
          sx={{
            fontSize: 15,
            fontWeight: 500,
            lineHeight: 1.3,
            letterSpacing: '0.03em',
            textAlign: 'left',
            whiteSpace: 'nowrap',
            color: 'rgba(255, 255, 255, 0.96)',
            px: 0.25,
            py: 0,
            cursor: 'default',
            userSelect: 'text',
          }}
        >
          {value}
        </Typography>

        <IconButton
          aria-label="Скопіювати координати"
          title="Скопіювати координати"
          onClick={handleCopy}
          size="small"
          sx={{
            justifySelf: 'end',
            width: 28,
            height: 28,
            borderRadius: 1.25,
            color: 'rgba(255, 255, 255, 0.92)',
            '&:hover': {
              bgcolor: 'rgba(255, 255, 255, 0.08)',
            },
            '&.Mui-focusVisible': {
              outline: 'none',
              boxShadow: 'none',
            },
          }}
        >
          <ContentCopyIcon fontSize="small" />
        </IconButton>
      </Box>
    </Box>
  );
}

export function AnalysisMapCoordMenu(props: AnalysisMapCoordMenuProps) {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <AnalysisMapCoordMenuInner {...props} />
    </ThemeProvider>
  );
}
