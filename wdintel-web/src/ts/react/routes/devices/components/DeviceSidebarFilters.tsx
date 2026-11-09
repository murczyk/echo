import { Autocomplete, Stack, TextField, createFilterOptions } from '@mui/material';

import type { DeviceCreatorFilterOption, DeviceFilterOptions } from '../../../../../Bindings';
import type { DeviceSidebarFilterState } from '../helpers';

const filterCreators = createFilterOptions<DeviceCreatorFilterOption>({
  stringify: (creator) => `${creator.displayName ?? ''} ${creator.login}`,
});

export function DeviceSidebarFilters({
  filters,
  options,
  loading,
  onChange,
}: {
  filters: DeviceSidebarFilterState;
  options: DeviceFilterOptions;
  loading: boolean;
  onChange: (next: DeviceSidebarFilterState) => void;
}) {
  const aors = [...options.aors];
  for (const id of filters.aorIds) {
    if (!aors.some((aor) => aor.id === id)) aors.push({ id, name: `Смуга #${id}` });
  }
  const creators = [...options.creators];
  for (const login of filters.createdBy) {
    if (!creators.some((creator) => creator.login === login))
      creators.push({ login, displayName: null });
  }
  creators.sort((left, right) => creatorLabel(left).localeCompare(creatorLabel(right), 'uk'));
  const tags = [...options.tags];
  for (const tag of filters.tags) {
    if (!tags.some((option) => option.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }

  return (
    <Stack spacing={2}>
      <Autocomplete
        multiple
        disableCloseOnSelect
        fullWidth
        size="small"
        limitTags={1}
        loading={loading}
        options={aors}
        value={aors.filter((aor) => filters.aorIds.includes(aor.id))}
        getOptionLabel={(aor) => aor.name}
        getOptionKey={(aor) => aor.id}
        isOptionEqualToValue={(option, value) => option.id === value.id}
        onChange={(_, selected) => onChange({ ...filters, aorIds: selected.map((aor) => aor.id) })}
        clearText="Очистити смуги"
        noOptionsText="Смуг не знайдено"
        renderInput={(params) => <TextField {...params} label="Смуги" />}
      />
      <Autocomplete
        multiple
        disableCloseOnSelect
        fullWidth
        size="small"
        limitTags={1}
        loading={loading}
        options={creators}
        value={creators.filter((creator) => filters.createdBy.includes(creator.login))}
        getOptionLabel={creatorLabel}
        getOptionKey={(creator) => creator.login}
        filterOptions={filterCreators}
        isOptionEqualToValue={(option, value) => option.login === value.login}
        onChange={(_, selected) =>
          onChange({ ...filters, createdBy: selected.map((creator) => creator.login) })
        }
        clearText="Очистити створювачів"
        noOptionsText="Створювачів не знайдено"
        renderInput={(params) => <TextField {...params} label="Створив" />}
      />
      <Autocomplete
        multiple
        disableCloseOnSelect
        fullWidth
        size="small"
        limitTags={1}
        loading={loading}
        options={tags}
        value={tags.filter((tag) =>
          filters.tags.some((value) => value.toLowerCase() === tag.toLowerCase()),
        )}
        isOptionEqualToValue={(option, value) => option.toLowerCase() === value.toLowerCase()}
        onChange={(_, tags) => onChange({ ...filters, tags })}
        clearText="Очистити теги"
        noOptionsText="Тегів не знайдено"
        renderInput={(params) => (
          <TextField {...params} label="Теги" helperText="Будь-який з вибраних тегів" />
        )}
      />
    </Stack>
  );
}

function creatorLabel(creator: DeviceCreatorFilterOption): string {
  return creator.displayName?.trim() || creator.login;
}
