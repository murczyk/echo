import SearchIcon from '@mui/icons-material/Search';
import { InputAdornment, TextField } from '@mui/material';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import React, { useCallback, useRef, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';

const DEBOUNCE_MS = 200;
const MIN_LENGTH = 2;
const SEARCH_TEXT = 'Пошук...';

export type SearchInputProps = {
  placeholder?: string;
  onSearch: (value: string) => void;
  className?: string;
  resultsCount?: number | null;
  isSearchLoading?: boolean;
};

export function SearchInput(props: SearchInputProps) {
  const { placeholder = SEARCH_TEXT, onSearch, className, resultsCount = null, isSearchLoading = false } = props;
  const mode = useMuiPaletteMode();
  const theme = React.useMemo(() => createTheme({ palette: { mode } }), [mode]);
  const [value, setValue] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showResults = value.trim().length > 0 && (isSearchLoading || resultsCount !== null);
  const isSearchingLabel = isSearchLoading && (resultsCount === null || resultsCount === 0);

  const searchWithDebounce = useCallback(
    (inputValue: string) => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (inputValue.length < MIN_LENGTH) {
        onSearch(inputValue);
        return;
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        onSearch(inputValue);
      }, DEBOUNCE_MS);
    },
    [onSearch]
  );

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      setValue(next);
      searchWithDebounce(next);
    },
    [searchWithDebounce]
  );

  const handleClear = useCallback(() => {
    setValue('');
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    onSearch('');
  }, [onSearch]);

  React.useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <div className="analysis-map-search-wrap">
        <TextField
          className={className}
          placeholder={placeholder}
          value={value}
          onChange={handleChange}
          size="small"
          variant="outlined"
          sx={{
            backgroundColor: theme.palette.mode === 'dark' ? 'background.default' : 'background.paper',
            minWidth: 420,
          }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ color: value ? 'action.active' : 'action.disabled' }} />
              </InputAdornment>
            ),
            ...(value
              ? {
                  endAdornment: (
                    <InputAdornment position="end">
                      <button
                        type="button"
                        onClick={handleClear}
                        aria-label="Очистити"
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 4,
                          fontSize: '1rem',
                          lineHeight: 1,
                          color: theme.palette.text.secondary,
                        }}
                      >
                        ×
                      </button>
                    </InputAdornment>
                  ),
                }
              : {}),
          }}
        />
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

// web-component wrapper for SearchInput react component
class AnalysisMapSearchElement extends HTMLElement {
  static observedAttributes = ['results-count', 'search-loading'];
  private root: Root | null = null;
  private resultsCount: number | null = null;
  private isSearchLoading = false;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }
    this.resultsCount = this.parseResultsCount(this.getAttribute('results-count'));
    this.isSearchLoading = this.getAttribute('search-loading') === 'true';
    this.renderComponent();
  }

  private renderComponent() {
    if (!this.root) {
      return;
    }
    const onSearch = (value: string) => {
      this.dispatchEvent(new CustomEvent('search-points', { detail: value, bubbles: true, composed: true }));
    };
    this.root.render(
      <SearchInput
        placeholder="Точка, лісосмуга або координати (WGS84, MGRS)"
        onSearch={onSearch}
        resultsCount={this.resultsCount}
        isSearchLoading={this.isSearchLoading}
      />
    );
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null) {
    if (name !== 'results-count' && name !== 'search-loading') {
      return;
    }
    if (name === 'results-count') {
      this.resultsCount = this.parseResultsCount(newValue);
    }
    if (name === 'search-loading') {
      this.isSearchLoading = newValue === 'true';
    }
    this.renderComponent();
  }

  setResultsCount(count: number | null) {
    if (count === null || Number.isNaN(count)) {
      this.removeAttribute('results-count');
      return;
    }
    this.setAttribute('results-count', String(count));
  }

  setSearchLoading(isLoading: boolean) {
    if (isLoading) {
      this.setAttribute('search-loading', 'true');
      return;
    }
    this.removeAttribute('search-loading');
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }

  private parseResultsCount(value: string | null): number | null {
    if (value === null || value.trim() === '') {
      return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return null;
    }
    return parsed;
  }
}

if (!customElements.get('analysis-map-search')) {
  customElements.define('analysis-map-search', AnalysisMapSearchElement);
}
