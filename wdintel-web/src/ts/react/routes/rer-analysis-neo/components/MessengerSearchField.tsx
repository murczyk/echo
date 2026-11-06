import ClearIcon from '@mui/icons-material/Clear';
import SearchIcon from '@mui/icons-material/Search';
import { IconButton, InputAdornment, TextField } from '@mui/material';

type Props = {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
};

export function MessengerSearchField({ value, onChange, ariaLabel }: Props) {
  return (
    <TextField
      size="small"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="Пошук"
      inputProps={{ 'aria-label': ariaLabel }}
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
