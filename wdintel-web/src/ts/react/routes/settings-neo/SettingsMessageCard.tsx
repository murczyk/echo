import DescriptionIcon from '@mui/icons-material/Description';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ImageIcon from '@mui/icons-material/Image';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import {
  Box,
  Collapse,
  FormControlLabel,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { isPresent } from '../../utils/misc';

import type { MessageTextPreviewLineLimit } from '../../services/api/user-settings';
import type { TagsLayoutVariant } from '../rer-duty-neo/utils';

const cardSx = {
  border: 1,
  borderColor: 'divider',
  borderRadius: 2,
  bgcolor: 'background.paper',
  p: { xs: 2, sm: 2.5 },
};

function MessageCardPreviewMock({
  tagsLayout,
  mediaSummaryEnabled,
  collapseMediaPreviews,
}: {
  tagsLayout: TagsLayoutVariant;
  mediaSummaryEnabled: boolean;
  collapseMediaPreviews: boolean;
}) {
  return (
    <div
      data-message-card-mock="true"
      data-message-card-tags-mock="true"
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
      <Collapse in={!collapseMediaPreviews} timeout={250} unmountOnExit>
        <div className="flex items-center gap-2">
          <div className="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded bg-echo-primary text-echo-on-primary">
            <ImageIcon sx={{ fontSize: 14 }} />
          </div>
          <div className="h-2.25 w-30 rounded-sm bg-echo-text-muted/35" />
        </div>
      </Collapse>

      {/* Animated AI Summary skeleton */}
      <Collapse in={mediaSummaryEnabled} timeout={250} unmountOnExit>
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

      {/* Tags skeleton with animated layout changes */}
      <Collapse in={tagsLayout !== 'hidden'} timeout={250} unmountOnExit>
        <div data-tags-mock="true" className="pt-0.5">
          <div className="flex flex-col gap-1.5">
            {/* Row 1 - fills the full line */}
            <div className="flex w-full items-center gap-1.5">
              <div className="h-3.5 flex-1 rounded-sm bg-echo-primary/35" />
              <div className="h-3.5 flex-[1.25] rounded-sm bg-echo-primary/35" />
              <div className="h-3.5 flex-[0.95] rounded-sm bg-echo-primary/35" />
              {tagsLayout === 'full' ? (
                <div className="h-3.5 flex-[1.15] rounded-sm bg-echo-primary/35" />
              ) : (
                <div className="flex h-3.5 flex-[1.15] items-center justify-center gap-1 rounded-sm border border-echo-primary/30 bg-echo-primary/10">
                  <div className="h-1.5 w-9.5 rounded-sm bg-echo-primary/60" />
                  <ExpandMoreIcon sx={{ fontSize: 10 }} className="text-echo-primary/80" />
                </div>
              )}
            </div>

            {/* Row 2 (animated collapse for full mode - exactly 1 tag) */}
            <Collapse in={tagsLayout === 'full'} timeout={250} unmountOnExit>
              <div className="flex gap-1.5">
                <div className="h-3.5 w-[26%] rounded-sm bg-echo-primary/35" />
              </div>
            </Collapse>
          </div>
        </div>
      </Collapse>
    </div>
  );
}

export type SettingsMessageCardProps = {
  tagsLayout: TagsLayoutVariant;
  onTagsLayoutChange: (layout: TagsLayoutVariant) => void;
  messageTextPreviewLines: MessageTextPreviewLineLimit;
  onMessageTextPreviewLinesChange: (value: MessageTextPreviewLineLimit) => void;
  mediaSummaryEnabled: boolean;
  onMediaSummaryEnabledChange: (value: boolean) => void;
  collapseMediaPreviews: boolean;
  onCollapseMediaPreviewsChange: (value: boolean) => void;
  loadInProgress: boolean;
};

export function SettingsMessageCard({
  tagsLayout,
  onTagsLayoutChange,
  messageTextPreviewLines,
  onMessageTextPreviewLinesChange,
  mediaSummaryEnabled,
  onMediaSummaryEnabledChange,
  collapseMediaPreviews,
  onCollapseMediaPreviewsChange,
  loadInProgress,
}: SettingsMessageCardProps) {
  return (
    <Box sx={cardSx}>
      <Stack spacing={2.5}>
        <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: 0.8 }}>
          Картка повідомлення
        </Typography>

        <Stack spacing={1}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Відображення тегів:
          </Typography>
          <Box>
            <ToggleButtonGroup
              value={tagsLayout}
              exclusive
              color="primary"
              onChange={(_, v: TagsLayoutVariant | null) => {
                if (isPresent(v)) onTagsLayoutChange(v);
              }}
              size="small"
              disabled={loadInProgress}
              sx={{
                flexWrap: 'wrap',
                '& .MuiToggleButton-root': {
                  textTransform: 'none',
                  fontSize: 14,
                  px: 2,
                  py: 1,
                  whiteSpace: 'nowrap',
                },
              }}
            >
              <ToggleButton value="full">Повний</ToggleButton>
              <ToggleButton value="compact">Щільний</ToggleButton>
              <ToggleButton value="hidden">Без тегів</ToggleButton>
            </ToggleButtonGroup>
          </Box>
        </Stack>

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
            <Stack spacing={0.5} sx={{ pt: 0.25 }}>
              <Typography variant="body1" sx={{ fontWeight: 600, lineHeight: 1.35 }}>
                Стислий опис файлів
              </Typography>
              <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
                Відображати блок стислого опису для зображень та документів у картках повідомлень
                стрічки.
              </Typography>
            </Stack>
          }
        />

        <FormControlLabel
          sx={{
            alignItems: 'flex-start',
            m: 0,
            gap: 1.5,
            '& .MuiFormControlLabel-label': { width: '100%' },
          }}
          control={
            <Switch
              checked={collapseMediaPreviews}
              onChange={(_, checked) => onCollapseMediaPreviewsChange(checked)}
              disabled={loadInProgress}
            />
          }
          label={
            <Stack spacing={0.5} sx={{ pt: 0.25 }}>
              <Typography variant="body1" sx={{ fontWeight: 600, lineHeight: 1.35 }}>
                Згортати вкладення
              </Typography>
              <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
                Зображення, відео, документи, координати та аудіо спочатку згорнуті; одночасно можна
                розгорнути один тип вкладень.
              </Typography>
            </Stack>
          }
        />

        <MessageCardPreviewMock
          tagsLayout={tagsLayout}
          mediaSummaryEnabled={mediaSummaryEnabled}
          collapseMediaPreviews={collapseMediaPreviews}
        />

        <Stack spacing={1}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Згортати перегляд довгих повідомлень:
          </Typography>
          <Box>
            <ToggleButtonGroup
              value={messageTextPreviewLines === null ? 'off' : String(messageTextPreviewLines)}
              exclusive
              color="primary"
              onChange={(_, value: '20' | '40' | 'off' | null) => {
                if (value === null) return;
                onMessageTextPreviewLinesChange(
                  value === 'off' ? null : (Number(value) as 20 | 40),
                );
              }}
              size="small"
              disabled={loadInProgress}
              sx={{
                flexWrap: 'wrap',
                '& .MuiToggleButton-root': {
                  textTransform: 'none',
                  fontSize: 14,
                  px: 2,
                  py: 1,
                  whiteSpace: 'nowrap',
                },
              }}
            >
              <ToggleButton value="20">20 рядків</ToggleButton>
              <ToggleButton value="40">40 рядків</ToggleButton>
              <ToggleButton value="off">Без скорочення</ToggleButton>
            </ToggleButtonGroup>
          </Box>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Визначає, коли з’являється кнопка «Показати більше».
          </Typography>
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center" sx={{ pt: 0.5 }}>
          <InfoOutlinedIcon sx={{ fontSize: 18, color: 'info.main' }} />
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Спільні налаштування для Оперативного та Аналізу.
          </Typography>
        </Stack>
      </Stack>
    </Box>
  );
}
