import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useEffect, useRef } from 'react';

import type { AiAgentFileCitation, SyncSummary } from '../../../../../Bindings';
import { formatDeviceDateTime } from '../../devices/helpers';
import { PowerButton } from '../../../components/PowerButton';
import type { DeviceAnalyticsTagFilter } from '../types';
import type { DeviceAnalyticsTagsState } from '../use-device-analytics-tags';
import type { DeviceFilesState } from '../use-device-files';
import { DeviceFilesSidebar } from './DeviceFilesSidebar';
import { DeviceFileContentPane } from './DeviceFileContentPane';

export function DeviceMobileFilesPanel({
  deviceId,
  syncId,
  session,
  files,
  citation,
  tagsState,
  tagFilter,
  onTagFilterChange,
}: {
  deviceId: string;
  syncId: string | null;
  session: SyncSummary | null;
  files: DeviceFilesState;
  citation?: AiAgentFileCitation;
  tagsState: DeviceAnalyticsTagsState;
  tagFilter: DeviceAnalyticsTagFilter;
  onTagFilterChange: (filter: DeviceAnalyticsTagFilter) => void;
}) {
  const opener = useRef<HTMLElement | null>(null);
  const back = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (files.selectedFile !== null) back.current?.focus();
  }, [files.selectedFile]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={files.selectedFile === null ? 'h-full min-h-0' : 'hidden'}>
        <DeviceFilesSidebar
          active={files.selectedFile === null}
          fullHeight
          files={{
            ...files,
            selectFile: (file) => {
              opener.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;
              files.selectFile(file);
            },
          }}
          tagsState={tagsState}
          tagFilter={tagFilter}
          onTagFilterChange={onTagFilterChange}
        />
      </div>
      {files.selectedFile !== null ? (
        <>
          <div className="shrink-0 border-b border-echo-border px-echo-sm">
            <PowerButton
              ref={back}
              className="!min-h-echo-control-lg"
              startIcon={<ArrowBackIcon />}
              onClick={() => {
                files.clearSelectedFile();
                requestAnimationFrame(() => opener.current?.focus());
              }}
            >
              До файлів
            </PowerButton>
          </div>
          {syncId !== null ? (
            <p className="m-0 shrink-0 px-echo-md py-echo-sm text-[length:var(--echo-typography-font-size-xs)]">
              {session ? `Сесія: ${formatDeviceDateTime(session.createdAt)}` : 'Вибрана сесія'}
            </p>
          ) : null}
          <div className="min-h-0 flex-1">
            <DeviceFileContentPane
              deviceId={deviceId}
              file={files.selectedFile}
              onSelectFile={files.selectFile}
              revisionPinned={files.revisionPinned}
              citation={citation}
              sessionScoped={syncId !== null}
              mobile
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
