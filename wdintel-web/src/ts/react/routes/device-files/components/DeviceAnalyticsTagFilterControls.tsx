import { Box, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material';

import type { AnalyticsTag, TagMatch } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerAutocomplete } from '../../../components/PowerAutocomplete';
import { PowerButton } from '../../../components/PowerButton';
import type { DeviceAnalyticsTagsState } from '../use-device-analytics-tags';
import type { DeviceAnalyticsTagFilter } from '../types';

export function DeviceAnalyticsTagFilterControls({
  tagsState,
  filter,
  onChange,
}: {
  tagsState: DeviceAnalyticsTagsState;
  filter: DeviceAnalyticsTagFilter;
  onChange: (filter: DeviceAnalyticsTagFilter) => void;
}) {
  const selectedTags = filter.tagIds
    .map((tagId) => tagsState.tags.find((tag) => tag.id === tagId))
    .filter((tag): tag is AnalyticsTag => tag !== undefined);

  return (
    <Box component="section" aria-labelledby="device-tag-filter-title">
      <Typography id="device-tag-filter-title" variant="subtitle2" sx={{ mb: 1 }}>
        Фільтр за тегами
      </Typography>
      {tagsState.error !== null ? (
        <PowerAlert
          severity="error"
          autoHideDuration={null}
          action={
            <PowerButton size="small" color="inherit" onClick={() => void tagsState.reload()}>
              Повторити
            </PowerButton>
          }
          sx={{ mb: 1 }}
        >
          {tagsState.error.message}
        </PowerAlert>
      ) : null}
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={1.5}
        alignItems={{ md: 'flex-start' }}
      >
        <PowerAutocomplete<AnalyticsTag>
          options={tagsState.tags}
          value={selectedTags}
          loading={tagsState.loading}
          disabled={filter.untagged || tagsState.error !== null}
          getOptionLabel={(tag) => tag.name}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          onChange={(_, tags) =>
            onChange({ ...filter, tagIds: tags.map((tag) => tag.id), untagged: false })
          }
          renderInput={(params) => (
            <TextField
              {...params}
              label="Теги"
              placeholder={tagsState.loading ? 'Завантаження…' : 'Оберіть теги'}
              size="small"
            />
          )}
          sx={{ minWidth: { md: 320 }, flex: 1 }}
        />
        <TextField
          select
          label="Збіг тегів"
          size="small"
          value={filter.tagMatch}
          disabled={filter.untagged || filter.tagIds.length < 2}
          onChange={(event) => onChange({ ...filter, tagMatch: event.target.value as TagMatch })}
          sx={{ minWidth: 150 }}
          SelectProps={{ native: true }}
        >
          <option value="any">Будь-який</option>
          <option value="all">Усі</option>
        </TextField>
        <FormControlLabel
          control={
            <Switch
              checked={filter.untagged}
              onChange={(_, checked) =>
                onChange({ ...filter, tagIds: checked ? [] : filter.tagIds, untagged: checked })
              }
            />
          }
          label="Без тегів"
          sx={{ minHeight: 40, m: 0, whiteSpace: 'nowrap' }}
        />
      </Stack>
    </Box>
  );
}
