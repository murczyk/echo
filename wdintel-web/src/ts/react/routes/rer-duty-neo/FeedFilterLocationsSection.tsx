import { Box, Checkbox, FormControlLabel } from '@mui/material';
import { FeedFilterSelectionSection } from './FeedFilterSelectionSection';
import type { FeedFilterLocationsViewModel } from './useFeedFilterLocationsViewModel';

type FeedFilterLocationsSectionProps = {
  locations: FeedFilterLocationsViewModel;
  radioFeaturesAllowed: boolean;
};

export function FeedFilterLocationsSection({
  locations,
  radioFeaturesAllowed,
}: FeedFilterLocationsSectionProps) {
  const showPelengToggle = radioFeaturesAllowed && locations.value.length > 0;
  return (
    <Box>
      <FeedFilterSelectionSection
        title="Локації"
        mode={locations.mode}
        onModeChange={locations.onModeChange}
        value={locations.value}
        onValueChange={locations.onValueChange}
        options={locations.options}
        getOptionLabel={locations.getOptionLabel}
        getOptionKey={locations.getOptionKey}
        placeholder={locations.placeholder}
        autocompleteClassName={locations.autocompleteClassName}
        loading={locations.loading}
        loadingText={locations.loadingText}
        noOptionsText={locations.noOptionsText}
        keepOpenOnSelect={locations.keepOpenOnSelect}
        preserveInputOnSelect={locations.preserveInputOnSelect}
        onInputChange={locations.onInputChange}
        onOpen={locations.onOpen}
        bulkPaste
        bulkPasteSeparators={['\n']}
        bulkPasteMenuLabel="Додати кілька локацій"
        bulkPasteDialogTitle="Додати кілька локацій"
        bulkPasteInputLabel="Локації"
        resolveBulkPasteOptions={locations.resolveBulkPasteOptions}
        bulkCopy={locations.bulkCopy}
        bulkCopyMenuLabel={locations.bulkCopyMenuLabel}
        onBulkCopy={locations.onBulkCopy}
      />
      {showPelengToggle ? (
        <FormControlLabel
          className="mt-1"
          control={
            <Checkbox
              size="small"
              checked={locations.includePelengLocations}
              onChange={(_, checked) => locations.onIncludePelengLocationsChange(checked)}
            />
          }
          label="Включати пеленг-локації"
        />
      ) : null}
    </Box>
  );
}
