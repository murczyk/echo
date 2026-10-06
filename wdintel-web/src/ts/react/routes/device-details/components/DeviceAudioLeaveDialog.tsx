import { Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import { PowerButton } from '../../../components/PowerButton';
import type { DeviceAudioDraftGuard } from '../use-device-audio-draft-guard';
import type { DeviceAudioEditorState } from '../use-device-audio-editor';

export function DeviceAudioLeaveDialog({
  guard,
  editor,
}: {
  guard: DeviceAudioDraftGuard;
  editor: DeviceAudioEditorState;
}) {
  return (
    <Dialog open={guard.open} onClose={() => void guard.choose('cancel')}>
      <DialogTitle>Незбережена транскрипція</DialogTitle>
      <DialogContent>
        <p>Збережіть поточні зміни або відкиньте чернетку перед переходом.</p>
        {editor.message ? <p role="alert">{editor.message}</p> : null}
        {editor.conflict ? <p>Спочатку зіставте тексти у редакторі або скасуйте перехід.</p> : null}
      </DialogContent>
      <DialogActions>
        <PowerButton
          disabled={
            guard.saving ||
            editor.saving ||
            !editor.canEdit ||
            editor.conflict !== null ||
            editor.phase === 'unknownOutcome'
          }
          onClick={() => void guard.choose('save')}
        >
          Зберегти
        </PowerButton>
        <PowerButton onClick={() => void guard.choose('discard')}>Відкинути</PowerButton>
        <PowerButton onClick={() => void guard.choose('cancel')}>Скасувати</PowerButton>
      </DialogActions>
    </Dialog>
  );
}
