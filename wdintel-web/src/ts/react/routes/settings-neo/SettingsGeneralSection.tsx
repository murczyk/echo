import { Box, Stack, Typography } from '@mui/material';

import { PowerAlert } from '../../components/PowerAlert';
import type { MessageTextPreviewLineLimit } from '../../services/api/user-settings';
import type { TagsLayoutVariant } from '../rer-duty-neo/utils';
import { SettingsMessageCard } from './SettingsMessageCard';

export type SettingsGeneralSectionProps = {
  loadInProgress: boolean;
  prefsLoadError: string | null;
  saveError: string | null;
  tagsLayout: TagsLayoutVariant;
  onTagsLayoutChange: (layout: TagsLayoutVariant) => void;
  messageTextPreviewLines: MessageTextPreviewLineLimit;
  onMessageTextPreviewLinesChange: (value: MessageTextPreviewLineLimit) => void;
  mediaSummaryEnabled: boolean;
  onMediaSummaryEnabledChange: (value: boolean) => void;
};

export function SettingsGeneralSection({
  loadInProgress,
  prefsLoadError,
  saveError,
  tagsLayout,
  onTagsLayoutChange,
  messageTextPreviewLines,
  onMessageTextPreviewLinesChange,
  mediaSummaryEnabled,
  onMediaSummaryEnabledChange,
}: SettingsGeneralSectionProps) {
  return (
    <Box
      id="settings-neo-panel-general"
      role="tabpanel"
      aria-labelledby="settings-neo-tab-general"
      sx={{ p: 3 }}
    >
      <Stack spacing={3} sx={{ maxWidth: 960 }}>
        <Typography
          component="h2"
          variant="h6"
          sx={{ fontWeight: 700, lineHeight: 1.25, color: 'text.primary' }}
        >
          Загальні
        </Typography>

        {prefsLoadError ? <PowerAlert severity="warning">{prefsLoadError}</PowerAlert> : null}
        {saveError ? <PowerAlert severity="error">{saveError}</PowerAlert> : null}

        <Stack spacing={3} sx={{ minWidth: 0 }}>
          <SettingsMessageCard
            tagsLayout={tagsLayout}
            onTagsLayoutChange={onTagsLayoutChange}
            messageTextPreviewLines={messageTextPreviewLines}
            onMessageTextPreviewLinesChange={onMessageTextPreviewLinesChange}
            mediaSummaryEnabled={mediaSummaryEnabled}
            onMediaSummaryEnabledChange={onMediaSummaryEnabledChange}
            loadInProgress={loadInProgress}
          />
        </Stack>
      </Stack>
    </Box>
  );
}
