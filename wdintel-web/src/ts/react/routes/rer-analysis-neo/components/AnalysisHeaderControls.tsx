import { Box, Stack, TextField } from '@mui/material';

import type { AnalysisPageActions, AnalysisPageState } from '../types';
import { DateTimeRangeControl } from '../../../components/DateTimeRangeControl';

type Props = Pick<AnalysisPageState, 'queryState'> & Pick<AnalysisPageActions, 'updateQueryState'>;

export function AnalysisHeaderControls({ queryState, updateQueryState }: Props) {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{ width: 'fit-content', maxWidth: '100%', minWidth: 0, flexWrap: 'wrap', justifyContent: 'flex-start' }}
    >
      <Box sx={{ width: { xs: '100%', sm: 220 }, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        <TextField
          placeholder="Пошук"
          size="small"
          value={queryState.search ?? ''}
          onChange={(event) => updateQueryState({ search: event.target.value })}
          slotProps={{
            input: {
              startAdornment: <Box component="i" className="bi bi-search" sx={{ mr: 1, fontSize: 14, color: 'text.secondary' }} />,
            },
          }}
          sx={{
            width: '100%',
            '& .MuiOutlinedInput-root': {
              height: 40,
              minHeight: 40,
              backgroundColor: 'transparent',
              '& .MuiInputBase-input': {
                py: 0,
                fontSize: '0.875rem',
              },
            },
          }}
        />
      </Box>
      <Box sx={{ width: { xs: '100%', sm: 280 }, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        <DateTimeRangeControl
          value={{
            fromDateTimeStr: queryState.fromDateTimeStr,
            toDateTimeStr: queryState.toDateTimeStr,
          }}
          onChange={(value) => updateQueryState(value)}
        />
      </Box>
    </Stack>
  );
}
