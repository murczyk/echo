import { Box, Checkbox, FormControlLabel, Typography } from '@mui/material';

type FeedFilterAdvancedSectionProps = {
  highlightSignalsEnabled?: boolean;
  onlyMyUnitTagsEnabled?: boolean;
  onHighlightSignalsChange?: (value: boolean) => void;
  onOnlyMyUnitTagsChange?: (value: boolean) => void;
};

export function FeedFilterAdvancedSection({
  highlightSignalsEnabled,
  onlyMyUnitTagsEnabled,
  onHighlightSignalsChange,
  onOnlyMyUnitTagsChange,
}: FeedFilterAdvancedSectionProps) {
  return (
    <Box>
      <Typography variant="subtitle2" className="mb-2 font-semibold">
        Додатково
      </Typography>
      <Box className="flex flex-col gap-1">
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={highlightSignalsEnabled ?? false}
              onChange={(_, checked) => onHighlightSignalsChange?.(checked)}
            />
          }
          label="підсвічувати сигнали"
        />
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={onlyMyUnitTagsEnabled ?? false}
              onChange={(_, checked) => onOnlyMyUnitTagsChange?.(checked)}
            />
          }
          label="лише теги мого підрозділу"
        />
      </Box>
    </Box>
  );
}
