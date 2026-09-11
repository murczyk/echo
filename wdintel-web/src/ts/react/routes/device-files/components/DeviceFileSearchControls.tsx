import FilterAltIcon from '@mui/icons-material/FilterAlt';
import SearchIcon from '@mui/icons-material/Search';
import { Collapse, FormControlLabel, FormGroup, Switch, TextField } from '@mui/material';
import { useState } from 'react';
import dayjs from 'dayjs';

import { PowerButton } from '../../../components/PowerButton';
import { PowerDateTimePicker } from '../../../components/PowerDateTimePicker';
import { createDefaultFileSearchDraft } from '../helpers';
import type {
  DeviceAnalyticsTagFilter,
  DeviceFileSearchDraft,
  DeviceFileSearchValidationErrors,
} from '../types';
import type { DeviceAnalyticsTagsState } from '../use-device-analytics-tags';
import { DeviceAnalyticsTagFilterControls } from './DeviceAnalyticsTagFilterControls';

const ADVANCED_FILTERS_ID = 'device-file-search-advanced-filters';

type Props = {
  draft: DeviceFileSearchDraft;
  validationErrors: DeviceFileSearchValidationErrors;
  scopeSelected: boolean;
  scopeLabel: string | null;
  rootScopeLabel: string | null;
  searching: boolean;
  searchActive: boolean;
  tagsState: DeviceAnalyticsTagsState;
  tagFilter: DeviceAnalyticsTagFilter;
  onChange: (draft: DeviceFileSearchDraft) => void;
  onSearch: () => void;
  onHideResults: () => void;
  onResetScopeToRoot: () => void;
  onTagFilterChange: (filter: DeviceAnalyticsTagFilter) => void;
};

export function DeviceFileSearchControls({
  draft,
  validationErrors,
  scopeSelected,
  scopeLabel,
  rootScopeLabel,
  searching,
  searchActive,
  tagsState,
  tagFilter,
  onChange,
  onSearch,
  onHideResults,
  onResetScopeToRoot,
  onTagFilterChange,
}: Props) {
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);

  return (
    <section aria-label="Пошук файлів" className="min-w-0">
      <form
        className="min-w-0 space-y-echo-md"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch();
        }}
      >
        <div className="flex min-w-0 flex-col items-start gap-echo-xs">
          <p className="m-0 min-w-0 text-echo-sm text-echo-text-muted">
            {scopeLabel === null ? (
              'Оберіть каталог у файловому дереві.'
            ) : (
              <>
                Область пошуку:{' '}
                <span className="text-echo-text [overflow-wrap:anywhere]">{scopeLabel}</span>
              </>
            )}
          </p>
          {rootScopeLabel !== null ? (
            <PowerButton type="button" size="small" onClick={onResetScopeToRoot}>
              Шукати від кореня {rootScopeLabel}
            </PowerButton>
          ) : null}
        </div>

        <TextField
          label="Назва містить"
          value={draft.nameQuery}
          onChange={(event) => onChange({ ...draft, nameQuery: event.target.value })}
          error={Boolean(validationErrors.nameQuery)}
          helperText={validationErrors.nameQuery ?? 'Літеральний пошук від 3 символів'}
          fullWidth
          size="small"
        />

        <div className="flex min-w-0 flex-wrap items-center justify-between gap-echo-sm">
          <PowerButton
            type="button"
            size="small"
            startIcon={<FilterAltIcon />}
            aria-expanded={advancedFiltersOpen}
            aria-controls={ADVANCED_FILTERS_ID}
            onClick={() => setAdvancedFiltersOpen((current) => !current)}
          >
            {advancedFiltersOpen ? 'Сховати додаткові фільтри' : 'Показати додаткові фільтри'}
          </PowerButton>
          <div className="flex min-w-0 flex-wrap justify-end gap-echo-sm">
            <PowerButton
              type="button"
              size="small"
              onClick={() => onChange(createDefaultFileSearchDraft())}
              disabled={searching}
            >
              Очистити
            </PowerButton>
            {searchActive ? (
              <PowerButton type="button" size="small" onClick={onHideResults} disabled={searching}>
                Сховати результати
              </PowerButton>
            ) : null}
            <PowerButton
              type="submit"
              size="small"
              variant="contained"
              startIcon={<SearchIcon />}
              disabled={!scopeSelected || searching}
            >
              Знайти
            </PowerButton>
          </div>
        </div>

        <Collapse id={ADVANCED_FILTERS_ID} in={advancedFiltersOpen} timeout="auto">
          <div className="min-w-0 space-y-echo-md pt-echo-sm">
            <DeviceAnalyticsTagFilterControls
              compact
              tagsState={tagsState}
              filter={tagFilter}
              onChange={onTagFilterChange}
            />
            <TextField
              label="MIME-типи"
              value={draft.mimeTypes}
              onChange={(event) => onChange({ ...draft, mimeTypes: event.target.value })}
              helperText="Через кому"
              fullWidth
              size="small"
            />
            <TextField
              label="Розширення"
              value={draft.extensions}
              onChange={(event) => onChange({ ...draft, extensions: event.target.value })}
              helperText="Через кому"
              fullWidth
              size="small"
            />
            <FormGroup row aria-label="Тип запису">
              {(['directory', 'file'] as const).map((kind) => (
                <FormControlLabel
                  key={kind}
                  control={
                    <Switch
                      size="small"
                      checked={draft.kinds.includes(kind)}
                      onChange={(_, checked) =>
                        onChange({
                          ...draft,
                          kinds: checked
                            ? [...draft.kinds, kind]
                            : draft.kinds.filter((item) => item !== kind),
                        })
                      }
                    />
                  }
                  label={kind === 'directory' ? 'Каталоги' : 'Файли'}
                />
              ))}
            </FormGroup>
            <PowerDateTimePicker
              label="Змінено від"
              value={draft.modifiedFrom === null ? null : dayjs(draft.modifiedFrom)}
              allowEmpty
              onChange={(value) =>
                onChange({
                  ...draft,
                  modifiedFrom: value?.isValid() ? value.toISOString() : null,
                })
              }
              slotProps={{ textField: { size: 'small', fullWidth: true } }}
            />
            <PowerDateTimePicker
              label="Змінено до"
              value={draft.modifiedTo === null ? null : dayjs(draft.modifiedTo)}
              allowEmpty
              onChange={(value) =>
                onChange({
                  ...draft,
                  modifiedTo: value?.isValid() ? value.toISOString() : null,
                })
              }
              slotProps={{ textField: { size: 'small', fullWidth: true } }}
            />
            {validationErrors.modifiedRange ? (
              <p className="m-0 text-echo-xs text-echo-error" role="alert">
                {validationErrors.modifiedRange}
              </p>
            ) : null}
          </div>
        </Collapse>
      </form>
    </section>
  );
}
