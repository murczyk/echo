import AttachFileIcon from '@mui/icons-material/AttachFile';
import { Chip, CircularProgress, IconButton, Stack, Tooltip } from '@mui/material';
import { useRef } from 'react';
import { aiAgentUploadUrl, type AiAgentUpload } from '../../services/api/ai-agent';
import { AI_CHAT_UPLOAD_ACCEPT, type ComposerAttachment } from './composer-attachments';

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function processingLabel(item: ComposerAttachment): string {
  if (item.status === 'uploading') return 'завантаження…';
  if (item.status === 'error') return item.error ?? 'помилка';
  switch (item.upload?.state) {
    case 'ready':
      return formatFileSize(item.sizeBytes);
    case 'failed':
      return item.upload.lastError ?? 'не вдалося обробити';
    default:
      return 'обробка…';
  }
}

export function AttachFileButton({
  disabled,
  onFiles,
}: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Tooltip title="Додати файли">
        <span>
          <IconButton
            size="small"
            aria-label="Додати файли"
            disabled={disabled}
            onClick={() => input.current?.click()}
            sx={{ color: 'text.secondary' }}
          >
            <AttachFileIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={AI_CHAT_UPLOAD_ACCEPT}
        data-testid="ai-agent-chat-file-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

export function ComposerAttachments({
  attachments,
  onRemove,
}: {
  attachments: ComposerAttachment[];
  onRemove: (localId: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <Stack
      direction="row"
      flexWrap="wrap"
      useFlexGap
      spacing={0.75}
      sx={{ mb: 0.75 }}
      data-testid="ai-agent-chat-attachments"
    >
      {attachments.map((item) => {
        const failed = item.status === 'error' || item.upload?.state === 'failed';
        const busy =
          item.status === 'uploading' ||
          (item.upload && ['uploaded', 'extracting'].includes(item.upload.state));
        return (
          <Chip
            key={item.localId}
            size="small"
            variant="outlined"
            color={failed ? 'error' : 'default'}
            icon={busy ? <CircularProgress size={12} /> : <AttachFileIcon fontSize="small" />}
            label={`${item.fileName} · ${processingLabel(item)}`}
            onDelete={() => onRemove(item.localId)}
            sx={{ maxWidth: 320 }}
          />
        );
      })}
    </Stack>
  );
}

export function MessageAttachments({ attachments }: { attachments: AiAgentUpload[] }) {
  if (attachments.length === 0) return null;
  return (
    <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.75} sx={{ mt: 0.75 }}>
      {attachments.map((upload) => (
        <Chip
          key={upload.id}
          size="small"
          variant="outlined"
          component="a"
          clickable
          href={aiAgentUploadUrl(upload.id)}
          target="_blank"
          rel="noopener noreferrer"
          color={upload.state === 'failed' ? 'error' : 'default'}
          icon={<AttachFileIcon fontSize="small" />}
          label={`${upload.fileName} · ${formatFileSize(upload.sizeBytes)}`}
          sx={{ maxWidth: 320 }}
        />
      ))}
    </Stack>
  );
}
