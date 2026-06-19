import ClearIcon from '@mui/icons-material/Clear';
import SearchIcon from '@mui/icons-material/Search';
import { InputAdornment, TextField } from '@mui/material';
import clsx from 'clsx';
import type { KeyboardEvent } from 'react';

import { PowerIconButton } from '../../../../../PowerIconButton';

type GlobalFilterTextFieldProps = {
  className?: string;
  globalFilter: string;
  setGlobalFilter: (value: string) => void;
  disabled?: boolean;
};

export function GlobalFilterTextField(props: GlobalFilterTextFieldProps) {
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (props.disabled || !props.globalFilter || event.key !== 'Escape' || event.currentTarget.readOnly) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    props.setGlobalFilter('');
  }

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
          '& input:-webkit-autofill, & input:-webkit-autofill:hover, & input:-webkit-autofill:focus': {
            WebkitTextFillColor: 'var(--bs-body-color)',
            WebkitBoxShadow: '0 0 0 100px var(--bs-body-bg) inset',
            transition: 'background-color 9999s ease-out 0s',
            caretColor: 'var(--bs-body-color)',
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
      onKeyDown={onKeyDown}
      value={props.globalFilter}
      variant="outlined"
      size="small"
      slotProps={{
        input: {
          readOnly: props.disabled,
          autoComplete: 'new-password',
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon
                sx={{
                  color: 'text.secondary',
                }}
              />
            </InputAdornment>
          ),
          endAdornment: (
            <InputAdornment position="end">
              <PowerIconButton
                disabled={props.disabled || !props.globalFilter}
                size="small"
                aria-label="clear-filter"
                onClick={() => props.setGlobalFilter('')}
              >
                {props.globalFilter ? <ClearIcon className="!w-[18px] !h-[18px]" /> : <div className="!w-[18px] !h-[18px]" />}
              </PowerIconButton>
            </InputAdornment>
          ),
        },
      }}
    />
  );
}
