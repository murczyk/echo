import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import ClearOutlinedIcon from '@mui/icons-material/ClearOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import { Autocomplete, InputAdornment, Paper, Popover, TextField, Tooltip } from '@mui/material';
import type { PaperProps } from '@mui/material';
import { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react';

import { PowerIconButton } from '../../components/PowerIconButton';
import { PowerButton } from '../../components/PowerButton';
import type { AnalysisSearchMode } from '../../../../Bindings';

const DUTY_SEARCH_MODES: { mode: AnalysisSearchMode; label: string }[] = [
  { mode: 'Fuzzy', label: 'Гнучкий пошук' },
  { mode: 'Exact', label: 'Точний збіг' },
  { mode: 'Substring', label: 'Збіг за входженням' },
];

type SearchState = { search: string | null; searchMode: AnalysisSearchMode | null };

type Props = {
  queryState: SearchState;
  updateQueryState: (updates: Partial<SearchState>) => void;
  label?: string;
  autoFocus?: boolean;
  blurOnEnter?: boolean;
  panel?: boolean;
};

export function DutySearchControls({
  queryState,
  updateQueryState,
  label = 'Пошук',
  autoFocus = false,
  blurOnEnter = false,
  panel = false,
}: Props) {
  const helpId = useId();
  const [helpAnchor, setHelpAnchor] = useState<HTMLElement | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [search, setSearch] = useState(queryState.search ?? '');
  const [searchPending, startSearchTransition] = useTransition();
  const controlsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const SearchModesPaper = useCallback(
    (props: PaperProps) => (
      <Paper {...props}>
        <div>{props.children}</div>
        <div className="border-t border-solid border-echo-divider p-echo-xs">
          <PowerButton
            ref={helpButtonRef}
            size="small"
            fullWidth
            className="justify-start! normal-case! underline!"
            aria-haspopup="dialog"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setSuggestionsOpen(false);
              setHelpAnchor(controlsRef.current);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') {
                event.preventDefault();
                setSuggestionsOpen(false);
                inputRef.current?.focus();
              } else if (event.key === 'Tab') {
                if (event.shiftKey) event.preventDefault();
                else setSuggestionsOpen(false);
                inputRef.current?.focus();
              }
            }}
          >
            Як працює пошук
          </PowerButton>
        </div>
      </Paper>
    ),
    [],
  );

  useEffect(() => {
    if (!searchPending) setSearch(queryState.search ?? '');
  }, [queryState.search, searchPending]);

  const updateSearch = (search: string) => {
    setSearch(search);
    startSearchTransition(() => updateQueryState({ search }));
  };

  return (
    <div
      ref={controlsRef}
      className="flex min-w-0 items-center gap-echo-xs"
      onKeyDown={(event) => {
        if (
          blurOnEnter &&
          event.key === 'Enter' &&
          event.target === inputRef.current &&
          !event.nativeEvent.isComposing &&
          event.keyCode !== 229
        ) {
          event.preventDefault();
          inputRef.current?.blur();
        }
      }}
    >
      <Autocomplete
        className="w-full min-w-0"
        freeSolo
        disableClearable
        forcePopupIcon={false}
        value=""
        inputValue={search}
        open={suggestionsOpen && search.trim().length > 0}
        onOpen={() => setSuggestionsOpen(true)}
        onClose={(event, reason) => {
          if (
            panel &&
            reason === 'blur' &&
            'relatedTarget' in event &&
            event.relatedTarget === helpButtonRef.current
          )
            return;
          setSuggestionsOpen(false);
        }}
        onKeyDown={(event) => {
          if (
            panel &&
            event.key === 'Tab' &&
            !event.shiftKey &&
            event.target === inputRef.current &&
            helpButtonRef.current
          ) {
            event.preventDefault();
            helpButtonRef.current.focus();
          }
        }}
        slots={{ paper: panel ? SearchModesPaper : undefined }}
        options={DUTY_SEARCH_MODES}
        filterOptions={(options) => options}
        getOptionLabel={(option) =>
          typeof option === 'string' ? option : `${search} - ${option.label}`
        }
        renderOption={({ key, ...props }, option) => (
          <li
            key={key}
            {...props}
            data-search-mode-option
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
            autoFocus={autoFocus}
            inputRef={inputRef}
            placeholder={label}
            size="small"
            inputProps={{
              ...params.inputProps,
              'aria-label': label,
              enterKeyHint: blurOnEnter ? 'search' : undefined,
            }}
            InputProps={{
              ...params.InputProps,
              startAdornment: (
                <InputAdornment position="start">
                  <SearchOutlinedIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment:
                search || panel ? (
                  <InputAdornment position="end">
                    <Tooltip title="Очистити пошук" arrow>
                      <PowerIconButton
                        aria-label="Очистити пошук"
                        size="small"
                        onClick={() => {
                          setSuggestionsOpen(false);
                          updateSearch('');
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
      {!panel ? (
        <Tooltip title="Режими пошуку" arrow>
          <PowerIconButton
            aria-label={label === 'Пошук' ? 'Довідка про пошук' : 'Довідка про фільтр'}
            aria-expanded={Boolean(helpAnchor)}
            aria-controls={helpAnchor ? helpId : undefined}
            size="small"
            onClick={(event) => setHelpAnchor(event.currentTarget)}
          >
            <InfoOutlinedIcon fontSize="small" />
          </PowerIconButton>
        </Tooltip>
      ) : null}
      <Popover
        id={helpId}
        open={Boolean(helpAnchor)}
        anchorEl={helpAnchor}
        disableRestoreFocus={panel}
        onClose={() => {
          setHelpAnchor(null);
          if (panel) requestAnimationFrame(() => inputRef.current?.focus());
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={
          panel ? { paper: { role: 'dialog', 'aria-label': 'Як працює пошук' } } : undefined
        }
      >
        <div className="max-w-[360px] p-echo-lg">
          <p>Пошук працює в 3 режимах. Наприклад, для запиту «рота»:</p>
          <ul>
            <li>Точний збіг: лише слово «рота»</li>
            <li>Гнучкий пошук: також «ротний», «роти»</li>
            <li>Збіг за входженням: також «воротар»</li>
          </ul>
        </div>
      </Popover>
    </div>
  );
}
