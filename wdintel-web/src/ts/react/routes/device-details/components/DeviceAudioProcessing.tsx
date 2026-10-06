import type { DeviceAudio } from '../../../../../Bindings';
import { PowerButton } from '../../../components/PowerButton';
import type { DeviceAudioState } from '../use-device-audio';

export function DeviceAudioProcessing({
  audio,
  selected,
  canEdit,
}: {
  audio: DeviceAudioState;
  selected: DeviceAudio;
  canEdit: boolean;
}) {
  const action = audio.processing[selected.id];
  const pending = action?.phase === 'pending';
  const unknown = action?.phase === 'unknownOutcome';
  const disabled = !canEdit || action?.canEdit === false || pending || unknown;
  return (
    <div className="my-echo-md flex min-w-0 flex-col gap-echo-sm" data-device-audio-processing>
      <p role="status">Статус: {selected.processed ? 'Оброблене' : 'Необроблене'}</p>
      <div className="flex flex-wrap gap-echo-sm">
        <PowerButton disabled={disabled} onClick={() => void audio.setProcessed(selected.id, true)}>
          Позначити обробленим
        </PowerButton>
        <PowerButton
          disabled={disabled}
          onClick={() => void audio.setProcessed(selected.id, false)}
        >
          Позначити необробленим
        </PowerButton>
      </div>
      {pending ? <p role="status">Змінюємо статус…</p> : null}
      {action?.message ? (
        <p role="alert" className="break-words">
          {action.message}
        </p>
      ) : null}
      {unknown ? (
        <PowerButton
          disabled={action?.reconciling}
          onClick={() => void audio.reconcileProcessing(selected.id)}
        >
          Перечитати статус
        </PowerButton>
      ) : null}
      {action?.reconciling ? <p role="status">Звіряємо статус…</p> : null}
      {action?.phase === 'conflict' ? (
        <PowerButton
          disabled={disabled}
          onClick={() => void audio.setProcessed(selected.id, action.target)}
        >
          {action.target ? 'Повторити позначення обробленим' : 'Повторити позначення необробленим'}
        </PowerButton>
      ) : null}
    </div>
  );
}
