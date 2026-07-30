import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import ClearOutlinedIcon from '@mui/icons-material/ClearOutlined';
import {
  Box,
  IconButton,
  InputAdornment,
  InputBase,
  Stack,
  TextField,
  Tooltip,
} from '@mui/material';
import { useEffect, useState } from 'react';

import type { AnalysisPageActions, AnalysisPageState } from '../types';
import {
  dateTimeRangeDisplaysYear,
  DateTimeRangeControl,
  type DateTimeRangeValue,
} from '../../../components/DateTimeRangeControl';

type Props = Pick<AnalysisPageState, 'queryState'> & Pick<AnalysisPageActions, 'updateQueryState'>;
type AnalysisHeaderControlsProps = Props & { isCompactLayout?: boolean };

export function getAnalysisDateTimeRangeWidth(
  value: DateTimeRangeValue,
  now: Date = new Date(),
): number {
  return dateTimeRangeDisplaysYear(value, now) ? 280 : 220;
}

export function AnalysisHeaderControls({
  queryState,
  updateQueryState,
  isCompactLayout = false,
}: AnalysisHeaderControlsProps) {
  const [compactSearchOpen, setCompactSearchOpen] = useState(Boolean(queryState.search));
  const dateTimeRangeValue = {
    fromDateTimeStr: queryState.fromDateTimeStr,
    toDateTimeStr: queryState.toDateTimeStr,
  };

  useEffect(() => {
    if (isCompactLayout && queryState.search) {
      setCompactSearchOpen(true);
    }
  }, [isCompactLayout, queryState.search]);

  const closeCompactSearch = () => {
    updateQueryState({ search: '' });
    setCompactSearchOpen(false);
  };

  return (
    <Stack
      direction={isCompactLayout ? 'row' : { xs: 'column', sm: 'row' }}
      spacing={1}
      alignItems={isCompactLayout ? 'center' : { xs: 'stretch', sm: 'center' }}
      sx={{
        width: isCompactLayout ? 'fit-content' : { xs: '100%', sm: 'fit-content' },
        maxWidth: '100%',
        minWidth: 0,
        flexWrap: 'nowrap',
        justifyContent: 'flex-start',
      }}
    >
      {isCompactLayout ? (
        <Box
          sx={(theme) => ({
            display: 'flex',
            alignItems: 'center',
            flexShrink: 0,
            width: compactSearchOpen ? { xs: 140, sm: 180 } : 40,
            height: 40,
            overflow: 'hidden',
            border: '1px solid',
            borderColor: compactSearchOpen ? theme.palette.divider : 'transparent',
            borderRadius: 1,
            transition: theme.transitions.create(['width', 'border-color'], {
              duration: theme.transitions.duration.short,
            }),
          })}
        >
          {compactSearchOpen ? (
            <InputBase
              autoFocus
              value={queryState.search ?? ''}
              onChange={(event) =>
                updateQueryState({
                  search: event.target.value.trim() === '' ? '' : event.target.value,
                })
              }
              placeholder="Пошук"
              inputProps={{ 'aria-label': 'Пошук' }}
              sx={{
                minWidth: 0,
                flex: 1,
                pl: 1,
                fontSize: 14,
                '& input': { p: 0 },
              }}
            />
          ) : null}
          <Tooltip title={compactSearchOpen ? 'Очистити й закрити пошук' : 'Пошук'} arrow>
            <IconButton
              aria-label={compactSearchOpen ? 'Очистити й закрити пошук' : 'Відкрити пошук'}
              size="small"
              onClick={() =>
                compactSearchOpen ? closeCompactSearch() : setCompactSearchOpen(true)
              }
              color={compactSearchOpen ? 'primary' : 'default'}
              sx={{ width: 38, height: 38, p: 0.75, ml: 'auto', flexShrink: 0 }}
            >
              {compactSearchOpen ? (
                <ClearOutlinedIcon sx={{ fontSize: 18 }} />
              ) : (
                <SearchOutlinedIcon sx={{ fontSize: 18 }} />
              )}
            </IconButton>
          </Tooltip>
        </Box>
      ) : (
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
              updateQueryState({
                search: event.target.value.trim() === '' ? '' : event.target.value,
              })
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
      )}
      <Box
        sx={{
          width: isCompactLayout
            ? 40
            : { xs: '100%', sm: getAnalysisDateTimeRangeWidth(dateTimeRangeValue) },
          minWidth: 0,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <DateTimeRangeControl
          value={dateTimeRangeValue}
          onChange={(value) => updateQueryState(value)}
          displayMode={isCompactLayout ? 'icon' : 'date-time'}
        />
      </Box>
    </Stack>
  );
}
