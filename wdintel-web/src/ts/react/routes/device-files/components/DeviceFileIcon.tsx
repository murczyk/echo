import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import FolderIcon from '@mui/icons-material/Folder';
import FolderZipOutlinedIcon from '@mui/icons-material/FolderZipOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { SvgIcon, type SvgIconProps } from '@mui/material';
import { useId } from 'react';

import { attachmentIcon } from '../../../components/attachment-files';
import type { DeviceFileSelection } from '../device-file-archive';
import { normalizeFilePreviewMetadata } from '../../shared/message-card/attachment-preview/file-preview-source';

type IconEntry = Pick<DeviceFileSelection, 'kind' | 'name'> &
  Partial<Pick<DeviceFileSelection, 'extension' | 'mimeType' | 'isArchive' | 'archive'>>;

export function DeviceFileIcon({
  entry,
  expanded = false,
  className = '',
  ...props
}: SvgIconProps & { entry: IconEntry; expanded?: boolean }) {
  const maskId = useId();
  const metadata = normalizeFilePreviewMetadata({
    fileName: entry.name,
    extension: entry.extension,
    contentType: entry.mimeType,
  });
  const passwordProtected = entry.kind === 'file' && entry.archive?.reason === 'password_protected';
  const Icon =
    entry.kind === 'directory'
      ? expanded
        ? FolderOpenIcon
        : FolderIcon
      : entry.isArchive
        ? FolderZipOutlinedIcon
        : attachmentIcon(
            metadata.extension ? `file.${metadata.extension}` : metadata.fileName,
            metadata.contentType,
          );
  const folder = entry.kind === 'directory' || Icon === FolderZipOutlinedIcon;
  const iconClassName = `${folder ? 'text-echo-folder-icon' : ''} ${className}`;
  if (passwordProtected) {
    return (
      <SvgIcon {...props} titleAccess="Архів захищений паролем" className={iconClassName}>
        <defs>
          <mask id={maskId}>
            <rect width="24" height="24" fill="white" />
            <rect x="14" y="12" width="10" height="12" rx="2" fill="black" />
          </mask>
        </defs>
        <g mask={`url(#${maskId})`}>
          <Icon component="g" />
        </g>
        <LockOutlinedIcon component="g" transform="translate(13 12) scale(0.5)" />
      </SvgIcon>
    );
  }
  return <Icon {...props} className={iconClassName} />;
}
