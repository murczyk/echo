import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import { InputAdornment, Stack, TextField } from '@mui/material';

import { PowerButton } from '../../components/PowerButton';

export function DocumentsToolbar({
  query,
  onQueryChange,
  onSearch,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  onSearch: () => void;
}) {
  return (
    <Stack
      direction="row"
      spacing={1}
      component="form"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch();
      }}
    >
      <TextField
        size="small"
        label="Назва або вміст"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          },
        }}
        sx={{ minWidth: 280 }}
      />
      <PowerButton type="submit" variant="outlined" startIcon={<RefreshIcon />}>
        Знайти / оновити
      </PowerButton>
    </Stack>
  );
}
