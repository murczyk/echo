import type { DeviceFileSelection } from '../../device-files/device-file-archive';
import type { DeviceAudioSettingsState } from '../use-device-audio-settings';
import { CircularProgress } from '@mui/material';
import type { ReactNode } from 'react';

import type { AiAgentFileCitation, DeviceDetails } from '../../../../../Bindings';
import { DeviceFileContentPane } from '../../device-files';
import { DeviceFileJournal } from '../../device-files/components/DeviceFileJournal';
import type { DeviceAnalyticsTagsState } from '../../device-files/use-device-analytics-tags';
import type { DeviceFileJournalState } from '../../device-files/use-device-file-journal';
import { DeviceDetailsLeftPanel } from './DeviceDetailsLeftPanel';
import { DeviceAnalyticsPanel } from './DeviceAnalyticsPanel';
import { PowerButton } from '../../../components/PowerButton';
import { selectDeviceSyncSession } from '../url-state';
import type { DeviceAudioState } from '../use-device-audio';
import type { DeviceAudioEditorState } from '../use-device-audio-editor';
import { DeviceAudioTab } from './DeviceAudioTab';

import { DeviceDetailsSection } from '../page-route';

export function DeviceDetailsContent({
  device,
  audio,
  audioEditor,
  audioSettings,
  mobileFiles,
  fileExplorer,
  mobile = false,
  section,
  selectedFile,
  onSelectFile,
  revisionPinned = false,
  citation,
  journal,
  deviceId,
  syncId = null,
  dataReady = true,
  sessionError = null,
  onRetrySession,
  refreshVersion = 0,
  isAdmin,
  tagsState,
}: {
  device: DeviceDetails;
  audio: DeviceAudioState;
  audioEditor: DeviceAudioEditorState;
  audioSettings: DeviceAudioSettingsState;
  mobileFiles?: ReactNode;
  fileExplorer?: ReactNode;
  mobile?: boolean;
  section: DeviceDetailsSection;
  selectedFile: DeviceFileSelection | null;
  onSelectFile?: (file: DeviceFileSelection) => void;
  revisionPinned?: boolean;
  citation?: AiAgentFileCitation;
  journal: DeviceFileJournalState;
  deviceId: string;
  syncId?: string | null;
  dataReady?: boolean;
  sessionError?: string | null;
  onRetrySession?: () => void;
  refreshVersion?: number;
  isAdmin: boolean;
  tagsState: DeviceAnalyticsTagsState;
}) {
  return (
    <section
      data-testid="device-details-content"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden text-echo-text"
    >
      <div className="min-h-0 flex-1 overflow-hidden">
        {section === DeviceDetailsSection.Audio ? (
          <DeviceAudioTab
            audio={audio}
            editor={audioEditor}
            settings={audioSettings}
            mobile={mobile}
          />
        ) : null}
        {!dataReady && section !== DeviceDetailsSection.Audio ? (
          <div className="p-echo-lg" role={sessionError ? 'alert' : 'status'}>
            {sessionError ? (
              <>
                <p>{sessionError}</p>
                <PowerButton onClick={onRetrySession}>Спробувати ще раз</PowerButton>
                <PowerButton onClick={() => selectDeviceSyncSession(null)}>
                  Показати всі сесії
                </PowerButton>
              </>
            ) : (
              <CircularProgress size={24} aria-label="Завантаження вибраної сесії" />
            )}
          </div>
        ) : null}
        {dataReady && section === DeviceDetailsSection.Overview ? (
          <section
            id="device-details-analytical-panel"
            aria-label="Аналітичні відомості"
            className="flex h-full min-h-0 flex-col gap-echo-lg overflow-auto"
          >
            <DeviceDetailsLeftPanel device={device} loading={false} embedded />
            <DeviceAnalyticsPanel
              key={`${deviceId}:${syncId ?? 'all'}`}
              deviceId={deviceId}
              syncId={syncId}
              refreshVersion={refreshVersion}
              enabled
              isAdmin={isAdmin}
              tagsState={tagsState}
            />
          </section>
        ) : null}
        {dataReady && section === DeviceDetailsSection.Files ? (
          <section
            id="device-details-files-panel"
            aria-label="Файли"
            className="h-full min-h-0 min-w-0"
          >
            {fileExplorer ?? mobileFiles ?? (
              <DeviceFileContentPane
                deviceId={deviceId}
                file={selectedFile ?? null}
                onSelectFile={onSelectFile}
                revisionPinned={revisionPinned}
                citation={citation}
                sessionScoped={syncId !== null}
              />
            )}
          </section>
        ) : null}
        {dataReady && section === DeviceDetailsSection.Journal ? (
          <section
            id="device-details-journal-panel"
            aria-label="Журнал"
            className="h-full min-h-0 min-w-0"
          >
            <DeviceFileJournal journal={journal} />
          </section>
        ) : null}
      </div>
    </section>
  );
}
