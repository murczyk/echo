import { Checkbox, FormControlLabel, Typography } from '@mui/material';
import dayjs from 'dayjs';

import { PowerButton } from '../../../components/PowerButton';
import { PowerDateTimePicker } from '../../../components/PowerDateTimePicker';
import { createDefaultDeviceFileFilters } from '../helpers';
import type { DeviceAnalyticsTagFilter } from '../types';
import type { DeviceAnalyticsTagsState } from '../use-device-analytics-tags';
import type { DeviceFilesState } from '../use-device-files';
import { DeviceFileParameterFilters } from './DeviceFileParameterFilters';
import { DeviceAnalyticsTagFilterControls } from './DeviceAnalyticsTagFilterControls';

export type DeviceFileExplorerFilterProps = {
  files: DeviceFilesState;
  tagsState: DeviceAnalyticsTagsState;
  tagFilter: DeviceAnalyticsTagFilter;
  onTagFilterChange: (filter: DeviceAnalyticsTagFilter) => void;
};

export function DeviceFileExplorerFilters({
  files,
  tagsState,
  tagFilter,
  onTagFilterChange,
}: DeviceFileExplorerFilterProps) {
  const filters = files.listingFilters;
  return (
    <form
      id="device-file-explorer-filters"
      aria-label="Фільтри файлів"
      className="mr-[var(--device-files-scroll-gutter,0px)] flex max-h-[60%] min-h-0 shrink-0 flex-col border-b border-echo-border"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <div className="flex shrink-0 items-center justify-between gap-echo-md px-echo-md py-echo-sm">
        <h2 className="m-0! text-[length:var(--echo-typography-font-size-lg)]! font-semibold!">
          Фільтри
        </h2>
        <PowerButton
          type="button"
          size="small"
          onClick={() => {
            files.setListingFilters(createDefaultDeviceFileFilters());
            onTagFilterChange({ tagIds: [], tagMatch: 'any', untagged: false });
          }}
        >
          Скинути фільтри
        </PowerButton>
      </div>
      <div className="min-h-0 space-y-echo-lg overflow-y-auto px-echo-md py-echo-sm">
        <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-echo-lg">
          <section aria-label="Стан файлів" className="min-w-0">
            <Typography component="h3" variant="subtitle2" className="m-0! mb-echo-md!">
              Стан файлів
            </Typography>
            <div className="flex flex-col gap-echo-xs">
              {[
                {
                  label: 'Тільки обране',
                  checked: files.favoritesOnly,
                  onChange: files.setFavoritesOnly,
                },
                {
                  label: 'Тільки непереглянуті',
                  checked: files.unviewedOnly,
                  onChange: files.setUnviewedOnly,
                },
                {
                  label: 'З помилкою розпакування',
                  checked: files.archiveFailed,
                  onChange: files.setArchiveFailed,
                },
                {
                  label: 'Захищені паролем',
                  checked: files.archiveEncrypted,
                  onChange: files.setArchiveEncrypted,
                },
                {
                  label: 'Показувати файли без контенту',
                  checked: files.contentFilter === null,
                  onChange: (checked: boolean) => files.setContentFilter(checked ? null : true),
                },
              ].map(({ label, checked, onChange }) => (
                <FormControlLabel
                  key={label}
                  className="m-0! gap-echo-xs"
                  slotProps={{ typography: { variant: 'body2' } }}
                  control={
                    <Checkbox
                      size="small"
                      className="p-echo-xs!"
                      checked={checked}
                      onChange={(_, checked) => onChange(checked)}
                    />
                  }
                  label={label}
                />
              ))}
            </div>
          </section>
          <section aria-label="Параметри файлів" className="min-w-0">
            <Typography component="h3" variant="subtitle2" className="m-0! mb-echo-md!">
              Параметри файлів
            </Typography>
            <DeviceFileParameterFilters files={files} />
          </section>
          <DeviceAnalyticsTagFilterControls
            compact
            tagsState={tagsState}
            filter={tagFilter}
            onChange={onTagFilterChange}
          />
        </div>
        <section aria-label="Дата зміни файлу" className="border-t border-echo-border pt-echo-md">
          <Typography component="h3" variant="subtitle2" className="m-0! mb-echo-md!">
            Дата зміни файлу
          </Typography>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-echo-md">
            <PowerDateTimePicker
              label="Змінено від"
              value={filters.modifiedFrom === null ? null : dayjs(filters.modifiedFrom)}
              allowEmpty
              onChange={(value) =>
                files.setListingFilters({
                  ...filters,
                  modifiedFrom: value?.isValid() ? value.toISOString() : null,
                })
              }
              slotProps={{ textField: { size: 'small', fullWidth: true } }}
            />
            <PowerDateTimePicker
              label="Змінено до"
              value={filters.modifiedTo === null ? null : dayjs(filters.modifiedTo)}
              allowEmpty
              onChange={(value) =>
                files.setListingFilters({
                  ...filters,
                  modifiedTo: value?.isValid() ? value.toISOString() : null,
                })
              }
              slotProps={{ textField: { size: 'small', fullWidth: true } }}
            />
          </div>
        </section>
        {files.filterDateError && (
          <p
            className="m-0 text-[length:var(--echo-typography-font-size-sm)] text-echo-error"
            role="alert"
          >
            {files.filterDateError}
          </p>
        )}
      </div>
    </form>
  );
}
