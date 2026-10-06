import { CircularProgress, TextField } from '@mui/material';
import { PowerButton } from '../../../components/PowerButton';
import type { DeviceAudioEditorState } from '../use-device-audio-editor';
import { DeviceAudioConflictDialog } from './DeviceAudioConflictDialog';

export function DeviceAudioEditor({ editor }: { editor: DeviceAudioEditorState }) {
  return (
    <div className="mt-echo-md flex min-w-0 flex-col gap-echo-md" data-device-audio-editor>
      {editor.phase === 'loading' ? (
        <div role="status">
          <CircularProgress size={24} aria-label="Завантаження транскрипції" />
        </div>
      ) : null}
      {editor.message ? (
        <p role={editor.phase === 'ready' ? 'status' : 'alert'} className="break-words">
          {editor.message}
        </p>
      ) : null}
      {editor.confirmed ? (
        <>
          <TextField
            label="Ручна транскрипція"
            multiline
            minRows={5}
            maxRows={12}
            fullWidth
            value={editor.draft}
            onChange={(event) => editor.setDraft(event.target.value)}
            inputProps={{ readOnly: !editor.canEdit }}
          />
          {!editor.canEdit ? (
            <p>Редагування недоступне. Чернетку збережено у відкритій сторінці.</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-echo-sm">
            <PowerButton
              variant="contained"
              disabled={
                !editor.canEdit ||
                !editor.dirty ||
                editor.saving ||
                editor.conflict !== null ||
                editor.phase === 'unknownOutcome'
              }
              onClick={() => void editor.save()}
            >
              {editor.saving ? 'Збереження…' : 'Зберегти транскрипцію'}
            </PowerButton>
            <span role="status">{editor.dirty ? 'Незбережені зміни' : 'Актуальний текст'}</span>
          </div>
        </>
      ) : null}
      {editor.confirmed || ['loadError', 'unknownOutcome'].includes(editor.phase) ? (
        <PowerButton
          disabled={editor.saving || editor.phase === 'loading'}
          onClick={() => void editor.reload()}
        >
          Перечитати транскрипцію
        </PowerButton>
      ) : null}
      {editor.conflict ? <DeviceAudioConflictDialog editor={editor} /> : null}
    </div>
  );
}
