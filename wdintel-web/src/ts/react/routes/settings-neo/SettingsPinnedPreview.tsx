import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import {
  Box,
  Button,
  Collapse,
  IconButton,
  Tooltip,
  Typography,
  useMediaQuery,
  type Theme,
} from '@mui/material';
import { useId, useState, type ReactNode } from 'react';

/** Below this window height the pinned preview can crowd out the settings it previews. */
const SHORT_WINDOW_MAX_HEIGHT_PX = 900;

/** Shows or hides the pinned preview; icon-only on phones so the title row stays on one line. */
function PreviewToggle({
  hidden,
  contentId,
  onToggle,
}: {
  hidden: boolean;
  contentId: string;
  onToggle: () => void;
}) {
  const iconOnly = useMediaQuery((theme: Theme) => theme.breakpoints.down('sm'));
  const label = hidden ? 'Показати перегляд картки' : 'Сховати перегляд картки';
  const icon = hidden ? <VisibilityOutlinedIcon /> : <VisibilityOffOutlinedIcon />;
  const toggleProps = {
    'aria-label': label,
    'aria-expanded': !hidden,
    'aria-controls': contentId,
    onClick: onToggle,
  };
  return iconOnly ? (
    <Tooltip title={label}>
      <IconButton size="small" color="primary" sx={{ my: -0.5 }} {...toggleProps}>
        {icon}
      </IconButton>
    </Tooltip>
  ) : (
    <Button
      size="small"
      startIcon={icon}
      sx={{ flexShrink: 0, textTransform: 'none', whiteSpace: 'nowrap' }}
      {...toggleProps}
    >
      {hidden ? 'Показати' : 'Сховати'}
    </Button>
  );
}

/**
 * Keeps the titled card preview in view while the settings below it change.
 * Narrow or short windows can hide the preview to free the space it pins; the title row stays.
 */
export function SettingsPinnedPreview({ title, children }: { title: string; children: ReactNode }) {
  const narrowWindow = useMediaQuery((theme: Theme) => theme.breakpoints.down('md'));
  const shortWindow = useMediaQuery(`(max-height: ${SHORT_WINDOW_MAX_HEIGHT_PX - 0.05}px)`);
  const canHide = narrowWindow || shortWindow;
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [hiddenByUser, setHiddenByUser] = useState(false);
  const contentId = useId();
  const hidden = canHide && hiddenByUser;
  return (
    <Box
      data-settings-pinned-preview="true"
      className="sticky top-[var(--app-shell-sticky-top,0px)] z-10 flex flex-col gap-echo-xs border-b border-echo-border py-echo-sm"
      sx={{ bgcolor: 'background.paper' }}
    >
      <div className="flex min-h-echo-control-sm items-center justify-between gap-echo-sm">
        <Typography
          variant="overline"
          noWrap
          sx={{ color: 'text.secondary', letterSpacing: 0.8, lineHeight: 1.5 }}
        >
          {title}
        </Typography>
        {canHide ? (
          <PreviewToggle
            hidden={hidden}
            contentId={contentId}
            onToggle={() => setHiddenByUser((current) => !current)}
          />
        ) : null}
      </div>
      <Collapse id={contentId} in={!hidden} timeout={reducedMotion ? 0 : 250}>
        {children}
      </Collapse>
    </Box>
  );
}
