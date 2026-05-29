import { IconButton, Tooltip, SvgIcon } from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { SvgIconProps } from '@mui/material';

type SidePanelSide = 'left' | 'right';

type SidePanelToggleButtonProps = {
  side: SidePanelSide;
  active: boolean;
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

function LeftPanelIcon(props: SvgIconProps) {
  return (
    <SvgIcon viewBox="0 0 24 24" {...props}>
      <rect
        x="3.5"
        y="3.5"
        width="17"
        height="17"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <rect
        x="5.5"
        y="5.5"
        width="4.5"
        height="13"
        rx="1"
        fill="currentColor"
      />
    </SvgIcon>
  );
}

function RightPanelIcon(props: SvgIconProps) {
  return (
    <SvgIcon viewBox="0 0 24 24" {...props}>
      <rect
        x="3.5"
        y="3.5"
        width="17"
        height="17"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <rect
        x="14"
        y="5.5"
        width="4.5"
        height="13"
        rx="1"
        fill="currentColor"
      />
    </SvgIcon>
  );
}

export function SidePanelToggleButton({ side, active, label, onClick, disabled = false }: SidePanelToggleButtonProps) {
  const Icon = side === 'left' ? LeftPanelIcon : RightPanelIcon;

  return (
    <Tooltip title={label} arrow placement={side === 'left' ? 'bottom-start' : 'bottom-end'}>
      <span>
        <IconButton
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          aria-pressed={active}
          sx={(theme) => ({
            width: 44,
            height: 44,
            boxSizing: 'border-box',
            borderRadius: 1,
            border: '1px solid',
            borderColor: active ? theme.palette.primary.main : theme.palette.divider,
            bgcolor: active
              ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.12)
              : theme.palette.background.paper,
            color: active ? theme.palette.primary.main : theme.palette.text.secondary,
            transition: 'background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease',
            '&:hover': {
              bgcolor: active
                ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.24 : 0.16)
                : theme.palette.action.hover,
              borderColor: theme.palette.primary.main,
              color: theme.palette.primary.main,
            },
            '&.Mui-disabled': {
              color: theme.palette.action.disabled,
              borderColor: theme.palette.action.disabledBackground,
            },
            '& .MuiSvgIcon-root': {
              fontSize: 24,
            },
          })}
        >
          <Icon />
        </IconButton>
      </span>
    </Tooltip>
  );
}
