import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import { IconButton, Tooltip } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';

export const analysisNarrowRightPanelToggleSx = {
  width: 40,
  height: 40,
  border: '1px solid',
  borderColor: 'divider',
  borderRadius: 1,
  flexShrink: 0,
  '& .MuiSvgIcon-root': { fontSize: 20 },
};

type Props = {
  expanded: boolean;
  onClick: () => void;
  sx?: Record<string, unknown>;
};

export function AnalysisRightPanelToggle({ expanded, onClick, sx }: Props) {
  const label = expanded ? 'Згорнути праву панель' : 'Розгорнути праву панель';
  const Icon = expanded ? KeyboardArrowUpIcon : KeyboardArrowDownIcon;

  return (
    <Tooltip title={label} arrow>
      <IconButton
        aria-label={label}
        onClick={onClick}
        sx={{ ...analysisNarrowRightPanelToggleSx, ...sx } as SxProps<Theme>}
      >
        <Icon />
      </IconButton>
    </Tooltip>
  );
}
