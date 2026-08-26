import { IconButton, Tooltip } from '@mui/material';
import type { ReactNode } from 'react';

export function ImageEditorIconButton({
  label,
  icon,
  onClick,
  disabled,
  active,
  compact = false,
  iconSize,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled: boolean;
  active?: boolean;
  compact?: boolean;
  iconSize?: number;
}) {
  return (
    <Tooltip title={label}>
      <span>
        <IconButton
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          disabled={disabled}
          className={`${compact ? 'size-8' : 'size-10'} shrink-0 rounded-full`}
          size={compact ? 'small' : 'medium'}
          sx={
            compact
              ? { p: '6px', '& > svg': { fontSize: `${iconSize ?? 20}px` } }
              : { p: '9px', '& > svg': { fontSize: `${iconSize ?? 22}px` } }
          }
          color={active ? 'primary' : 'default'}
        >
          {icon}
        </IconButton>
      </span>
    </Tooltip>
  );
}
