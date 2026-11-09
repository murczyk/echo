import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import { Tooltip } from '@mui/material';
import { useRef } from 'react';

import { PowerIconButton } from '../../../components/PowerIconButton';
import { attachmentPreviewHeaderIconButtonSx } from '../../shared/message-card/attachment-preview/MessageCardAttachmentPreviewHeader';
import type { MessageCardPreviewNavigation } from '../../shared/message-card/attachment-preview/message-card-preview.types';
import type { DeviceFilesState } from '../use-device-files';
import { isDeviceFolder } from '../device-file-archive';

function previewSiblings(files: DeviceFilesState) {
  return (files.searchResultsVisible ? files.searchEntries : files.directory.entries).filter(
    (entry) => !isDeviceFolder(entry),
  );
}

export function useDeviceFilePreviewNavigation(files: DeviceFilesState) {
  const retained = useRef<{ scope: string; entries: ReturnType<typeof previewSiblings> } | null>(
    null,
  );
  const scope = JSON.stringify([
    files.deviceId,
    files.searchResultsVisible
      ? [
          'search',
          files.searchLocation?.query,
          files.searchLocation?.scopeId,
          files.searchLocation?.scopeRevision,
          files.searchLocation?.global,
        ]
      : ['directory', files.selectedDirectory, files.directoryRevision],
    files.sorting,
    files.appliedListingFilters,
  ]);
  if (!files.selectedFile) {
    retained.current = null;
    return undefined;
  }
  const siblings = previewSiblings(files);
  if (retained.current?.scope !== scope) {
    retained.current = { scope, entries: siblings };
  } else {
    const currentIds = new Set(retained.current.entries.map((entry) => entry.entryId));
    retained.current.entries = [
      ...retained.current.entries,
      ...siblings.filter((entry) => !currentIds.has(entry.entryId)),
    ];
  }
  return getDeviceFilePreviewNavigation(files, retained.current.entries);
}

export function getDeviceFilePreviewNavigation(
  files: DeviceFilesState,
  siblings = previewSiblings(files),
): MessageCardPreviewNavigation | undefined {
  const index = siblings.findIndex((entry) => entry.entryId === files.selectedFile?.entryId);
  if (index < 0) return undefined;
  const previous = index > 0 ? siblings[index - 1] : null;
  const next = index + 1 < siblings.length ? siblings[index + 1] : null;
  return {
    index,
    count: siblings.length,
    previousDisabled: !previous,
    nextDisabled: !next,
    onPrevious: () => previous && files.selectFile(previous),
    onNext: () => next && files.selectFile(next),
  };
}

export function DeviceFileFavoriteAction({ files }: { files: DeviceFilesState }) {
  const file = files.selectedFile;
  if (!file) return null;
  return (
    <Tooltip title={file.isFavorite ? 'Прибрати з обраного' : 'Додати в обране'}>
      <span>
        <PowerIconButton
          size="small"
          sx={attachmentPreviewHeaderIconButtonSx}
          aria-label={file.isFavorite ? 'Прибрати файл з обраного' : 'Додати файл в обране'}
          aria-pressed={file.isFavorite}
          disabled={files.favoritePending.has(file.entryId)}
          onClick={() => files.toggleFavorite(file)}
        >
          {file.isFavorite ? (
            <StarIcon fontSize="small" className="text-echo-warning" />
          ) : (
            <StarBorderIcon fontSize="small" />
          )}
        </PowerIconButton>
      </span>
    </Tooltip>
  );
}
