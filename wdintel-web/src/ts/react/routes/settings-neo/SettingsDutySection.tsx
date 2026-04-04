import { Alert, Box, CircularProgress, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import type { FormEvent } from 'react';

import { Button } from '../../components/mui-customized/button';
import type { TagsLayoutVariant } from '../rer-duty-neo/utils';

export type SettingsDutySectionProps = {
  loadInProgress: boolean;
  prefsLoadError: string | null;
  saveError: string | null;
  saveSuccess: string | null;
  tagsLayout: TagsLayoutVariant;
  onTagsLayoutChange: (layout: TagsLayoutVariant) => void;
  onSave: (event?: FormEvent) => void | Promise<void>;
  isDirty: boolean;
  saveInProgress: boolean;
};

export function SettingsDutySection({
  loadInProgress,
  prefsLoadError,
  saveError,
  saveSuccess,
  tagsLayout,
  onTagsLayoutChange,
  onSave,
  isDirty,
  saveInProgress,
}: SettingsDutySectionProps) {
  return (
    <Box id="settings-neo-panel-duty" role="tabpanel" aria-labelledby="settings-neo-tab-duty" sx={{ p: 3 }}>
      <Stack spacing={2} sx={{ maxWidth: 960 }}>
        <Typography
          component="h2"
          variant="subtitle1"
          sx={{
            fontWeight: 600,
            lineHeight: 1.45,
            color: 'text.primary',
          }}
        >
          Вигляд тегів у стрічці Оперативного (зберігається для вашого облікового запису)
        </Typography>
        {prefsLoadError ? <Alert severity="warning">{prefsLoadError}</Alert> : null}
        {saveError ? <Alert severity="error">{saveError}</Alert> : null}
        <Box component="form" onSubmit={onSave} noValidate>
          <Stack spacing={2}>
            <Box className="flex flex-wrap items-center gap-2">
              <Typography variant="caption" sx={{ fontSize: 12 }}>
                вигляд тегів:
              </Typography>
              <ToggleButtonGroup
                value={tagsLayout}
                exclusive
                color="primary"
                onChange={(_, v: TagsLayoutVariant | null) => {
                  if (v != null) onTagsLayoutChange(v);
                }}
                size="small"
                sx={{
                  flexShrink: 0,
                  '& .MuiToggleButton-root': { textTransform: 'none', fontSize: 12 },
                }}
              >
                <ToggleButton value="full">повний</ToggleButton>
                <ToggleButton value="compact">компактний</ToggleButton>
                <ToggleButton value="hidden">не показувати</ToggleButton>
              </ToggleButtonGroup>
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 1.5, pt: 1 }}>
              {saveSuccess ? (
                <Typography variant="caption" color="success.main" role="status">
                  {saveSuccess}
                </Typography>
              ) : null}
              <Button
                variant="contained"
                type="submit"
                disabled={saveInProgress || !isDirty || loadInProgress}
                startIcon={saveInProgress ? <CircularProgress size={18} /> : undefined}
                sx={{ fontWeight: 500 }}
              >
                зберегти
              </Button>
            </Box>
          </Stack>
        </Box>
      </Stack>
    </Box>
  );
}
