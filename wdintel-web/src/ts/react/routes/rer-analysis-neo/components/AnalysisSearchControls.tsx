import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import ClearOutlinedIcon from '@mui/icons-material/ClearOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import { Autocomplete, InputAdornment, Popover, TextField, Tooltip } from '@mui/material';
import { useEffect, useId, useState, useTransition } from 'react';

import { PowerIconButton } from '../../../components/PowerIconButton';
import { ANALYSIS_SEARCH_DOC_URL, ANALYSIS_SEARCH_MODES } from '../config';
import type { AnalysisPageState } from '../types';

type SearchState = Pick<AnalysisPageState['queryState'], 'search' | 'searchMode'>;

type Props = {
  queryState: SearchState;
  updateQueryState: (updates: Partial<SearchState>) => void;
  isCompactLayout: boolean;
  onClose: () => void;
};

export function AnalysisSearchControls({
  queryState,
  updateQueryState,
  isCompactLayout,
  onClose,
}: Props) {
  const helpId = useId();
  const [helpAnchor, setHelpAnchor] = useState<HTMLElement | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [search, setSearch] = useState(queryState.search ?? '');
  const [searchPending, startSearchTransition] = useTransition();

  useEffect(() => {
    if (!searchPending) setSearch(queryState.search ?? '');
  }, [queryState.search, searchPending]);

  const updateSearch = (search: string) => {
    setSearch(search);
    startSearchTransition(() => updateQueryState({ search }));
  };

  return (
    <div className="flex min-w-0 items-center gap-echo-xs">
      <Autocomplete
        className={isCompactLayout ? 'w-[180px] min-w-0' : 'w-[220px] min-w-0'}
        freeSolo
        disableClearable
        forcePopupIcon={false}
        value=""
        inputValue={search}
        open={suggestionsOpen && search.trim().length > 0}
        onOpen={() => setSuggestionsOpen(true)}
        onClose={() => setSuggestionsOpen(false)}
        options={ANALYSIS_SEARCH_MODES}
        filterOptions={(options) => options}
        getOptionLabel={(option) =>
          typeof option === 'string' ? option : `${search} - ${option.label}`
        }
        renderOption={({ key, ...props }, option) => (
          <li
            key={key}
            {...props}
            aria-selected={option.mode === (queryState.searchMode ?? 'Fuzzy')}
          >
            <span>
              <em>{search}</em> - <strong>{option.label}</strong>
            </span>
          </li>
        )}
        onInputChange={(_event, value, reason) => {
          if (reason === 'input') {
            updateSearch(value.trim() === '' ? '' : value);
            setSuggestionsOpen(true);
          }
        }}
        onChange={(_event, option) => {
          if (option && typeof option !== 'string') {
            startSearchTransition(() => updateQueryState({ searchMode: option.mode }));
          }
        }}
        slotProps={{
          popper: { placement: 'bottom-start', className: 'w-max! max-w-[calc(100vw-24px)]' },
          listbox: { 'aria-label': 'Режим пошуку' },
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            autoFocus={isCompactLayout}
            placeholder="Пошук"
            size="small"
            inputProps={{ ...params.inputProps, 'aria-label': 'Пошук' }}
            InputProps={{
              ...params.InputProps,
              startAdornment: !isCompactLayout ? (
                <InputAdornment position="start">
                  <SearchOutlinedIcon fontSize="small" />
                </InputAdornment>
              ) : undefined,
              endAdornment:
                isCompactLayout || search ? (
                  <InputAdornment position="end">
                    <Tooltip
                      title={isCompactLayout ? 'Очистити й закрити пошук' : 'Очистити пошук'}
                      arrow
                    >
                      <PowerIconButton
                        aria-label={isCompactLayout ? 'Очистити й закрити пошук' : 'Очистити пошук'}
                        size="small"
                        onClick={() => {
                          setSuggestionsOpen(false);
                          if (isCompactLayout) {
                            setSearch('');
                            onClose();
                          } else updateSearch('');
                        }}
                      >
                        <ClearOutlinedIcon fontSize="small" />
                      </PowerIconButton>
                    </Tooltip>
                  </InputAdornment>
                ) : undefined,
            }}
          />
        )}
      />
      <Tooltip title="Режими пошуку" arrow>
        <PowerIconButton
          aria-label="Довідка про пошук"
          aria-expanded={Boolean(helpAnchor)}
          aria-controls={helpAnchor ? helpId : undefined}
          size="small"
          onClick={(event) => setHelpAnchor(event.currentTarget)}
        >
          <InfoOutlinedIcon fontSize="small" />
        </PowerIconButton>
      </Tooltip>
      <Popover
        id={helpId}
        open={Boolean(helpAnchor)}
        anchorEl={helpAnchor}
        onClose={() => setHelpAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <div className="max-w-[360px] p-echo-lg">
          <p>Пошук працює в 3 режимах. Наприклад, для запиту «рота»:</p>
          <ul>
            <li>Точний збіг: лише слово «рота»</li>
            <li>Гнучкий пошук: також «ротний», «роти»</li>
            <li>Збіг за входженням: також «воротар»</li>
          </ul>
          <a href={ANALYSIS_SEARCH_DOC_URL} target="_blank" rel="noopener noreferrer">
            Докладніше на сторінці документації
          </a>
        </div>
      </Popover>
    </div>
  );
}
