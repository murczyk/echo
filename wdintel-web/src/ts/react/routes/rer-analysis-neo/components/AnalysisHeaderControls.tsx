import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import ClearOutlinedIcon from '@mui/icons-material/ClearOutlined';
import { Box, IconButton, InputAdornment, Stack, TextField, Tooltip } from '@mui/material';

import type { AnalysisPageActions, AnalysisPageState } from '../types';
import { DateTimeRangeControl } from '../../../components/DateTimeRangeControl';

type Props = Pick<AnalysisPageState, 'queryState'> & Pick<AnalysisPageActions, 'updateQueryState'>;

export function AnalysisHeaderControls({ queryState, updateQueryState }: Props) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1}
      alignItems={{ xs: 'stretch', sm: 'center' }}
      sx={{
        width: { xs: '100%', sm: 'fit-content' },
        maxWidth: '100%',
        minWidth: 0,
        flexWrap: { xs: 'nowrap', sm: 'wrap' },
        justifyContent: 'flex-start',
      }}
    >
      <Box
        sx={{
          width: { xs: '100%', sm: 220 },
          minWidth: 0,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <TextField
          placeholder="Пошук"
          size="small"
          value={queryState.search ?? ''}
          onChange={(event) =>
            updateQueryState({ search: event.target.value.trim() === '' ? '' : event.target.value })
          }
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchOutlinedIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                </InputAdornment>
              ),
              endAdornment: queryState.search ? (
                <InputAdornment position="end">
                  <Tooltip title="Очистити пошук" arrow>
                    <IconButton
                      aria-label="Очистити пошук"
                      size="small"
                      onClick={() => updateQueryState({ search: '' })}
                      sx={{ p: 0.25, color: 'text.secondary' }}
                    >
                      <ClearOutlinedIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                  </Tooltip>
                </InputAdornment>
              ) : undefined,
            },
          }}
          sx={{
            width: '100%',
            '& .MuiOutlinedInput-root': {
              height: 40,
              minHeight: 40,
              backgroundColor: 'transparent',
              '& .MuiInputBase-input': {
                fontSize: 14,
                lineHeight: '20px',
                boxSizing: 'border-box',
                padding: '9px 8px 9px 0 !important',
              },
            },
          }}
        />
      </Box>
      <Box
        sx={{
          width: { xs: '100%', sm: 280 },
          minWidth: 0,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
        }}
      >
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
