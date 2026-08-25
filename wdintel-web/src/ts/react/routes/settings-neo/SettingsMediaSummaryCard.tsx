import DescriptionIcon from '@mui/icons-material/Description';
import ImageIcon from '@mui/icons-material/Image';
import { Box, Collapse, FormControlLabel, Stack, Switch, Typography } from '@mui/material';

const cardSx = {
  border: 1,
  borderColor: 'divider',
  borderRadius: 2,
  bgcolor: 'background.paper',
  p: { xs: 2, sm: 2.5 },
};

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
    <Box sx={cardSx}>
      <Stack spacing={1.5}>
        <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: 0.8 }}>
          Стислий опис файлів
        </Typography>
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
            <Stack spacing={0.75} sx={{ pt: 0.25 }}>
              <Typography variant="body1" sx={{ fontWeight: 600, lineHeight: 1.35 }}>
                Стислий опис файлів у картках
              </Typography>
              <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
                Відображати блок стислого опису для зображень та документів у картках повідомлень
                стрічки.
              </Typography>
            </Stack>
          }
        />
        <MessageCardSummaryPreviewMock mediaSummaryEnabled={mediaSummaryEnabled} />
      </Stack>
    </Box>
  );
}
