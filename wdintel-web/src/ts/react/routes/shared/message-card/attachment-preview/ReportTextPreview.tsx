import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import { IconButton, TextField, Tooltip } from '@mui/material';

export type AttachmentPreviewReportDraft = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

export type AttachmentPreviewReportVisibility = {
  reportVisible: boolean;
  onReportVisibleChange: (visible: boolean) => void;
};

export function ReportTextPreviewAction({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  const title = active ? 'Сховати розвіддонесення' : 'Писати розвіддонесення';

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
        <ArticleOutlinedIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

export function ReportTextPreviewPane({ draft }: { draft: AttachmentPreviewReportDraft }) {
  return (
    <div
      role="region"
      aria-label="Текст розвіддонесення"
      data-attachment-preview-report-pane
      className="flex-1 min-h-0 overflow-visible pr-1 max-w-6xl mx-auto w-full"
    >
      <TextField
        label="Текст розвіддонесення"
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
