import { Box, ToggleButton, ToggleButtonGroup, TextField, Typography } from '@mui/material';
import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createRankedFilterOptions } from '../../utils/search-filter';
import { isNullOrUndefined } from '../../utils/misc';
import { PowerAutocomplete } from '../../components/PowerAutocomplete';

type FeedFilterSelectionMode = 'include' | 'exclude';

export type FeedFilterSelectionSectionProps<T> = {
  title: string;
  mode: FeedFilterSelectionMode;
  onModeChange: (mode: FeedFilterSelectionMode) => void;
  value: readonly T[];
  onValueChange: (value: T[]) => void;
  options: readonly T[];
  getOptionLabel: (option: T) => string;
  getOptionKey?: (option: T) => string;
  isOptionEqualToValue?: (option: T, value: T) => boolean;
  placeholder?: string;
  autocompleteClassName?: string;
  headerRight?: ReactNode;
  includeLabel?: string;
  excludeLabel?: string;
  rankedSearch?: boolean;
  keepOpenAndPreserveInputOnSelect?: boolean;
  loading?: boolean;
  loadingText?: string;
  noOptionsText?: string;
  clearText?: string;
  openText?: string;
  closeText?: string;
  keepOpenOnSelect?: boolean;
  preserveInputOnSelect?: boolean;
  onInputChange?: (value: string) => void;
  bulkPaste?: boolean;
  bulkPasteOptions?: readonly T[];
  bulkPasteSeparators?: string[];
  bulkPasteMenuLabel?: string;
  bulkPasteDialogTitle?: string;
  bulkPasteInputLabel?: string;
  bulkCopy?: boolean;
  bulkCopyMenuLabel?: string;
  onBulkCopy?: (selected: readonly T[]) => Promise<void> | void;
  getBulkPasteToken?: (option: T) => string;
  getBulkPasteAliases?: (option: T) => readonly string[];
  getBulkCopyText?: (selected: readonly T[]) => string;
};

export function FeedFilterSelectionSection<T>({
  title,
  mode,
  onModeChange,
  value,
  onValueChange,
  options,
  getOptionLabel,
  getOptionKey,
  isOptionEqualToValue,
  placeholder,
  autocompleteClassName,
  headerRight,
  includeLabel = 'лише',
  excludeLabel = 'окрім',
  rankedSearch = false,
  keepOpenAndPreserveInputOnSelect = false,
  loading = false,
  loadingText = 'Завантаження…',
  noOptionsText = 'Немає варіантів',
  clearText = 'Очистити',
  openText = 'Відкрити',
  closeText = 'Закрити',
  keepOpenOnSelect,
  preserveInputOnSelect,
  onInputChange,
  bulkPaste = false,
  bulkPasteOptions,
  bulkPasteSeparators,
  bulkPasteMenuLabel,
  bulkPasteDialogTitle,
  bulkPasteInputLabel,
  bulkCopy = false,
  bulkCopyMenuLabel,
  onBulkCopy,
  getBulkPasteToken,
  getBulkPasteAliases,
  getBulkCopyText,
}: FeedFilterSelectionSectionProps<T>) {
  const shouldKeepOpen = keepOpenOnSelect ?? keepOpenAndPreserveInputOnSelect;
  const shouldPreserveInput = preserveInputOnSelect ?? keepOpenAndPreserveInputOnSelect;
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
  const rankedFilterOptions = useMemo(
    () => (rankedSearch ? createRankedFilterOptions(getOptionLabel) : undefined),
    [getOptionLabel, rankedSearch],
  );
  const [inputValue, setInputValue] = useState('');
  const applyResetAfterSelectionRef = useRef(false);
  const lastNotifiedInputValueRef = useRef<string | undefined>(undefined);
  const updateInputValue = (nextValue: string) => {
    setInputValue(nextValue);
    if (lastNotifiedInputValueRef.current === nextValue) return;
    lastNotifiedInputValueRef.current = nextValue;
    onInputChange?.(nextValue);
  };
  const filterOptions = useMemo(() => {
    if (rankedFilterOptions == null) return undefined;
    if (!shouldPreserveInput) return rankedFilterOptions;
    return (availableOptions: T[]) => rankedFilterOptions(availableOptions, { inputValue });
  }, [inputValue, rankedFilterOptions, shouldPreserveInput]);

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
        <PowerAutocomplete
          size="small"
          options={options as T[]}
          getOptionLabel={getOptionLabel}
          value={value as T[]}
          inputValue={rankedSearch || shouldKeepOpen ? inputValue : undefined}
          onChange={(_, nextValue, reason) => {
            applyResetAfterSelectionRef.current = reason === 'selectOption';
            if (reason === 'selectOption' && shouldKeepOpen && !shouldPreserveInput) {
              updateInputValue('');
            }
            onValueChange(nextValue);
          }}
          bulkPaste={bulkPaste}
          bulkPasteOptions={bulkPasteOptions}
          bulkPasteSeparators={bulkPasteSeparators}
          bulkPasteMenuLabel={bulkPasteMenuLabel}
          bulkPasteDialogTitle={bulkPasteDialogTitle}
          bulkPasteInputLabel={bulkPasteInputLabel}
          bulkCopy={bulkCopy}
          bulkCopyMenuLabel={bulkCopyMenuLabel}
          onBulkCopy={onBulkCopy}
          getBulkPasteToken={getBulkPasteToken}
          getBulkPasteAliases={getBulkPasteAliases}
          getBulkCopyText={getBulkCopyText}
          onInputChange={
            rankedSearch || shouldKeepOpen
              ? (_, nextValue, reason) => {
                  if (shouldKeepOpen && reason === 'selectOption') {
                    applyResetAfterSelectionRef.current = false;
                    return;
                  }
                  if (reason === 'reset') {
                    if (applyResetAfterSelectionRef.current) {
                      applyResetAfterSelectionRef.current = false;
                      if (!shouldPreserveInput) {
                        updateInputValue(nextValue);
                      }
                    }
                    return;
                  }

                  updateInputValue(nextValue);
                }
              : undefined
          }
          disableCloseOnSelect={shouldKeepOpen}
          onClose={() => {
            if (shouldKeepOpen) {
              updateInputValue('');
            }
          }}
          loading={loading}
          loadingText={loadingText}
          noOptionsText={noOptionsText}
          clearText={clearText}
          openText={openText}
          closeText={closeText}
          isOptionEqualToValue={isOptionEqualToValue}
          filterOptions={filterOptions}
          filterSelectedOptions
          clearOnEscape
          disablePortal
          renderOption={(props, option) => (
            <li {...props} key={getOptionKey?.(option) ?? getOptionLabel(option)}>
              {getOptionLabel(option)}
            </li>
          )}
          renderInput={(params) => <TextField {...params} placeholder={placeholder} />}
          className={
            autocompleteClassName ?? 'min-w-0 w-full min-[1024px]:min-w-[180px] min-[1024px]:flex-1'
          }
        />
      </Box>
    </Box>
  );
}
