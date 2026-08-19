import MoreVertIcon from '@mui/icons-material/MoreVert';
import {
  Autocomplete,
  Box,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import type { SxProps, Theme } from '@mui/material';
import type { AutocompleteProps } from '@mui/material/Autocomplete';
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { PowerButton } from './PowerButton';
import { PowerIconButton } from './PowerIconButton';
import { PowerMenu } from './PowerMenu';

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
  bulkPasteMenuLabel?: string;
  bulkPasteDialogTitle?: string;
  bulkPasteInputLabel?: string;
  bulkCopy?: boolean;
  bulkCopyMenuLabel?: string;
  onBulkCopy?: (selected: readonly T[]) => Promise<void> | void;
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
  inputValue: string;
  options: readonly T[];
  selectedValue: readonly T[];
  getOptionLabel: (option: T) => string;
  isOptionEqualToValue?: (option: T, value: T) => boolean;
  separators: string[];
}): BulkPasteResolution<T> {
  const { inputValue, options, selectedValue, getOptionLabel, isOptionEqualToValue, separators } =
    args;
  const tokens = splitBulkPasteValue(inputValue, separators);
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

function emptyBulkResolution<T>(selectedValue: readonly T[]): BulkPasteResolution<T> {
  return {
    tokens: [],
    found: [],
    missing: [],
    added: [],
    alreadySelected: [],
    finalValue: [...selectedValue],
  };
}

function formatPreviewValues<T>(values: T[], getOptionLabel: (option: T) => string): string {
  return values.map(getOptionLabel).join(', ');
}

function formatPreviewTokens(tokens: string[]): string {
  return tokens.join(', ');
}

function composeEndAdornment(endAdornment: ReactNode, menuButton: ReactNode): ReactNode {
  if (!isValidElement(endAdornment)) {
    return (
      <>
        {menuButton}
        {endAdornment}
      </>
    );
  }

  const children = Children.toArray(endAdornment.props.children);

  if (children.length === 0) {
    return cloneElement(endAdornment, {
      children: menuButton,
    });
  }

  const insertIndex = Math.max(children.length - 1, 0);
  const nextChildren = [
    ...children.slice(0, insertIndex),
    menuButton,
    ...children.slice(insertIndex),
  ];

  return cloneElement(endAdornment, {
    children: nextChildren,
  });
}

const BULK_AUTOCOMPLETE_SX: SxProps<Theme> = {
  '& .MuiAutocomplete-endAdornment': {
    display: 'flex',
    alignItems: 'center',
    gap: 0.5,
    top: '50%',
    transform: 'translateY(-50%)',
  },
  '& .MuiAutocomplete-clearIndicator': {
    display: 'none',
  },
  '&:hover .MuiAutocomplete-clearIndicator, &.Mui-focused .MuiAutocomplete-clearIndicator': {
    display: 'inline-flex',
  },
};

function mergeBulkAutocompleteSx(sx: AutocompleteProps<unknown, true, false, false>['sx']) {
  if (Array.isArray(sx)) {
    return [BULK_AUTOCOMPLETE_SX, ...sx];
  }
  if (sx == null) {
    return BULK_AUTOCOMPLETE_SX;
  }
  return [BULK_AUTOCOMPLETE_SX, sx];
}

export function PowerAutocomplete<T>(props: PowerAutocompleteProps<T>) {
  const {
    bulkPaste = false,
    bulkPasteSeparators = [','],
    bulkPasteMenuLabel,
    bulkPasteDialogTitle,
    bulkPasteInputLabel,
    bulkCopy = false,
    bulkCopyMenuLabel = 'Копіювати обрані значення',
    onBulkCopy,
    getBulkPasteOptionLabel,
    onBulkPasteChange,
    onBulkPasteResolved,
    renderInput,
    ...autocompleteProps
  } = props;
  const { onClose, sx } = autocompleteProps;
  const options = autocompleteProps.options;
  const value = autocompleteProps.value;
  const getOptionLabel = autocompleteProps.getOptionLabel ?? (() => '');
  const isOptionEqualToValue = autocompleteProps.isOptionEqualToValue;
  const onChange = autocompleteProps.onChange;
  const selectedValue = value ?? [];
  const hasBulkActions = bulkPaste || bulkCopy;
  const bulkPasteLabel = getBulkPasteOptionLabel ?? getOptionLabel;
  const menuLabel = bulkPasteMenuLabel ?? 'Додати кілька значень';
  const dialogTitle = bulkPasteDialogTitle ?? 'Додати кілька значень';
  const inputLabel = bulkPasteInputLabel ?? 'Значення';
  const [bulkMenuAnchorEl, setBulkMenuAnchorEl] = useState<HTMLElement | null>(null);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkDialogInputValue, setBulkDialogInputValue] = useState('');
  const [pendingBulkDialogOpen, setPendingBulkDialogOpen] = useState(false);
  const bulkMenuTriggerRef = useRef<HTMLElement | null>(null);

  const bulkPreview = useMemo(() => {
    if (!bulkPaste || !bulkDialogOpen) {
      return emptyBulkResolution(selectedValue);
    }

    return buildBulkResolution({
      inputValue: bulkDialogInputValue,
      options,
      selectedValue,
      getOptionLabel: bulkPasteLabel,
      isOptionEqualToValue,
      separators: bulkPasteSeparators,
    });
  }, [
    bulkDialogInputValue,
    bulkDialogOpen,
    bulkPaste,
    bulkPasteLabel,
    bulkPasteSeparators,
    isOptionEqualToValue,
    options,
    selectedValue,
  ]);

  useEffect(() => {
    if (!bulkPaste || !pendingBulkDialogOpen || bulkMenuAnchorEl != null) {
      return;
    }
    setPendingBulkDialogOpen(false);
    setBulkDialogInputValue('');
    setBulkDialogOpen(true);
  }, [bulkMenuAnchorEl, bulkPaste, pendingBulkDialogOpen]);

  useEffect(() => {
    if (!bulkPaste || !bulkDialogOpen) {
      return;
    }
    if (bulkDialogInputValue.trim().length === 0) {
      return;
    }
    onBulkPasteResolved?.(bulkPreview);
  }, [bulkDialogInputValue, bulkDialogOpen, bulkPaste, bulkPreview, onBulkPasteResolved]);

  const openBulkMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    bulkMenuTriggerRef.current = event.currentTarget;
    setBulkMenuAnchorEl(event.currentTarget);
  };

  const closeBulkMenu = () => {
    setBulkMenuAnchorEl(null);
  };

  const openBulkDialog = () => {
    bulkMenuTriggerRef.current = bulkMenuAnchorEl ?? bulkMenuTriggerRef.current;
    bulkMenuTriggerRef.current?.focus();
    closeBulkMenu();
    setPendingBulkDialogOpen(true);
  };

  const closeBulkDialog = () => {
    if (
      document.activeElement instanceof HTMLElement &&
      document.activeElement.closest('[role="dialog"]') != null
    ) {
      document.activeElement.blur();
    }

    setBulkDialogOpen(false);
    setBulkDialogInputValue('');
    setPendingBulkDialogOpen(false);

    const restoreFocusTarget = bulkMenuTriggerRef.current;
    window.setTimeout(() => {
      restoreFocusTarget?.focus();
    }, 0);
  };

  const submitBulkDialog = () => {
    if (bulkPreview.added.length === 0) {
      return;
    }

    if (onBulkPasteChange) {
      onBulkPasteChange(bulkPreview.finalValue);
    } else {
      onChange?.(null as never, bulkPreview.finalValue, 'selectOption', undefined);
    }

    closeBulkDialog();
  };

  const renderInputWithBulkAction = (params: Parameters<typeof renderInput>[0]) => {
    const endAdornment = params.InputProps?.endAdornment;
    const menuButton = (
      <PowerIconButton
        key="bulk-paste-menu"
        aria-label={menuLabel}
        disabled={autocompleteProps.disabled}
        size="small"
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={openBulkMenu}
      >
        <MoreVertIcon fontSize="small" />
      </PowerIconButton>
    );
    return renderInput({
      ...params,
      InputProps: {
        ...params.InputProps,
        endAdornment: hasBulkActions ? composeEndAdornment(endAdornment, menuButton) : endAdornment,
      },
    });
  };

  return (
    <>
      <Autocomplete<T, true, false, false>
        multiple
        {...autocompleteProps}
        onClose={onClose}
        sx={hasBulkActions ? mergeBulkAutocompleteSx(sx) : sx}
        renderInput={hasBulkActions ? renderInputWithBulkAction : renderInput}
      />
      {hasBulkActions ? (
        <>
          <PowerMenu
            anchorEl={bulkMenuAnchorEl}
            open={bulkMenuAnchorEl != null}
            onClose={closeBulkMenu}
          >
            {bulkPaste ? <MenuItem onClick={openBulkDialog}>{menuLabel}</MenuItem> : null}
            {bulkCopy ? (
              <MenuItem
                disabled={selectedValue.length === 0}
                onClick={() => {
                  closeBulkMenu();
                  void onBulkCopy?.(selectedValue);
                }}
              >
                {bulkCopyMenuLabel}
              </MenuItem>
            ) : null}
          </PowerMenu>
          {bulkPaste ? (
            <Dialog
              open={bulkDialogOpen}
              onClose={closeBulkDialog}
              fullWidth
              maxWidth="sm"
              disableRestoreFocus
            >
              <DialogTitle>{dialogTitle}</DialogTitle>
              <DialogContent sx={{ pt: 2.5, pb: 0, overflow: 'visible' }}>
                <Box sx={{ display: 'grid', gap: 2, pt: 1 }}>
                  <TextField
                    autoFocus
                    fullWidth
                    label={inputLabel}
                    multiline
                    minRows={4}
                    placeholder={formatBulkPastePlaceholder(bulkPasteSeparators)}
                    value={bulkDialogInputValue}
                    onChange={(event) => setBulkDialogInputValue(event.target.value)}
                  />
                  <Box sx={{ display: 'grid', gap: 1 }}>
                    {selectedValue.length > 0 ? (
                      <>
                        <Typography variant="subtitle2">Вже у фільтрі</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {formatPreviewValues(selectedValue, bulkPasteLabel)}
                        </Typography>
                      </>
                    ) : null}
                    {bulkPreview.added.length > 0 ? (
                      <>
                        <Typography variant="subtitle2">Буде додано</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {formatPreviewValues(bulkPreview.added, bulkPasteLabel)}
                        </Typography>
                      </>
                    ) : null}
                    {bulkPreview.alreadySelected.length > 0 ? (
                      <>
                        <Typography variant="subtitle2">Вже обрано</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {formatPreviewValues(bulkPreview.alreadySelected, bulkPasteLabel)}
                        </Typography>
                      </>
                    ) : null}
                    {bulkPreview.missing.length > 0 ? (
                      <>
                        <Typography variant="subtitle2">Не знайдено</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {formatPreviewTokens(bulkPreview.missing)}
                        </Typography>
                      </>
                    ) : null}
                  </Box>
                </Box>
              </DialogContent>
              <DialogActions>
                <PowerButton onClick={closeBulkDialog}>Скасувати</PowerButton>
                <PowerButton
                  variant="contained"
                  disabled={bulkPreview.added.length === 0}
                  onClick={submitBulkDialog}
                >
                  Додати
                </PowerButton>
              </DialogActions>
            </Dialog>
          ) : null}
        </>
      ) : null}
    </>
  );
}
