import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import { CircularProgress, IconButton, InputAdornment, TextField } from '@mui/material';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import React, { useCallback, useRef, useState } from 'react';

const DEFAULT_DEBOUNCE_MS = 300;
const SEARCH_TEXT = 'Пошук...';

export type SearchInputProps = {
  initialValue?: string;
  placeholder?: string;
  onSearch: (value: string) => void;
  className?: string;
  resultsCount?: number | null;
  isSearchLoading?: boolean;
  debounceMs?: number;
  minWidth?: number;
  clearOnEscape?: boolean;
  emptyEndAdornment?: React.ReactNode;
};

export function SearchInput(props: SearchInputProps) {
  const {
    initialValue,
    placeholder = SEARCH_TEXT,
    onSearch,
    className,
    resultsCount = null,
    isSearchLoading = false,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    minWidth = 300,
    clearOnEscape = true,
    emptyEndAdornment,
  } = props;

  const mode = useMuiPaletteMode();
  const theme = React.useMemo(
    () =>
      createTheme({
        palette: { mode },
        typography: {
          fontFamily:
            'var(--bs-body-font-family, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif)',
        },
      }),
    [mode],
  );

  const [value, setValue] = useState(initialValue ?? '');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearchRef = useRef(onSearch);
  const lastAppliedInitialValueRef = useRef<string | undefined>(undefined);
  const showResults = value.trim().length > 0 && (isSearchLoading || resultsCount !== null);
  const isSearchingLabel = isSearchLoading && (resultsCount === null || resultsCount === 0);

  const searchWithDebounce = useCallback(
    (inputValue: string) => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        onSearch(inputValue);
      }, debounceMs);
    },
    [debounceMs, onSearch],
  );

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      setValue(next);
      searchWithDebounce(next);
    },
    [searchWithDebounce],
  );

  const handleClear = useCallback(() => {
    setValue('');
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    onSearch('');
  }, [onSearch]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (!clearOnEscape || event.key !== 'Escape') {
        return;
      }
      if (value === '') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      handleClear();
    },
    [clearOnEscape, handleClear, value],
  );

  React.useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    onSearchRef.current = onSearch;
  }, [onSearch]);

  React.useEffect(() => {
    if (initialValue === undefined) {
      return;
    }
    if (lastAppliedInitialValueRef.current === initialValue) {
      return;
    }
    lastAppliedInitialValueRef.current = initialValue;
    setValue(initialValue);
    onSearchRef.current(initialValue);
  }, [initialValue]);

  return (
    <ThemeProvider theme={theme}>
      <div className="analysis-map-search-wrap">
        <div className="flex flex-row items-center">
          <TextField
            className={className}
            placeholder={placeholder}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            size="small"
            variant="outlined"
            sx={{
              minWidth,
              '& .MuiOutlinedInput-root': {
                minHeight: 48,
                height: 48,
                borderRadius: 2,
                backgroundColor: 'background.paper',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                '& .MuiOutlinedInput-notchedOutline': {
                  borderColor: 'divider',
                },
                '&:hover .MuiOutlinedInput-notchedOutline': {
                  borderColor: 'divider',
                },
                '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                  borderColor: 'primary.main',
                  borderWidth: 1,
                },
              },
            }}
            InputProps={{
              sx: {
                height: 48,
                '& .MuiInputBase-input': {
                  fontSize: 14,
                  lineHeight: '20px',
                  boxSizing: 'border-box',
                  padding: '13px 8px 13px 0 !important',
                },
                '& .MuiInputAdornment-root': {
                  maxHeight: 48,
                },
              },
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ color: value ? 'text.primary' : 'text.secondary' }} />
                </InputAdornment>
              ),
              ...(value
                ? {
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          edge="end"
                          onClick={handleClear}
                          aria-label="Очистити"
                          size="small"
                          sx={{ color: 'text.secondary' }}
                        >
                          <CloseIcon fontSize="small" />
                        </IconButton>
                      </InputAdornment>
                    ),
                  }
                : {
                    endAdornment: isSearchLoading ? (
                      <InputAdornment position="end">
                        <CircularProgress size={16} thickness={5} />
                      </InputAdornment>
                    ) : emptyEndAdornment ? (
                      <InputAdornment position="end">{emptyEndAdornment}</InputAdornment>
                    ) : undefined,
                  }),
            }}
          />
        </div>
        {showResults ? (
          <div className="analysis-map-search-results-count" role="status" aria-live="polite" aria-atomic="true">
            {isSearchingLabel ? SEARCH_TEXT : `Знайдено: ${resultsCount}`}
          </div>
        ) : null}
      </div>
    </ThemeProvider>
  );
}

function getMuiPaletteMode(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'dark' : 'light';
}

function useMuiPaletteMode() {
  const [mode, setMode] = React.useState(getMuiPaletteMode);

  React.useEffect(() => {
    const observer = new MutationObserver(() => setMode(getMuiPaletteMode()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-bs-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return mode;
}
