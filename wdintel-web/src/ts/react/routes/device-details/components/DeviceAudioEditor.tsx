import { CircularProgress, TextField, ToggleButton, ToggleButtonGroup } from '@mui/material';
import { PowerButton } from '../../../components/PowerButton';
import type { DeviceAudioEditorState } from '../use-device-audio-editor';
import type { DeviceAudioTranscriptionState } from '../use-device-audio-transcription';
import { DeviceAudioConflictDialog } from './DeviceAudioConflictDialog';

export function DeviceAudioEditor({
  editor,
  transcription,
}: {
  editor: DeviceAudioEditorState;
  transcription?: DeviceAudioTranscriptionState;
}) {
  const snapshot = transcription?.snapshot ?? editor.detail?.automaticTranscription;
  const availability = transcription?.availability ?? editor.detail?.transcriptionAvailability;
  const status =
    snapshot?.message ??
    {
      not_requested: 'Транскрибацію не заплановано',
      queued: 'Транскрибація в черзі',
      preparing: 'Підготовка транскрибації',
      running: 'Транскрибація триває',
      retry_wait: 'Транскрибацію буде повторено',
      succeeded: 'Автоматичну транскрипцію збережено',
      no_speech: 'Мовлення не виявлено',
      failed: 'Не вдалося виконати транскрибацію',
      outcome_unknown: 'Потрібна операторська перевірка',
      cancelled: 'Транскрибацію скасовано',
    }[snapshot?.state ?? 'not_requested'];
  return (
    <div className="mt-echo-md flex min-w-0 flex-col gap-echo-md" data-device-audio-editor>
      {snapshot ? (
        <p role="status" data-device-audio-asr-status>
          {status}
        </p>
      ) : null}
      {availability?.blockedReason ? <p role="status">{availability.blockedReason}</p> : null}
      {transcription && availability?.canRetry && !transcription.accessDenied ? (
        <PowerButton disabled={transcription.retrying} onClick={() => transcription.retry()}>
          {transcription.retrying ? 'Планування транскрибації…' : 'Повторити транскрибацію'}
        </PowerButton>
      ) : null}
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
          {editor.confirmed.text !== '' && editor.detail?.automaticTranscription?.text != null ? (
            <ToggleButtonGroup
              exclusive
              size="small"
              aria-label="Джерело транскрипції"
              value={editor.automaticView ? 'automatic' : 'manual'}
              onChange={(_, value) => {
                if (value !== null) editor.setAutomaticView(value === 'automatic');
              }}
            >
              <ToggleButton value="manual">Ручна</ToggleButton>
              <ToggleButton value="automatic">Автоматична</ToggleButton>
            </ToggleButtonGroup>
          ) : null}
          {editor.automaticNotice ? <p role="status">Автоматична транскрипція доступна</p> : null}
          <TextField
            label={editor.automaticView ? 'Автоматична транскрипція' : 'Ручна транскрипція'}
            multiline
            minRows={5}
            maxRows={12}
            fullWidth
            value={
              editor.automaticView
                ? (editor.detail?.automaticTranscription?.text ?? '')
                : editor.draft
            }
            onChange={(event) => editor.setDraft(event.target.value)}
            inputProps={{ readOnly: !editor.canEdit || editor.automaticView }}
          />
          {!editor.canEdit && !editor.automaticView ? (
            <p>Редагування недоступне. Чернетку збережено у відкритій сторінці.</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-echo-sm">
            <PowerButton
              variant="contained"
              disabled={
                !editor.canEdit ||
                editor.automaticView ||
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
