import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import { Box, Stack, Tooltip } from '@mui/material';
import { useEffect, useState } from 'react';

import type { AnalysisPageActions, AnalysisPageState } from '../types';
import { AnalysisSearchControls } from './AnalysisSearchControls';
import { PowerIconButton } from '../../../components/PowerIconButton';
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
      useFlexGap={isCompactLayout}
      alignItems={isCompactLayout ? 'center' : { xs: 'stretch', sm: 'center' }}
      sx={{
        width: isCompactLayout ? 'fit-content' : { xs: '100%', sm: 'fit-content' },
        maxWidth: isCompactLayout ? 'calc(100vw - 2 * var(--echo-spacing-xl))' : '100%',
        minWidth: 0,
        flexWrap: isCompactLayout ? 'wrap' : 'nowrap',
        justifyContent: 'flex-start',
      }}
    >
      {!isCompactLayout || compactSearchOpen ? (
        <AnalysisSearchControls
          queryState={queryState}
          updateQueryState={updateQueryState}
          isCompactLayout={isCompactLayout}
          onClose={closeCompactSearch}
        />
      ) : (
        <Tooltip title="Пошук" arrow>
          <PowerIconButton
            aria-label="Відкрити пошук"
            size="small"
            onClick={() => setCompactSearchOpen(true)}
          >
            <SearchOutlinedIcon fontSize="small" />
          </PowerIconButton>
        </Tooltip>
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
