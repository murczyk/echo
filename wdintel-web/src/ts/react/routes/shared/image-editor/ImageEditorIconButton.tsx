import { IconButton, Tooltip } from '@mui/material';
import type { MouseEvent, ReactNode } from 'react';

export function ImageEditorIconButton({
  label,
  icon,
  onClick,
  disabled,
  active,
  compact = false,
  iconSize,
  id,
  ariaControls,
  ariaExpanded,
  ariaHaspopup,
}: {
  label: string;
  icon: ReactNode;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled: boolean;
  active?: boolean;
  compact?: boolean;
  iconSize?: number;
  id?: string;
  ariaControls?: string;
  ariaExpanded?: boolean;
  ariaHaspopup?: 'menu';
}) {
  return (
    <Tooltip title={label}>
      <span>
        <IconButton
          id={id}
          aria-label={label}
          aria-controls={ariaControls}
          aria-expanded={ariaExpanded}
          aria-haspopup={ariaHaspopup}
          aria-pressed={active}
          onClick={onClick}
          disabled={disabled}
          className={`${compact ? 'size-8' : 'size-10'} shrink-0 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-echo-focus`}
          size={compact ? 'small' : 'medium'}
          sx={{
            p: compact ? '6px' : '10px',
            '& > svg': { fontSize: `${iconSize ?? 20}px` },
            '&[aria-pressed="true"]': { backgroundColor: 'action.selected' },
            '&[aria-pressed="true"]:hover': {
              boxShadow: 'inset 0 0 0 1px currentColor',
            },
          }}
          color={active ? 'primary' : 'default'}
        >
          {icon}
        </IconButton>
      </span>
    </Tooltip>
  );
}
