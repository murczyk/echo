import SearchIcon from '@mui/icons-material/Search';
import {
  Box,
  FormControlLabel,
  FormGroup,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import dayjs from 'dayjs';

import { PowerButton } from '../../../components/PowerButton';
import { PowerDateTimePicker } from '../../../components/PowerDateTimePicker';
import { DeviceAnalyticsTagFilterControls } from './DeviceAnalyticsTagFilterControls';
import { createDefaultFileSearchDraft } from '../helpers';
import type {
  DeviceAnalyticsTagFilter,
  DeviceFileSearchDraft,
  DeviceFileSearchValidationErrors,
} from '../types';
import type { DeviceAnalyticsTagsState } from '../use-device-analytics-tags';

type Props = {
  draft: DeviceFileSearchDraft;
  validationErrors: DeviceFileSearchValidationErrors;
  scopeSelected: boolean;
  scopeLabel: string | null;
  searching: boolean;
  searchMode: boolean;
  tagsState: DeviceAnalyticsTagsState;
  tagFilter: DeviceAnalyticsTagFilter;
  onChange: (draft: DeviceFileSearchDraft) => void;
  onSearch: () => void;
  onBackToBrowse: () => void;
  onTagFilterChange: (filter: DeviceAnalyticsTagFilter) => void;
};

export function DeviceFileSearchControls({
  draft,
  validationErrors,
  scopeSelected,
  scopeLabel,
  searching,
  searchMode,
  tagsState,
  tagFilter,
  onChange,
  onSearch,
  onBackToBrowse,
  onTagFilterChange,
}: Props) {
  return (
    <Box component="section" aria-label="Пошук файлів">
      <Stack spacing={1.5}>
        <Typography variant="body2" color="text.secondary">
          {scopeLabel === null ? (
            'Оберіть каталог у файловому дереві.'
          ) : (
            <>
              Область пошуку:{' '}
              <Box component="span" sx={{ color: 'text.primary', overflowWrap: 'anywhere' }}>
                {scopeLabel}
              </Box>
            </>
          )}
        </Typography>
        <DeviceAnalyticsTagFilterControls
          tagsState={tagsState}
          filter={tagFilter}
          onChange={onTagFilterChange}
        />
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={1.5}
          alignItems={{ md: 'flex-start' }}
        >
          <TextField
            label="Назва містить"
            value={draft.nameQuery}
            onChange={(event) => onChange({ ...draft, nameQuery: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSearch();
            }}
            error={Boolean(validationErrors.nameQuery)}
            helperText={validationErrors.nameQuery ?? 'Літеральний пошук від 3 символів'}
            fullWidth
            size="small"
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
        </Stack>

        <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5} alignItems={{ lg: 'center' }}>
          <FormGroup row sx={{ flexWrap: 'nowrap' }}>
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
        </Stack>

        {validationErrors.modifiedRange ? (
          <Typography variant="caption" color="error">
            {validationErrors.modifiedRange}
          </Typography>
        ) : null}

        <Stack direction="row" spacing={1} justifyContent="flex-end" flexWrap="wrap" useFlexGap>
          <PowerButton
            size="small"
            onClick={() => onChange(createDefaultFileSearchDraft())}
            disabled={searching}
          >
            Очистити
          </PowerButton>
          {searchMode ? (
            <PowerButton size="small" onClick={onBackToBrowse} disabled={searching}>
              Сховати результати
            </PowerButton>
          ) : null}
          <PowerButton
            size="small"
            variant="contained"
            startIcon={<SearchIcon />}
            onClick={onSearch}
            disabled={!scopeSelected || searching}
          >
            Знайти
          </PowerButton>
        </Stack>
      </Stack>
    </Box>
  );
}
