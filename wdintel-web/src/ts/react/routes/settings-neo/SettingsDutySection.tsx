import CloseIcon from '@mui/icons-material/Close';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import {
  Alert,
  Box,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  type TypographyProps,
} from '@mui/material';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../../components/mui-customized/button';
import type { MessageCardLayoutVariant, TagsLayoutVariant } from '../rer-duty-neo/utils';

const DUTY_HELP_SECTION_TITLE_PROPS: Pick<TypographyProps, 'variant' | 'component' | 'sx'> = {
  variant: 'h6',
  component: 'h3',
  sx: { mb: 1.5, fontWeight: 600 },
};

const DUTY_HELP_CAPTION_PROPS: Pick<TypographyProps, 'variant' | 'sx'> = {
  variant: 'body1',
  sx: {
    display: 'block',
    mb: 1,
    width: '100%',
    fontSize: '1.05rem',
    lineHeight: 1.5,
    textAlign: 'center',
    color: 'text.secondary',
  },
};

export type SettingsDutySectionProps = {
  loadInProgress: boolean;
  prefsLoadError: string | null;
  saveError: string | null;
  saveSuccess: string | null;
  messageCardLayout: MessageCardLayoutVariant;
  onMessageCardLayoutChange: (layout: MessageCardLayoutVariant) => void;
  tagsLayout: TagsLayoutVariant;
  onTagsLayoutChange: (layout: TagsLayoutVariant) => void;
  onSave: (event?: FormEvent) => void | Promise<void>;
  isDirty: boolean;
  saveInProgress: boolean;
};

function RerDutyHelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg" aria-labelledby="duty-help-dialog-a11y-title">
      <Typography
        id="duty-help-dialog-a11y-title"
        sx={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          clipPath: 'inset(50%)',
          whiteSpace: 'nowrap',
        }}
      >
        Підказка по вигляду оперативного
      </Typography>
      <DialogTitle sx={{ display: 'flex', justifyContent: 'flex-end', py: 1, px: 1.5, minHeight: 0 }}>
        <IconButton aria-label="Закрити" onClick={onClose} edge="end" size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={4}>
          <Box>
            <Typography {...DUTY_HELP_SECTION_TITLE_PROPS}>Картка повідомлення</Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2.5 }}>
              <Box>
                <Typography {...DUTY_HELP_CAPTION_PROPS}>з роздільниками</Typography>
                <Box
                  component="img"
                  src="/img/rer-duty-settings/message-dividers.png"
                  alt="Картка з роздільниками"
                  sx={{ width: '100%', borderRadius: 1, border: 1, borderColor: 'divider' }}
                />
              </Box>
              <Box>
                <Typography {...DUTY_HELP_CAPTION_PROPS}>без роздільників</Typography>
                <Box
                  component="img"
                  src="/img/rer-duty-settings/message-fluid.png"
                  alt="Картка без роздільників"
                  sx={{ width: '100%', borderRadius: 1, border: 1, borderColor: 'divider' }}
                />
              </Box>
            </Box>
          </Box>

          <Box>
            <Typography {...DUTY_HELP_SECTION_TITLE_PROPS}>Вигляд тегів</Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr 1fr' }, gap: 2.5 }}>
              <Box>
                <Typography {...DUTY_HELP_CAPTION_PROPS}>повний</Typography>
                <Box
                  component="img"
                  src="/img/rer-duty-settings/message-full-tags.png"
                  alt="Теги повний вигляд"
                  sx={{ width: '100%', borderRadius: 1, border: 1, borderColor: 'divider' }}
                />
              </Box>
              <Box>
                <Typography {...DUTY_HELP_CAPTION_PROPS}>компактний</Typography>
                <Box
                  component="img"
                  src="/img/rer-duty-settings/message-compact-tags.png"
                  alt="Теги компактний вигляд"
                  sx={{ width: '100%', borderRadius: 1, border: 1, borderColor: 'divider' }}
                />
              </Box>
              <Box>
                <Typography {...DUTY_HELP_CAPTION_PROPS}>не показувати</Typography>
                <Box
                  component="img"
                  src="/img/rer-duty-settings/message-no-tags.png"
                  alt="Теги приховано"
                  sx={{ width: '100%', borderRadius: 1, border: 1, borderColor: 'divider' }}
                />
              </Box>
            </Box>
          </Box>
        </Stack>
      </DialogContent>
    </Dialog>
  );
}

export function SettingsDutySection({
  loadInProgress,
  prefsLoadError,
  saveError,
  saveSuccess,
  messageCardLayout,
  onMessageCardLayoutChange,
  tagsLayout,
  onTagsLayoutChange,
  onSave,
  isDirty,
  saveInProgress,
}: SettingsDutySectionProps) {
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <>
      <Box id="settings-neo-panel-duty" role="tabpanel" aria-labelledby="settings-neo-tab-duty" sx={{ p: 3 }}>
        <Stack spacing={2} sx={{ maxWidth: 960 }}>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
            <Typography
              component="h2"
              variant="subtitle1"
              sx={{
                flex: 1,
                fontWeight: 600,
                lineHeight: 1.45,
                color: 'text.primary',
              }}
            >
              Вигляд повідомлень у стрічці Оперативного (зберігається для вашого облікового запису)
            </Typography>
            <IconButton
              aria-label="Підказка по вигляду карток у стрічці оперативного"
              onClick={() => setHelpOpen(true)}
              size="small"
              edge="end"
              sx={{ color: 'text.secondary', mt: -0.25 }}
            >
              <HelpOutlineIcon fontSize="small" />
            </IconButton>
          </Box>
          {prefsLoadError ? <Alert severity="warning">{prefsLoadError}</Alert> : null}
          {saveError ? <Alert severity="error">{saveError}</Alert> : null}
          <Box component="form" onSubmit={onSave} noValidate>
            <Stack spacing={2}>
              <Box className="flex flex-wrap items-center gap-2">
                <Typography variant="caption" sx={{ fontSize: 12 }}>
                  картка повідомлення:
                </Typography>
                <ToggleButtonGroup
                  value={messageCardLayout}
                  exclusive
                  onChange={(_, v: MessageCardLayoutVariant | null) => {
                    if (v != null) onMessageCardLayoutChange(v);
                  }}
                  size="small"
                  sx={{
                    flexShrink: 0,
                    borderRadius: 2,
                    '& .MuiToggleButton-root': { borderRadius: 1, textTransform: 'none', fontSize: 12 },
                  }}
                >
                  <ToggleButton value="dividers">з роздільниками</ToggleButton>
                  <ToggleButton value="fluid">без роздільників</ToggleButton>
                </ToggleButtonGroup>
              </Box>
              <Box className="flex flex-wrap items-center gap-2">
                <Typography variant="caption" sx={{ fontSize: 12 }}>
                  вигляд тегів:
                </Typography>
                <ToggleButtonGroup
                  value={tagsLayout}
                  exclusive
                  onChange={(_, v: TagsLayoutVariant | null) => {
                    if (v != null) onTagsLayoutChange(v);
                  }}
                  size="small"
                  sx={{
                    flexShrink: 0,
                    borderRadius: 2,
                    '& .MuiToggleButton-root': { borderRadius: 1, textTransform: 'none', fontSize: 12 },
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

      <RerDutyHelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}
