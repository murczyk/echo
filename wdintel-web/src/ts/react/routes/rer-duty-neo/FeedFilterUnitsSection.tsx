import { Box, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useMemo, type ReactNode } from 'react';

import type { Unit } from '../../../../Bindings';
import { SearchableOptionAutocomplete } from '../../components/SearchableOptionAutocomplete';
import type { SearchableOptionSelection } from '../../components/searchable-option.types';
import { isNullOrUndefined } from '../../utils/misc';
import { getUnitDisplayLabel, getUnitFilterValue } from '../../utils/unit-search';

type FeedFilterSelectionMode = 'include' | 'exclude';

export type FeedFilterUnitsSectionProps = {
  title: string;
  mode: FeedFilterSelectionMode;
  onModeChange: (mode: FeedFilterSelectionMode) => void;
  options: readonly Unit[];
  selected: readonly SearchableOptionSelection[];
  onSelectedChange: (value: SearchableOptionSelection[]) => void;
  placeholder?: string;
  autocompleteClassName?: string;
  headerRight?: ReactNode;
  includeLabel?: string;
  excludeLabel?: string;
};

export function FeedFilterUnitsSection({
  title,
  mode,
  onModeChange,
  options,
  selected,
  onSelectedChange,
  placeholder,
  autocompleteClassName,
  headerRight,
  includeLabel = 'лише',
  excludeLabel = 'окрім',
}: FeedFilterUnitsSectionProps) {
  const toggleGroupSx = useMemo(
    () =>
      ({
        flexShrink: 0,
        height: 36,
        borderRadius: 1,
        border: '1px solid',
        borderColor: 'divider',
        backgroundColor: 'background.paper',
        '& .MuiToggleButtonGroup-grouped': {
          margin: 0,
          borderRadius: 0,
          border: 0,
          minHeight: 36,
          height: 36,
          '&:not(:first-of-type)': {
            borderLeft: '1px solid',
            borderLeftColor: 'divider',
          },
        },
        '& .MuiToggleButtonGroup-firstButton': {
          borderTopLeftRadius: 'inherit',
          borderBottomLeftRadius: 'inherit',
        },
        '& .MuiToggleButtonGroup-lastButton': {
          borderTopRightRadius: 'inherit',
          borderBottomRightRadius: 'inherit',
        },
        '& .MuiToggleButton-root': {
          minHeight: 36,
          height: 36,
          overflow: 'hidden',
          textTransform: 'none',
          fontSize: 13,
          px: 2,
          py: 0,
          whiteSpace: 'nowrap',
          color: 'text.primary',
          backgroundColor: 'transparent',
          '&:hover': {
            backgroundColor: 'action.hover',
          },
          '&.Mui-selected': {
            backgroundColor: 'action.selected',
          },
          '&.Mui-selected:hover': {
            backgroundColor: 'action.selected',
          },
        },
      }) as const,
    [],
  );

  return (
    <Box>
      <Box className="flex items-center justify-between mb-2 gap-2">
        <Typography variant="subtitle2" className="font-semibold">
          {title}
        </Typography>
        {headerRight}
      </Box>
      <Box className="flex flex-wrap gap-2 items-center">
        <ToggleButtonGroup
          value={mode}
          exclusive
          onChange={(_, nextMode) => {
            if (isNullOrUndefined(nextMode)) return;
            onModeChange(nextMode as FeedFilterSelectionMode);
          }}
          size="small"
          sx={toggleGroupSx}
        >
          <ToggleButton value="include">{includeLabel}</ToggleButton>
          <ToggleButton value="exclude">{excludeLabel}</ToggleButton>
        </ToggleButtonGroup>
        <SearchableOptionAutocomplete
          multiple
          options={options as Unit[]}
          getOptionLabel={getUnitDisplayLabel}
          getStoredValue={getUnitFilterValue}
          value={selected as SearchableOptionSelection[]}
          onChange={onSelectedChange}
          placeholder={placeholder}
          disablePortal
          filterSelectedOptions
          className={autocompleteClassName ?? 'min-w-0 w-full min-[1024px]:min-w-[160px] min-[1024px]:flex-1'}
        />
      </Box>
    </Box>
  );
}
