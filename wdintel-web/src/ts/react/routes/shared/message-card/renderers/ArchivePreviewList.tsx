import AudioFileIcon from '@mui/icons-material/AudioFile';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import FolderZipOutlinedIcon from '@mui/icons-material/FolderZipOutlined';
import ImageIcon from '@mui/icons-material/Image';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';
import VideocamIcon from '@mui/icons-material/Videocam';
import { Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { formatSizeBytes } from '../message-card-image-utils';

const IMAGE_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'heic',
  'heif',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'tif',
  'tiff',
  'webp',
]);
const VIDEO_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'webm']);
const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav']);
const MAP_EXTENSIONS = new Set(['geojson', 'gpx', 'kml', 'kmz']);
const SPREADSHEET_EXTENSIONS = new Set(['csv', 'xls', 'xlsx']);
const DOCUMENT_EXTENSIONS = new Set(['doc', 'docx', 'md', 'pdf', 'txt']);
const ARCHIVE_EXTENSIONS = new Set(['7z', 'gz', 'rar', 'tar', 'tgz', 'zip']);

function archiveEntryIcon(name: string, directory: boolean) {
  if (directory) return <FolderOutlinedIcon fontSize="small" />;
  const extension = /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase();
  if (extension && IMAGE_EXTENSIONS.has(extension)) return <ImageIcon fontSize="small" />;
  if (extension && VIDEO_EXTENSIONS.has(extension)) return <VideocamIcon fontSize="small" />;
  if (extension && AUDIO_EXTENSIONS.has(extension)) return <AudioFileIcon fontSize="small" />;
  if (extension && MAP_EXTENSIONS.has(extension)) return <MapOutlinedIcon fontSize="small" />;
  if (extension && SPREADSHEET_EXTENSIONS.has(extension))
    return <TableChartOutlinedIcon fontSize="small" />;
  if (extension && DOCUMENT_EXTENSIONS.has(extension))
    return <DescriptionOutlinedIcon fontSize="small" />;
  if (extension && ARCHIVE_EXTENSIONS.has(extension))
    return <FolderZipOutlinedIcon fontSize="small" />;
  return <InsertDriveFileOutlinedIcon fontSize="small" />;
}

export function ArchivePreviewList({ children }: { children: ReactNode }) {
  return (
    <ul className="m-0 list-none overflow-hidden rounded border border-divider p-0 [&>li]:border-b [&>li]:border-divider [&>li:last-child]:border-b-0">
      {children}
    </ul>
  );
}

export function ArchivePreviewRow({
  name,
  directory = false,
  sizeBytes,
  unavailableReason,
  hasContent = true,
  onOpen,
  selected = false,
  expanded,
  childrenId,
  toggle,
  action,
}: {
  name: string;
  directory?: boolean;
  sizeBytes?: number | null;
  unavailableReason?: string | null;
  hasContent?: boolean;
  onOpen?: () => void;
  selected?: boolean;
  expanded?: boolean;
  childrenId?: string;
  toggle?: ReactNode;
  action?: ReactNode;
}) {
  const content = (
    <>
      <span className="inline-flex shrink-0 text-echo-text-muted" aria-hidden>
        {archiveEntryIcon(name, directory)}
      </span>
      <Typography
        component="span"
        noWrap
        title={name}
        className="min-w-0 flex-1"
        data-zip-entry-name="true"
      >
        {name}
      </Typography>
      <Typography
        component="span"
        variant="caption"
        color="text.secondary"
        className="max-w-[40%] shrink-0 truncate text-right"
        title={unavailableReason ?? (directory ? undefined : 'Розпакований розмір')}
        data-zip-entry-size="true"
      >
        {directory ? 'Папка' : sizeBytes == null ? '—' : formatSizeBytes(sizeBytes)}
        {unavailableReason ? ` · ${unavailableReason}` : ''}
      </Typography>
    </>
  );
  return (
    <div
      className={`flex min-w-0 items-center gap-2 px-3 py-2 ${selected ? 'bg-echo-primary/15' : ''} ${hasContent ? '' : 'opacity-55'}`}
    >
      {toggle}
      {onOpen ? (
        <button
          type="button"
          aria-label={name}
          aria-current={selected ? 'true' : undefined}
          aria-pressed={selected}
          aria-description={hasContent ? undefined : 'Контент файлу відсутній'}
          aria-expanded={expanded}
          aria-controls={childrenId}
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent p-0 text-left text-inherit focus-visible:outline focus-visible:outline-echo-focus"
        >
          {content}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{content}</div>
      )}
      {action}
    </div>
  );
}
