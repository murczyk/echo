import {
  Box,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import type { AdminAnalyticsTag, RuleExpression } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { RuleExpressionEditor } from './RuleExpressionEditor';
import { RuleTestPanel } from './RuleTestPanel';

export type TagDraft = {
  persisted: AdminAnalyticsTag | null;
  name: string;
  ruleExpression: RuleExpression | null;
};

export function TagEditorDialog({
  draft,
  saving,
  mutating,
  saveError,
  onChange,
  onClose,
  onSave,
  onToggleArchived,
}: {
  draft: TagDraft | null;
  saving: boolean;
  mutating: boolean;
  saveError: string | null;
  onChange: (draft: TagDraft) => void;
  onClose: () => void;
  onSave: () => void;
  onToggleArchived: () => void;
}) {
  if (draft === null) return null;
  const archived = draft.persisted?.archivedAt !== null && draft.persisted !== null;

  return (
    <Dialog
      open
      fullWidth
      maxWidth="md"
      onClose={saving || mutating ? undefined : onClose}
      aria-labelledby="tag-editor-title"
    >
      <DialogTitle id="tag-editor-title">
        {draft.persisted === null
          ? 'Новий тег пристроїв'
          : `Редагування тегу «${draft.persisted.name}»`}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <TextField
            label="Назва тегу"
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            required
            disabled={saving || mutating || archived}
            autoFocus
            inputProps={{ maxLength: 128 }}
            helperText="Назва повинна бути унікальною серед активних і архівних тегів."
            fullWidth
          />

          {archived ? (
            <PowerAlert severity="warning" autoHideDuration={null} dismissible={false}>
              Архівний тег спочатку потрібно відновити, щоб змінити назву або правило.
            </PowerAlert>
          ) : (
            <>
              <Box component="section" aria-labelledby="tag-rule-editor-title">
                <Typography id="tag-rule-editor-title" variant="h6" gutterBottom>
                  Активне правило
                </Typography>
                <RuleExpressionEditor
                  expression={draft.ruleExpression}
                  onChange={(ruleExpression) => onChange({ ...draft, ruleExpression })}
                />
              </Box>

              <RuleTestPanel
                tagId={draft.persisted?.id ?? null}
                expression={draft.ruleExpression}
              />
            </>
          )}
          {saveError ? (
            <PowerAlert severity="error" autoHideDuration={null} dismissible={false}>
              {saveError}
            </PowerAlert>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions
        sx={{
          px: { xs: 1, sm: 3 },
          py: 2,
          flexWrap: 'wrap',
          gap: 1,
          '& > :not(style) ~ :not(style)': { ml: 0 },
        }}
      >
        {draft.persisted !== null ? (
          <PowerButton
            key={archived ? 'restore' : 'archive'}
            color={archived ? 'primary' : 'warning'}
            variant="outlined"
            disabled={saving || mutating}
            onClick={onToggleArchived}
            sx={{ width: { xs: '100%', sm: 'auto' }, mr: { sm: 'auto' } }}
          >
            {mutating ? 'Змінюємо стан…' : archived ? 'Відновити тег' : 'Архівувати тег'}
          </PowerButton>
        ) : null}
        <PowerButton onClick={onClose} disabled={saving || mutating}>
          Скасувати
        </PowerButton>
        <PowerButton
          variant="contained"
          disabled={saving || mutating || archived || draft.name.trim() === ''}
          startIcon={saving ? <CircularProgress size={18} color="inherit" /> : undefined}
          onClick={onSave}
        >
          {saving ? 'Зберігаємо…' : 'Зберегти'}
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}
