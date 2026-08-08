import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { Box, ButtonBase, Tooltip } from '@mui/material';
import { useEffect, useRef, useState } from 'react';

export function AttachmentPreviewZoomBadge({
  zoom,
  onResetZoom,
}: {
  zoom: number;
  onResetZoom?: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const isFirstMount = useRef(true);
  const timerRef = useRef<number | null>(null);
  const roundedZoom = Math.round(zoom);
  const isNotDefaultZoom = roundedZoom !== 100;

  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      if (isNotDefaultZoom) {
        setVisible(true);
      }
      return;
    }

    setVisible(true);

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (!isNotDefaultZoom) {
      timerRef.current = window.setTimeout(() => {
        setVisible(false);
        timerRef.current = null;
      }, 1500);
    }

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [zoom, isNotDefaultZoom]);

  const badgeContent = (
    <Box
      component={onResetZoom ? ButtonBase : 'div'}
      onClick={onResetZoom}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        backgroundColor: 'background.paper',
        backdropFilter: 'blur(12px)',
        color: 'text.primary',
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        px: 1.5,
        py: 0.5,
        fontSize: 13,
        fontWeight: 600,
        fontFamily: 'monospace',
        fontVariantNumeric: 'tabular-nums',
        boxShadow: (theme) =>
          theme.palette.mode === 'dark'
            ? '0 4px 14px rgba(0, 0, 0, 0.35)'
            : '0 4px 14px rgba(0, 0, 0, 0.12)',
        cursor: onResetZoom ? 'pointer' : 'default',
        '&:hover': onResetZoom
          ? {
              backgroundColor: 'action.hover',
            }
          : undefined,
      }}
    >
      <span>{roundedZoom}%</span>
      {isNotDefaultZoom && onResetZoom ? <RestartAltIcon sx={{ fontSize: 16, ml: 0.25 }} /> : null}
    </Box>
  );

  return (
    <Box
      sx={{
        position: 'absolute',
        bottom: 16,
        left: 16,
        zIndex: 1300,
        opacity: visible ? 1 : 0,
        transition: 'opacity 400ms ease-out',
        pointerEvents: visible && onResetZoom ? 'auto' : 'none',
      }}
    >
      {isNotDefaultZoom && onResetZoom ? (
        <Tooltip title="Скинути масштаб (100%)" enterDelay={300}>
          {badgeContent}
        </Tooltip>
      ) : (
        badgeContent
      )}
    </Box>
  );
}
