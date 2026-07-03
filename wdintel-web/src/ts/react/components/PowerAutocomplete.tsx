import { Autocomplete, Box, Paper, TextField } from '@mui/material';
import type { AutocompleteCloseReason, AutocompleteProps } from '@mui/material/Autocomplete';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent } from 'react';
import type { HTMLAttributes } from 'react';

type BulkPasteResolution<T> = {
  tokens: string[];
  found: T[];
  missing: string[];
  added: T[];
  alreadySelected: T[];
  finalValue: T[];
};

type PowerAutocompleteProps<T> = Omit<
  AutocompleteProps<T, true, false, false>,
  'multiple' | 'renderInput'
> & {
  renderInput: AutocompleteProps<T, true, false, false>['renderInput'];
  bulkPaste?: boolean;
  bulkPasteSeparators?: string[];
  getBulkPasteOptionLabel?: (option: T) => string;
  onBulkPasteChange?: (nextValue: T[]) => void;
  onBulkPasteResolved?: (result: BulkPasteResolution<T>) => void;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeBulkToken(value: string): string {
  return value.trim().toLowerCase();
}

function formatBulkSeparator(separator: string): string {
  if (separator === '\n') return 'список з нового рядка';
  return `"${separator}"`;
}

export function formatBulkPastePlaceholder(separators: string[]): string {
  const filteredSeparators = separators.filter((separator) => separator.length > 0);

  if (filteredSeparators.length === 0) {
    return 'Вставте значення';
  }

  if (filteredSeparators.length === 1 && filteredSeparators[0] === '\n') {
    return 'Вставте список з нового рядка';
  }

  if (filteredSeparators.includes('\n')) {
    if (filteredSeparators.length === 2 && filteredSeparators.includes(',')) {
      return 'Вставте CSV або список з нового рядка';
    }
    const textSeparators = filteredSeparators.filter((separator) => separator !== '\n');
    if (textSeparators.length === 0) {
      return 'Вставте список з нового рядка';
    }
    return `Вставте значення через ${textSeparators.map(formatBulkSeparator).join(' або ')} або список з нового рядка`;
  }

  if (filteredSeparators.length === 1) {
    return `Вставте значення через ${formatBulkSeparator(filteredSeparators[0])}`;
  }

  const lastSeparator = filteredSeparators[filteredSeparators.length - 1];
  const headSeparators = filteredSeparators.slice(0, -1).map(formatBulkSeparator).join(', ');
  return `Вставте значення через ${headSeparators} або ${formatBulkSeparator(lastSeparator)}`;
}

function splitBulkPasteValue(value: string, separators: string[]): string[] {
  const filteredSeparators = separators.filter((separator) => separator.length > 0);
  if (filteredSeparators.length === 0) {
    return value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  const separatorPattern = new RegExp(
    filteredSeparators
      .slice()
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join('|'),
    'g',
  );

  return value
    .split(separatorPattern)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function areOptionsEqual<T>(
  option: T,
  value: T,
  isOptionEqualToValue?: (option: T, value: T) => boolean,
): boolean {
  return isOptionEqualToValue ? isOptionEqualToValue(option, value) : option === value;
}

function containsOption<T>(
  selection: readonly T[],
  option: T,
  isOptionEqualToValue?: (option: T, value: T) => boolean,
): boolean {
  return selection.some((value) => areOptionsEqual(option, value, isOptionEqualToValue));
}

function eventRelatedTarget(event: unknown): unknown {
  if (typeof event !== 'object' || event === null || !('relatedTarget' in event)) {
    return null;
  }

  return (event as { relatedTarget?: unknown }).relatedTarget ?? null;
}

function isInsideBulkPasteContainer(
  relatedTarget: unknown,
  bulkPasteContainer: HTMLDivElement | null,
): boolean {
  if (relatedTarget == null || typeof relatedTarget !== 'object') {
    return false;
  }

  try {
    if (bulkPasteContainer?.contains(relatedTarget as Node)) {
      return true;
    }
  } catch {
    // Ignore non-Node blur targets.
  }

  return (
    typeof (relatedTarget as Element).closest === 'function' &&
    (relatedTarget as Element).closest('[data-bulk-paste-container="true"]') !== null
  );
}

function eventTargetIsInside(target: EventTarget | null, element: HTMLElement | null): boolean {
  if (target == null || element == null) {
    return false;
  }

  try {
    return element.contains(target as Node);
  } catch {
    return false;
  }
}

function isBulkPasteActiveElementInListbox(listboxRef: { current: HTMLElement | null }): boolean {
  return listboxRef.current?.contains(document.activeElement) ?? false;
}

function mergeBulkSelection<T>(
  currentValue: readonly T[],
  matchedOptions: T[],
  isOptionEqualToValue?: (option: T, value: T) => boolean,
): { added: T[]; alreadySelected: T[]; finalValue: T[] } {
  const finalValue = [...currentValue];
  const added: T[] = [];
  const alreadySelected: T[] = [];

  matchedOptions.forEach((option) => {
    if (containsOption(finalValue, option, isOptionEqualToValue)) {
      alreadySelected.push(option);
      return;
    }
    finalValue.push(option);
    added.push(option);
  });

  return { added, alreadySelected, finalValue };
}

function buildBulkResolution<T>(args: {
  tokens: string[];
  options: readonly T[];
  selectedValue: readonly T[];
  getOptionLabel: (option: T) => string;
  isOptionEqualToValue?: (option: T, value: T) => boolean;
}): BulkPasteResolution<T> {
  const { tokens, options, selectedValue, getOptionLabel, isOptionEqualToValue } = args;
  const lookup = new Map<string, T>();

  options.forEach((option) => {
    lookup.set(normalizeBulkToken(getOptionLabel(option)), option);
  });

  const found: T[] = [];
  const missing: string[] = [];

  tokens.forEach((token) => {
    const matchedOption = lookup.get(normalizeBulkToken(token));
    if (matchedOption) {
      found.push(matchedOption);
      return;
    }
    missing.push(token);
  });

  const merged = mergeBulkSelection(selectedValue, found, isOptionEqualToValue);
  return {
    tokens,
    found,
    missing,
    added: merged.added,
    alreadySelected: merged.alreadySelected,
    finalValue: merged.finalValue,
  };
}

function splitBulkPasteTokens(pastedValue: string, separators: string[]): string[] {
  return splitBulkPasteValue(pastedValue, separators);
}

export function PowerAutocomplete<T>(props: PowerAutocompleteProps<T>) {
  const {
    bulkPaste = false,
    bulkPasteSeparators = [','],
    getBulkPasteOptionLabel,
    onBulkPasteChange,
    onBulkPasteResolved,
    PaperComponent,
    renderInput,
    ...autocompleteProps
  } = props;
  const { onClose, ...autocompletePropsWithoutClose } = autocompleteProps;
  const options = autocompleteProps.options;
  const value = autocompleteProps.value;
  const loading = autocompleteProps.loading;
  const open = autocompleteProps.open;
  const getOptionLabel = autocompleteProps.getOptionLabel;
  const isOptionEqualToValue = autocompleteProps.isOptionEqualToValue;
  const onChange = autocompleteProps.onChange;
  const unstableIsActiveElementInListbox = autocompleteProps.unstable_isActiveElementInListbox;
  const selectedValue = value ?? [];
  const optionLabel = getOptionLabel ?? (() => '');
  const bulkPasteLabel = getBulkPasteOptionLabel ?? optionLabel;
  const autocompleteRootRef = useRef<HTMLDivElement | null>(null);
  const bulkPastePaperRef = useRef<HTMLDivElement | null>(null);
  const bulkPasteContainerRef = useRef<HTMLDivElement | null>(null);
  const [bulkInputValue, setBulkInputValue] = useState('');
  const bulkStateRef = useRef<{
    bulkInputValue: string;
    setBulkInputValue: (nextValue: string) => void;
    processBulkPaste: (pastedValue: string) => void;
    placeholder: string;
    loading: boolean;
  } | null>(null);

  const processBulkPaste = (pastedValue: string) => {
    if (loading) return;

    const tokens = splitBulkPasteValue(pastedValue, bulkPasteSeparators);
    if (tokens.length < 2) return;

    const result = buildBulkResolution({
      tokens,
      options,
      selectedValue,
      getOptionLabel: bulkPasteLabel,
      isOptionEqualToValue,
    });
    onBulkPasteResolved?.(result);

    if (result.added.length === 0) {
      bulkStateRef.current?.setBulkInputValue(
        result.missing.length > 0 ? result.missing.join(bulkPasteSeparators[0] ?? ',') : '',
      );
      return;
    }

    const nextValue = result.finalValue;
    if (onBulkPasteChange) {
      onBulkPasteChange(nextValue);
    } else {
      onChange?.(null as never, nextValue, 'selectOption', undefined);
    }

    bulkStateRef.current?.setBulkInputValue(
      result.missing.length > 0 ? result.missing.join(bulkPasteSeparators[0] ?? ',') : '',
    );
  };

  bulkStateRef.current = {
    bulkInputValue,
    setBulkInputValue,
    processBulkPaste,
    placeholder: formatBulkPastePlaceholder(bulkPasteSeparators),
    loading: Boolean(loading),
  };

  const handleBulkInputPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    if (event.defaultPrevented) {
      return;
    }

    const bulkState = bulkStateRef.current;
    if (!bulkState) {
      return;
    }

    const pastedValue = event.clipboardData.getData('text/plain');
    const tokens = splitBulkPasteTokens(pastedValue, bulkPasteSeparators);
    if (bulkState.loading || tokens.length < 2) {
      event.preventDefault();
      bulkState.setBulkInputValue(pastedValue);
      return;
    }

    event.preventDefault();
    bulkState.processBulkPaste(pastedValue);
  };

  const BulkPastePaper = useMemo(
    () =>
      function BulkPastePaper(paperProps: HTMLAttributes<HTMLElement>) {
        const bulkState = bulkStateRef.current;
        if (!bulkPaste || !bulkState) {
          return <Paper {...paperProps} />;
        }

        return (
          <Paper
            {...paperProps}
            ref={bulkPastePaperRef}
            elevation={8}
            sx={{
              overflow: 'hidden',
              backgroundColor: 'background.paper',
              color: 'text.primary',
              border: 1,
              borderColor: 'divider',
            }}
          >
            <Box
              ref={bulkPasteContainerRef}
              data-bulk-paste-container="true"
              sx={{
                p: 1,
                borderBottom: 1,
                borderColor: 'divider',
                backgroundColor: 'background.paper',
              }}
            >
              <TextField
                size="small"
                value={bulkState.bulkInputValue}
                placeholder={bulkState.placeholder}
                onPaste={handleBulkInputPaste}
                onChange={(event) => bulkState.setBulkInputValue(event.target.value)}
                inputProps={{
                  onPaste: handleBulkInputPaste,
                }}
                disabled={bulkState.loading}
                fullWidth
              />
            </Box>
            {paperProps.children}
          </Paper>
        );
      },
    [bulkPaste, bulkPasteSeparators],
  );

  const handleClose = (event: unknown, reason: AutocompleteCloseReason) => {
    if (reason === 'blur') {
      const relatedTarget = eventRelatedTarget(event);
      if (isInsideBulkPasteContainer(relatedTarget, bulkPasteContainerRef.current)) {
        return;
      }
    }

    onClose?.(event as never, reason);
  };

  useEffect(() => {
    if (!bulkPaste || !open) return undefined;

    const handleDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        eventTargetIsInside(target, autocompleteRootRef.current) ||
        eventTargetIsInside(target, bulkPastePaperRef.current)
      ) {
        return;
      }

      onClose?.(event as never, 'blur');
    };

    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
    };
  }, [bulkPaste, onClose, open]);

  return (
    <Box ref={autocompleteRootRef}>
      <Autocomplete<T, true, false, false>
        multiple
        {...autocompletePropsWithoutClose}
        onClose={handleClose}
        unstable_isActiveElementInListbox={
          bulkPaste ? isBulkPasteActiveElementInListbox : unstableIsActiveElementInListbox
        }
        renderInput={renderInput}
        PaperComponent={bulkPaste ? BulkPastePaper : PaperComponent}
      />
    </Box>
  );
}
