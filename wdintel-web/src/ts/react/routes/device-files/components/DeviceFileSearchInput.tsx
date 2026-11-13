import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import {
  ButtonBase,
  ClickAwayListener,
  InputAdornment,
  Paper,
  Popper,
  TextField,
} from '@mui/material';
import { useId, useRef, useState } from 'react';
import { PowerIconButton } from '../../../components/PowerIconButton';
import type { DeviceFilesState } from '../use-device-files';

export function DeviceFileSearchInput({ files }: { files: DeviceFilesState }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLFormElement>(null);
  const popupId = useId();
  const search = (global = false) => {
    setOpen(false);
    files.submitSearch(global);
  };
  return (
    <ClickAwayListener onClickAway={() => setOpen(false)}>
      <form
        ref={anchor}
        className={`min-w-0 ${files.searchLocation || files.searchDraft.nameQuery ? 'w-64 max-echo-lg:w-40' : 'w-52 max-echo-lg:w-32 max-echo-sm:w-20'}`}
        onSubmit={(event) => {
          event.preventDefault();
          search();
        }}
      >
        <TextField
          size="small"
          fullWidth
          placeholder="Пошук файлів"
          value={files.searchDraft.nameQuery}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setOpen(true);
            files.setSearchDraft({ ...files.searchDraft, nameQuery: event.target.value });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
              requestAnimationFrame(() => {
                document
                  .getElementById(popupId)
                  ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
                  ?.focus();
              });
            }
          }}
          error={Boolean(files.searchValidationErrors.nameQuery)}
          inputProps={{
            'aria-label': 'Пошук файлів за назвою',
            'aria-controls': open ? popupId : undefined,
            'aria-expanded': open,
            'aria-haspopup': 'menu',
            onClick: () => setOpen(true),
            className: 'py-echo-xs!',
          }}
          InputProps={{
            sx: { height: 28, px: 1, fontSize: 'var(--echo-typography-font-size-lg)' },
            startAdornment: (
              <InputAdornment position="start" disablePointerEvents>
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
            endAdornment: (
              <InputAdornment position="end">
                {(files.searchLocation || files.searchDraft.nameQuery) && (
                  <PowerIconButton
                    size="small"
                    className="size-6!"
                    aria-label="Завершити пошук"
                    onClick={() => {
                      setOpen(false);
                      files.clearSearchResults();
                    }}
                  >
                    <CloseIcon fontSize="small" />
                  </PowerIconButton>
                )}
              </InputAdornment>
            ),
          }}
        />
        <Popper
          open={open}
          anchorEl={anchor.current}
          placement="bottom-start"
          sx={{ zIndex: (theme) => theme.zIndex.modal + 1 }}
          modifiers={[
            {
              name: 'sameWidth',
              enabled: true,
              phase: 'beforeWrite',
              requires: ['computeStyles'],
              fn: ({ state }) => {
                state.styles.popper.width = `${state.rects.reference.width}px`;
              },
            },
          ]}
        >
          <Paper
            elevation={3}
            id={popupId}
            role="menu"
            aria-label="Область пошуку"
            className="mt-echo-xs w-full"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                anchor.current?.querySelector('input')?.focus();
                setOpen(false);
              }
            }}
          >
            <ButtonBase
              type="button"
              role="menuitem"
              disabled={!files.searchDraft.nameQuery.trim()}
              onClick={() => search(true)}
              className="min-h-7! w-full! justify-start! rounded-echo-sm! px-echo-sm! py-echo-sm! text-left! text-[length:var(--echo-typography-font-size-xs)]! whitespace-normal! disabled:opacity-55"
            >
              Шукати на всьому пристрої
            </ButtonBase>
          </Paper>
        </Popper>
      </form>
    </ClickAwayListener>
  );
}
