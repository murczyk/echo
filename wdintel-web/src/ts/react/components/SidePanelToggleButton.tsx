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

const INNER_X = 5;
const INNER_Y = 5;
const INNER_SIZE = 14;
const INNER_RX = 2;
const DIVIDER_LEFT_X = 10;
const DIVIDER_RIGHT_X = 14;

function LeftPanelIcon(props: SvgIconProps) {
  return (
    <SvgIcon viewBox="0 0 24 24" {...props}>
      <rect
        x={INNER_X}
        y={INNER_Y}
        width={INNER_SIZE}
        height={INNER_SIZE}
        rx={INNER_RX}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d={`M${DIVIDER_LEFT_X} ${INNER_Y}V${INNER_Y + INNER_SIZE}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </SvgIcon>
  );
}

function LeftPanelActiveIcon(props: SvgIconProps) {
  return (
    <SvgIcon viewBox="0 0 24 24" {...props}>
      <rect
        x={INNER_X}
        y={INNER_Y}
        width={INNER_SIZE}
        height={INNER_SIZE}
        rx={INNER_RX}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d={`M${INNER_X + INNER_RX} ${INNER_Y}H${DIVIDER_LEFT_X}V${
          INNER_Y + INNER_SIZE
        }H${INNER_X + INNER_RX}A${INNER_RX} ${INNER_RX} 0 0 1 ${INNER_X} ${
          INNER_Y + INNER_SIZE - INNER_RX
        }V${INNER_Y + INNER_RX}A${INNER_RX} ${INNER_RX} 0 0 1 ${
          INNER_X + INNER_RX
        } ${INNER_Y}Z`}
        fill="currentColor"
      />
    </SvgIcon>
  );
}

function RightPanelIcon(props: SvgIconProps) {
  return (
    <SvgIcon viewBox="0 0 24 24" {...props}>
      <rect
        x={INNER_X}
        y={INNER_Y}
        width={INNER_SIZE}
        height={INNER_SIZE}
        rx={INNER_RX}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d={`M${DIVIDER_RIGHT_X} ${INNER_Y}V${INNER_Y + INNER_SIZE}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </SvgIcon>
  );
}

function RightPanelActiveIcon(props: SvgIconProps) {
  return (
    <SvgIcon viewBox="0 0 24 24" {...props}>
      <rect
        x={INNER_X}
        y={INNER_Y}
        width={INNER_SIZE}
        height={INNER_SIZE}
        rx={INNER_RX}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d={`M${DIVIDER_RIGHT_X} ${INNER_Y}H${
          INNER_X + INNER_SIZE - INNER_RX
        }A${INNER_RX} ${INNER_RX} 0 0 1 ${INNER_X + INNER_SIZE} ${
          INNER_Y + INNER_RX
        }V${INNER_Y + INNER_SIZE - INNER_RX}A${INNER_RX} ${INNER_RX} 0 0 1 ${
          INNER_X + INNER_SIZE - INNER_RX
        } ${INNER_Y + INNER_SIZE}H${DIVIDER_RIGHT_X}V${INNER_Y}Z`}
        fill="currentColor"
      />
    </SvgIcon>
  );
}

export function SidePanelToggleButton({
  side,
  active,
  label,
  onClick,
  disabled = false,
}: SidePanelToggleButtonProps) {
  const Icon =
    side === 'left'
      ? active
        ? LeftPanelActiveIcon
        : LeftPanelIcon
      : active
        ? RightPanelActiveIcon
        : RightPanelIcon;

  return (
    <Tooltip title={label} arrow placement={side === 'left' ? 'bottom-start' : 'bottom-end'}>
      <span>
        <IconButton
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          aria-pressed={active}
          sx={(theme) => {
            const tone =
              theme.palette.mode === 'dark'
                ? theme.palette.common.white
                : theme.palette.common.black;

            return {
              width: 40,
              height: 40,
              boxSizing: 'border-box',
              borderRadius: 1,
              border: '1px solid',
              borderColor: theme.palette.divider,
              bgcolor: 'transparent',
              color: active ? tone : theme.palette.text.secondary,
              transition: 'color 0.15s ease',

              '&:hover': {
                bgcolor: 'transparent',
                borderColor: theme.palette.divider,
                color: tone,
              },

              '&.Mui-disabled': {
                color: theme.palette.action.disabled,
                borderColor: theme.palette.action.disabledBackground,
              },

              '& .MuiSvgIcon-root': {
                fontSize: 21,
              },
            };
          }}
        >
          <Icon />
        </IconButton>
      </span>
    </Tooltip>
  );
}
