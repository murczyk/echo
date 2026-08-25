import DescriptionIcon from '@mui/icons-material/Description';
import ImageIcon from '@mui/icons-material/Image';
import { Collapse, FormControlLabel, Switch } from '@mui/material';

function MessageCardSummaryPreviewMock({ mediaSummaryEnabled }: { mediaSummaryEnabled: boolean }) {
  return (
    <div
      data-message-card-mock="true"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className="flex max-w-105 cursor-default flex-col gap-2 rounded-xl border border-echo-divider bg-black/2 p-3 dark:bg-white/2"
    >
      {/* Header skeleton */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <div className="h-2.25 w-20 rounded-sm bg-echo-text-muted/40" />
          <div className="h-2.25 w-10 rounded-sm bg-echo-text-muted/25" />
        </div>
        <div className="h-2.25 w-6.5 rounded-sm bg-echo-text-muted/25" />
      </div>

      {/* Attachment skeleton */}
      <div className="flex items-center gap-2">
        <div className="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded bg-echo-primary text-echo-on-primary">
          <ImageIcon sx={{ fontSize: 14 }} />
        </div>
        <div className="h-2.25 w-30 rounded-sm bg-echo-text-muted/35" />
      </div>

      {/* Animated AI Summary skeleton */}
      <Collapse in={mediaSummaryEnabled} timeout={250} unmountOnExit={false}>
        <div
          data-media-summary-mock="true"
          className="flex items-start gap-1.5 rounded-md border-l-[3px] border-echo-primary bg-echo-primary/5 p-1.5"
        >
          <DescriptionIcon sx={{ fontSize: 15 }} className="mt-0.5 shrink-0 text-echo-primary" />
          <div className="flex flex-1 flex-col gap-1 pt-1">
            <div className="h-1.75 w-[90%] rounded-sm bg-echo-primary/55" />
            <div className="h-1.75 w-[60%] rounded-sm bg-echo-primary/40" />
          </div>
        </div>
      </Collapse>

      {/* Message body skeleton */}
      <div className="flex flex-col gap-1 pt-0.5">
        <div className="h-1.75 w-[85%] rounded-sm bg-echo-text-muted/30" />
        <div className="h-1.75 w-[50%] rounded-sm bg-echo-text-muted/25" />
      </div>

      {/* Tags skeleton */}
      <div className="flex gap-1.5 pt-0.5">
        <div className="h-3.5 w-11 rounded-sm bg-echo-text-muted/25" />
        <div className="h-3.5 w-14.5 rounded-sm bg-echo-text-muted/25" />
        <div className="h-3.5 w-9 rounded-sm bg-echo-text-muted/25" />
      </div>
    </div>
  );
}

export type SettingsMediaSummaryCardProps = {
  mediaSummaryEnabled: boolean;
  onMediaSummaryEnabledChange: (value: boolean) => void;
  loadInProgress: boolean;
};

export function SettingsMediaSummaryCard({
  mediaSummaryEnabled,
  onMediaSummaryEnabledChange,
  loadInProgress,
}: SettingsMediaSummaryCardProps) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-divider bg-background-paper p-4 sm:p-5">
      <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
        Стислий опис файлів
      </span>
      <FormControlLabel
        sx={{
          alignItems: 'flex-start',
          m: 0,
          gap: 1.5,
          '& .MuiFormControlLabel-label': { width: '100%' },
        }}
        control={
          <Switch
            checked={mediaSummaryEnabled}
            onChange={(_, checked) => onMediaSummaryEnabledChange(checked)}
            disabled={loadInProgress}
          />
        }
        label={
          <div className="flex flex-col gap-1 pt-0.5">
            <span className="text-base font-semibold leading-tight text-text-primary">
              Стислий опис файлів у картках
            </span>
            <span className="text-sm leading-relaxed text-text-secondary">
              Відображати блок стислого опису для зображень та документів у картках повідомлень
              стрічки.
            </span>
          </div>
        }
      />
      <MessageCardSummaryPreviewMock mediaSummaryEnabled={mediaSummaryEnabled} />
    </div>
  );
}
