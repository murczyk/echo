import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import {
  Box,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { isPresent } from '../../utils/misc';

import {
  MessageAttachmentPreviewMode,
  MESSAGE_CARD_QUICK_ACTION_OPTIONS,
  normalizeMessageCardQuickAction,
  type MessageCardQuickAction,
  type MessageTextPreviewLineLimit,
} from '../../services/api/user-settings';
import type { TagsLayoutVariant } from '../rer-duty-neo/utils';
import { MESSAGE_CARD_QUICK_ACTION_ICONS } from '../shared/message-card/MessageCardQuickAction';
import {
  SettingsDutyCardVisibility,
  type SettingsDutyCardVisibilityProps,
} from './SettingsDutyCardVisibility';
import { SettingsMessageCardPreview } from './SettingsMessageCardPreview';

const cardSx = {
  border: 1,
  borderColor: 'divider',
  borderRadius: 2,
  bgcolor: 'background.paper',
  p: { xs: 2, sm: 2.5 },
};

export type SettingsMessageCardProps = {
  messageCardQuickAction: MessageCardQuickAction;
  onMessageCardQuickActionChange: (value: MessageCardQuickAction) => void;
  tagsLayout: TagsLayoutVariant;
  onTagsLayoutChange: (layout: TagsLayoutVariant) => void;
  messageTextPreviewLines: MessageTextPreviewLineLimit;
  onMessageTextPreviewLinesChange: (value: MessageTextPreviewLineLimit) => void;
  aiPositionHighlightsEnabled: boolean;
  aiPositionHighlightsEnabledGlobally: boolean;
  onAiPositionHighlightsEnabledChange: (value: boolean) => void;
  mediaSummaryEnabled: boolean;
  onMediaSummaryEnabledChange: (value: boolean) => void;
  attachmentPreviewMode: MessageAttachmentPreviewMode;
  largeMessageCardText: boolean;
  onLargeMessageCardTextChange: (value: boolean) => void;
  onAttachmentPreviewModeChange: (value: MessageAttachmentPreviewMode) => void;
  loadInProgress: boolean;
  /** Duty-only card parts; omitted on the Analysis tab. */
  dutyCardVisibility?: SettingsDutyCardVisibilityProps;
};

export function SettingsMessageCard({
  messageCardQuickAction,
  onMessageCardQuickActionChange,
  tagsLayout,
  onTagsLayoutChange,
  messageTextPreviewLines,
  onMessageTextPreviewLinesChange,
  mediaSummaryEnabled,
  onMediaSummaryEnabledChange,
  aiPositionHighlightsEnabled,
  aiPositionHighlightsEnabledGlobally,
  onAiPositionHighlightsEnabledChange,
  attachmentPreviewMode,
  largeMessageCardText,
  onLargeMessageCardTextChange,
  onAttachmentPreviewModeChange,
  loadInProgress,
  dutyCardVisibility,
}: SettingsMessageCardProps) {
  return (
    <Box sx={cardSx}>
      <div className="flex flex-col gap-echo-xl">
        <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: 0.8 }}>
          Картка повідомлення
        </Typography>

        <Stack spacing={1}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Розмір тексту:
          </Typography>
          <Box>
            <ToggleButtonGroup
              aria-label="Розмір тексту картки"
              value={largeMessageCardText}
              exclusive
              color="primary"
              size="small"
              disabled={loadInProgress}
              onChange={(_, value: boolean | null) => {
                if (isPresent(value)) onLargeMessageCardTextChange(value);
              }}
              sx={{
                '& .MuiToggleButton-root': {
                  textTransform: 'none',
                  fontSize: 14,
                  px: 2,
                  py: 1,
                },
              }}
            >
              <ToggleButton value={false}>Стандартний</ToggleButton>
              <ToggleButton value={true}>Збільшений</ToggleButton>
            </ToggleButtonGroup>
          </Box>
        </Stack>

        <Stack spacing={1}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Швидка дія для вузької картки:
          </Typography>
          <TextField
            select
            SelectProps={{ inputProps: { 'aria-label': 'Швидка дія для вузької картки' } }}
            value={messageCardQuickAction}
            onChange={(event) => {
              const value = normalizeMessageCardQuickAction(event.target.value);
              if (value !== messageCardQuickAction) onMessageCardQuickActionChange(value);
            }}
            disabled={loadInProgress}
            size="small"
            sx={{ width: 360, maxWidth: '100%', alignSelf: 'flex-start' }}
            helperText="Обрана дія показується поруч із меню без дублювання. Якщо дія недоступна, кнопка приховується."
          >
            {MESSAGE_CARD_QUICK_ACTION_OPTIONS.map((option) => {
              const Icon = MESSAGE_CARD_QUICK_ACTION_ICONS[option.value];
              return (
                <MenuItem key={option.value} value={option.value}>
                  <span className="inline-flex max-w-full items-center gap-echo-sm align-middle">
                    <Icon fontSize="small" className="shrink-0" />
                    <span className="truncate">{option.label}</span>
                  </span>
                </MenuItem>
              );
            })}
          </TextField>
        </Stack>

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
          className="m-0! items-start! gap-echo-md"
          control={
            <Switch
              checked={aiPositionHighlightsEnabledGlobally || aiPositionHighlightsEnabled}
              onChange={(_, checked) => onAiPositionHighlightsEnabledChange(checked)}
              disabled={loadInProgress || aiPositionHighlightsEnabledGlobally}
            />
          }
          label={
            <div className="flex flex-col gap-echo-xs pt-0.5">
              <Typography variant="body1" sx={{ fontWeight: 600, lineHeight: 1.35 }}>
                Показувати ШІ-позиції (експериментально)
              </Typography>
              <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
                Підсвічування позицій та їхні координати у картках оперативного й аналізу.
                {aiPositionHighlightsEnabledGlobally && ' Увімкнено адміністратором для всіх.'}
              </Typography>
            </div>
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

        <fieldset className="m-0 flex min-w-0 flex-col gap-echo-sm border-0 p-0">
          <Typography
            component="legend"
            variant="body2"
            className="p-0"
            sx={{ color: 'text.secondary' }}
          >
            Вкладення:
          </Typography>
          <ToggleButtonGroup
            aria-label="Відображення вкладень"
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
            value={attachmentPreviewMode}
            exclusive
            color="primary"
            size="small"
            disabled={loadInProgress}
            onChange={(_, value: MessageAttachmentPreviewMode | null) => {
              if (isPresent(value)) onAttachmentPreviewModeChange(value);
            }}
          >
            <ToggleButton value={MessageAttachmentPreviewMode.Collapsed}>Згорнуті</ToggleButton>
            <ToggleButton value={MessageAttachmentPreviewMode.Compact}>Компактні</ToggleButton>
            <ToggleButton value={MessageAttachmentPreviewMode.Large}>Збільшені</ToggleButton>
          </ToggleButtonGroup>
          <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
            Розмір попереднього перегляду зображень, відео та координат. У згорнутому режимі
            одночасно можна розгорнути один тип вкладень.
          </Typography>
        </fieldset>

        {dutyCardVisibility ? (
          <SettingsDutyCardVisibility {...dutyCardVisibility} loadInProgress={loadInProgress} />
        ) : null}

        <SettingsMessageCardPreview
          dutyCardVisibility={dutyCardVisibility?.value}
          messageCardQuickAction={messageCardQuickAction}
          largeMessageCardText={largeMessageCardText}
          tagsLayout={tagsLayout}
          mediaSummaryEnabled={mediaSummaryEnabled}
          attachmentPreviewMode={attachmentPreviewMode}
          aiPositionHighlightsEnabled={
            aiPositionHighlightsEnabledGlobally || aiPositionHighlightsEnabled
          }
          messageTextPreviewLines={messageTextPreviewLines}
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
            {dutyCardVisibility
              ? 'Крім «Показувати в Оперативному», налаштування спільні для Оперативного та Аналізу.'
              : 'Спільні налаштування для Оперативного та Аналізу.'}
          </Typography>
        </Stack>
      </div>
    </Box>
  );
}
