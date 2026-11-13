import { Chip, TextField } from '@mui/material';
import type { AutocompleteRenderGetTagProps } from '@mui/material/Autocomplete';
import type { DeviceFileType } from '../../../../../Bindings';
import { PowerAutocomplete } from '../../../components/PowerAutocomplete';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import type { DeviceFilesState } from '../use-device-files';

const FILE_TYPE_LABELS: Record<DeviceFileType, string> = {
  folder: 'Папки',
  archive: 'Архіви',
  image: 'Зображення',
  audio: 'Аудіо',
  video: 'Відео',
  document: 'Документи',
  spreadsheet: 'Таблиці',
  presentation: 'Презентації',
  map: 'Карти',
  code: 'Код і дані',
  other: 'Інше',
};

export function renderFileFilterChips<T>(
  values: T[],
  getTagProps: AutocompleteRenderGetTagProps,
  label: (value: T) => string,
) {
  return values.map((value, index) => {
    const { key, ...props } = getTagProps({ index });
    return (
      <Chip
        {...props}
        key={key}
        label={label(value)}
        size="small"
        className="max-w-full text-[length:var(--echo-typography-font-size-sm)]!"
      />
    );
  });
}

export const fileFilterInputProps = { sx: { fontSize: 'var(--echo-typography-font-size-base)' } };

export function DeviceFileParameterFilters({ files }: { files: DeviceFilesState }) {
  const filters = files.listingFilters;
  return (
    <div className="flex min-w-0 flex-col gap-echo-md">
      <PowerAutocomplete<DeviceFileType>
        size="small"
        fullWidth
        disableCloseOnSelect
        options={Object.keys(FILE_TYPE_LABELS) as DeviceFileType[]}
        value={filters.fileTypes}
        getOptionLabel={(value) => FILE_TYPE_LABELS[value]}
        onChange={(_, fileTypes) => files.setListingFilters({ ...filters, fileTypes })}
        renderTags={(values, props) =>
          renderFileFilterChips(values, props, (value) => FILE_TYPE_LABELS[value])
        }
        renderInput={(params) => (
          <TextField
            {...params}
            label="Типи файлів"
            size="small"
            InputLabelProps={fileFilterInputProps}
            InputProps={{ ...params.InputProps, ...fileFilterInputProps }}
          />
        )}
      />
      <PowerAutocomplete<string>
        size="small"
        fullWidth
        disableCloseOnSelect
        loading={files.filterOptions.loading}
        options={Array.from(new Set([...files.filterOptions.extensions, ...filters.extensions]))}
        value={filters.extensions}
        onChange={(_, extensions) => files.setListingFilters({ ...filters, extensions })}
        renderTags={(values, props) => renderFileFilterChips(values, props, (value) => value)}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Розширення"
            size="small"
            InputLabelProps={fileFilterInputProps}
            InputProps={{ ...params.InputProps, ...fileFilterInputProps }}
          />
        )}
      />
      {files.filterOptions.error && (
        <PowerAlert
          severity="error"
          autoHideDuration={null}
          action={
            <PowerButton size="small" onClick={files.filterOptions.reload}>
              Повторити
            </PowerButton>
          }
        >
          {files.filterOptions.error.message}
        </PowerAlert>
      )}
    </div>
  );
}
