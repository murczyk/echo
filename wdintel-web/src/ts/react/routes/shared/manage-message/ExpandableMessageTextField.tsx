import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import { Box, IconButton, TextField, Tooltip, type TextFieldProps } from '@mui/material';
import { forwardRef, useId, useState } from 'react';

type Props = Omit<TextFieldProps, 'label' | 'rows' | 'multiline' | 'slotProps' | 'sx'> & {
  label: string;
  rows: number;
  minInputHeight?: number | null;
};

export function MessageTextHeightToggle({
  expanded,
  label,
  controls,
  disabled,
  onToggle,
}: {
  expanded: boolean;
  label: string;
  controls: string;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const actionLabel = `${expanded ? 'Зменшити' : 'Збільшити'} поле «${label}»`;

  return (
    <Tooltip title={actionLabel}>
      <IconButton
        type="button"
        size="small"
        aria-label={actionLabel}
        aria-controls={controls}
        aria-expanded={expanded}
        disabled={disabled}
        onClick={onToggle}
        sx={{
          alignSelf: 'center',
          width: 24,
          height: 24,
          p: 0.5,
          mb: -1.5,
          color: 'text.secondary',
        }}
      >
        {expanded ? (
          <KeyboardArrowUpIcon sx={{ fontSize: 16 }} />
        ) : (
          <KeyboardArrowDownIcon sx={{ fontSize: 16 }} />
        )}
      </IconButton>
    </Tooltip>
  );
}

export const ExpandableMessageTextField = forwardRef<HTMLDivElement, Props>(
  function ExpandableMessageTextField({ label, rows, minInputHeight, id, ...props }, ref) {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const [expanded, setExpanded] = useState(false);
    const multiplier = expanded ? 2 : 1;

    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 0.5 }}>
        <TextField
          {...props}
          ref={ref}
          id={inputId}
          label={label}
          multiline
          rows={rows * multiplier}
          sx={
            minInputHeight != null
              ? { '& .MuiInputBase-root': { minHeight: minInputHeight * multiplier } }
              : undefined
          }
        />
        <MessageTextHeightToggle
          expanded={expanded}
          label={label}
          controls={inputId}
          disabled={props.disabled}
          onToggle={() => setExpanded((value) => !value)}
        />
      </Box>
    );
  },
);
