import ClearIcon from '@mui/icons-material/Clear';
import SearchIcon from '@mui/icons-material/Search';
import { IconButton, InputAdornment, TextField } from '@mui/material';
import type { InputHTMLAttributes } from 'react';

type Props = {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  // Extra attributes and handlers of the input itself (a combobox's role, key and focus handlers).
  inputProps?: InputHTMLAttributes<HTMLInputElement>;
};

export function MessengerSearchField({
  value,
  onChange,
  ariaLabel,
  placeholder = 'Пошук',
  inputProps,
}: Props) {
  return (
    <TextField
      size="small"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      inputProps={{ 'aria-label': ariaLabel, ...inputProps }}
      slotProps={{
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
          endAdornment:
            value !== '' ? (
              <InputAdornment position="end">
                <IconButton
                  size="small"
                  edge="end"
                  onClick={() => onChange('')}
                  aria-label="Очистити пошук"
                >
                  <ClearIcon fontSize="small" />
                </IconButton>
              </InputAdornment>
            ) : undefined,
        },
      }}
    />
  );
}
