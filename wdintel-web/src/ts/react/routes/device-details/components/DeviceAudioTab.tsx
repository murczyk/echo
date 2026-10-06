import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { PowerButton } from '../../../components/PowerButton';
import type { DeviceAudioState } from '../use-device-audio';
import { DeviceAudioSidebar } from './DeviceAudioSidebar';
import { DeviceAudioPlayer } from './DeviceAudioPlayer';
import { DeviceAudioEditor } from './DeviceAudioEditor';
import type { DeviceAudioEditorState } from '../use-device-audio-editor';
import { DeviceAudioProcessing } from './DeviceAudioProcessing';

export function DeviceAudioTab({
  audio,
  editor,
  mobile = false,
}: {
  audio: DeviceAudioState;
  editor: DeviceAudioEditorState;
  mobile?: boolean;
}) {
  const selected = audio.rows.find((row) => row.id === audio.selectedAudioId);
  const bound = audio.selectedAudioId ? audio.processingAudio(audio.selectedAudioId) : undefined;
  return (
    <div
      id="device-details-audio-panel"
      role="tabpanel"
      aria-labelledby="device-details-audio-tab"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-testid="device-audio-tab"
    >
      {mobile ? (
        <div className={audio.selectedAudioId === null ? 'h-full min-h-0' : 'hidden'}>
          <DeviceAudioSidebar audio={audio} />
        </div>
      ) : null}
      {!mobile || audio.selectedAudioId !== null ? (
        <>
          {mobile ? (
            <div className="shrink-0 border-b border-echo-border px-echo-sm">
              <PowerButton
                className="!min-h-echo-control-lg"
                startIcon={<ArrowBackIcon />}
                onClick={() => audio.selectAudio(null)}
              >
                До аудіо
              </PowerButton>
            </div>
          ) : null}
          <div className="min-h-0 min-w-0 flex-1 overflow-auto p-echo-md">
            {selected ? (
              <>
                <DeviceAudioPlayer
                  deviceId={selected.deviceId}
                  audioId={selected.id}
                  active={!editor.accessDenied && !audio.processing[selected.id]?.accessDenied}
                />
              </>
            ) : (
              <p>Оберіть аудіо для прослуховування.</p>
            )}
            {!selected && bound ? (
              <p role="status">
                Аудіо більше не входить до поточного списку. Транскрипція залишається прив’язаною до
                цього запису.
              </p>
            ) : null}
            {bound ? (
              <DeviceAudioProcessing audio={audio} selected={bound} canEdit={editor.canEdit} />
            ) : null}
            {audio.selectedAudioId !== null ? <DeviceAudioEditor editor={editor} /> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
