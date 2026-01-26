import ClearIcon from '@mui/icons-material/Clear';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import { InputAdornment, TextField } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import clsx from 'clsx';

import { IconButton } from '../../../../icon-button';

type GlobalFilterTextFieldProps = {
  className?: string;
  globalFilter: string;
  setGlobalFilter: (value: string) => void;
};

export function GlobalFilterTextField(props: GlobalFilterTextFieldProps) {
  const theme = useTheme();

  return (
    <TextField
      className={clsx('!min-w-40', props.className)}
      placeholder="Пошук"
      sx={{
        backgroundColor: theme.palette.mode === 'dark' ? 'background.default' : 'background.paper',
      }}
      onChange={(event) => props.setGlobalFilter(event.target.value)}
      value={props.globalFilter}
      InputProps={{
        startAdornment: (
          <InputAdornment position="start">
            <FilterAltIcon
              sx={{
                color: props.globalFilter ? 'action.active' : 'action.disabled',
              }}
            />
          </InputAdornment>
        ),
        endAdornment: (
          <InputAdornment position="end">
            <IconButton
              disabled={!props.globalFilter}
              size="small"
              aria-label="clear-filter"
              onClick={() => props.setGlobalFilter('')}
            >
              {props.globalFilter ? <ClearIcon className="!w-[18px] !h-[18px]" /> : <div className="!w-[18px] !h-[18px]" />}
            </IconButton>
          </InputAdornment>
        ),
      }}
      variant="outlined"
      size="small"
    />
  );
}
