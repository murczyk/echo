import ClearIcon from '@mui/icons-material/Clear';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import { InputAdornment, TextField } from '@mui/material';
import clsx from 'clsx';

import { IconButton } from '../../../../icon-button';

type GlobalFilterTextFieldProps = {
  className?: string;
  globalFilter: string;
  setGlobalFilter: (value: string) => void;
  disabled?: boolean;
};

export function GlobalFilterTextField(props: GlobalFilterTextFieldProps) {
  return (
    <TextField
      className={clsx('!min-w-40', props.className)}
      placeholder="Пошук"
      sx={{
        backgroundColor: 'var(--bs-body-bg)',
        '& .MuiOutlinedInput-root': {
          borderRadius: 0,
          backgroundColor: 'var(--bs-body-bg)',
          '& .MuiInputBase-input::placeholder': {
            color: 'text.secondary',
            opacity: 1,
          },
          '& .MuiOutlinedInput-notchedOutline': {
            borderColor: 'var(--bs-border-color)',
          },
          '&:hover .MuiOutlinedInput-notchedOutline': {
            borderColor: 'var(--bs-border-color)',
          },
          ...(props.disabled
            ? {
                pointerEvents: 'none',
              }
            : {}),
        },
      }}
      disabled={props.disabled}
      onChange={(event) => props.setGlobalFilter(event.target.value)}
      value={props.globalFilter}
      slotProps={{
        input: {
          readOnly: props.disabled,
          startAdornment: (
            <InputAdornment position="start">
              <FilterAltIcon
                sx={{
                  color: props.globalFilter ? 'text.secondary' : 'text.secondary',
                }}
              />
            </InputAdornment>
          ),
          endAdornment: (
            <InputAdornment position="end">
              <IconButton
                disabled={props.disabled || !props.globalFilter}
                size="small"
                aria-label="clear-filter"
                onClick={() => props.setGlobalFilter('')}
              >
                {props.globalFilter ? <ClearIcon className="!w-[18px] !h-[18px]" /> : <div className="!w-[18px] !h-[18px]" />}
              </IconButton>
            </InputAdornment>
          ),
        },
      }}
      variant="outlined"
      size="small"
    />
  );
}
