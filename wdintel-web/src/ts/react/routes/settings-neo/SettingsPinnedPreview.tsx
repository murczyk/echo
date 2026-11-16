import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { Box, Button, Collapse, useMediaQuery, type Theme } from '@mui/material';
import { useId, useState, type ReactNode } from 'react';

/**
 * Keeps the card preview in view while the settings below it change.
 * Small screens can hide it to free the space it pins.
 */
export function SettingsPinnedPreview({ children }: { children: ReactNode }) {
  const smallScreen = useMediaQuery((theme: Theme) => theme.breakpoints.down('md'));
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [hiddenOnSmallScreen, setHiddenOnSmallScreen] = useState(false);
  const contentId = useId();
  const hidden = smallScreen && hiddenOnSmallScreen;
  return (
    <Box
      data-settings-pinned-preview="true"
      className="sticky top-[var(--app-shell-sticky-top,0px)] z-10 flex flex-col gap-echo-xs border-b border-echo-border py-echo-sm"
      sx={{ bgcolor: 'background.paper' }}
    >
      {smallScreen ? (
        <Button
          size="small"
          aria-expanded={!hidden}
          aria-controls={contentId}
          startIcon={hidden ? <VisibilityOutlinedIcon /> : <VisibilityOffOutlinedIcon />}
          onClick={() => setHiddenOnSmallScreen((current) => !current)}
          sx={{ alignSelf: 'flex-end', textTransform: 'none' }}
        >
          {hidden ? 'Показати перегляд картки' : 'Сховати перегляд картки'}
        </Button>
      ) : null}
      <Collapse id={contentId} in={!hidden} timeout={reducedMotion ? 0 : 250}>
        {children}
      </Collapse>
    </Box>
  );
}
