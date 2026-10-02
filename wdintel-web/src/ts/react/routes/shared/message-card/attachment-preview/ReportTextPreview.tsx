import ArticleIcon from '@mui/icons-material/Article';
import { Box, IconButton, TextField, Tooltip } from '@mui/material';
import type { ReactNode } from 'react';

export type AttachmentPreviewReportDraft = {
  kind?: 'message' | 'report';
  label?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

export type AttachmentPreviewReportVisibility = {
  reportVisible: boolean;
  onReportVisibleChange: (visible: boolean) => void;
};

export function ReportTextPreviewAction({
  kind = 'report',
  active,
  onClick,
}: {
  kind?: 'message' | 'report';
  active: boolean;
  onClick: () => void;
}) {
  const subject = kind === 'message' ? 'повідомлення' : 'розвіддонесення';
  const title = active ? `Сховати ${subject}` : `Писати ${subject}`;

  return (
    <Tooltip title={title} enterDelay={300}>
      <IconButton
        aria-label={title}
        aria-pressed={active}
        color={active ? 'primary' : 'default'}
        size="small"
        onClick={onClick}
        sx={{
          color: active ? 'primary.main' : 'text.secondary',
          '&:hover': { color: active ? 'primary.dark' : 'text.primary' },
        }}
      >
        <ArticleIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

export function ReportTextPreviewPane({ draft }: { draft: AttachmentPreviewReportDraft }) {
  const label =
    draft.label ?? (draft.kind === 'message' ? 'Текст повідомлення' : 'Текст розвіддонесення');

  return (
    <div
      role="region"
      aria-label={label}
      data-attachment-preview-report-pane
      className="flex-1 min-h-0 overflow-visible pr-1 max-w-6xl mx-auto w-full"
    >
      <TextField
        label={label}
        value={draft.value}
        onChange={(event) => draft.onChange(event.target.value)}
        disabled={draft.disabled}
        fullWidth
        multiline
        minRows={2}
        maxRows={3}
        size="small"
      />
    </div>
  );
}

export function ReportTextPreviewLayout({
  source,
  draft,
  visible,
}: {
  source: ReactNode;
  draft?: AttachmentPreviewReportDraft;
  visible: boolean;
}) {
  if (draft == null) return source;

  return (
    <Box
      sx={{
        flex: '1 1 0',
        height: 0,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{ display: 'flex', flex: '1 1 100%', minWidth: 0, minHeight: 0, overflow: 'hidden' }}
      >
        {source}
      </Box>
      {visible ? (
        <Box
          data-attachment-preview-scroll
          className="relative flex-col overscroll-contain touch-pan-y px-[16px] py-[8px] border-t border-white/12 bg-inherit text-(--color-text) transition-[max-height] duration-200 ease-out"
          sx={{
            display: 'flex',
            alignItems: 'center',
            flex: '0 0 auto',
            minWidth: 0,
            minHeight: 0,
            maxHeight: 176,
            overflow: 'hidden',
          }}
        >
          <ReportTextPreviewPane draft={draft} />
        </Box>
      ) : null}
    </Box>
  );
}
