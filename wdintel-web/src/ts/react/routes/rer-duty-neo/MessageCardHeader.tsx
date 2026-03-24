import {
  Box,
  IconButton,
  Link,
  Stack,
  Tooltip,
  Typography,
  type SxProps,
  type Theme,
} from '@mui/material';

import type { InboxMessage } from '../../../../Bindings';
import { buildAnalysisHref, formatDateNoYear, formatTime } from './utils';

type ActionIconsRowProps = {
  id: number;
  msg: InboxMessage;
  copiedFeedbackId: string | null;
  onBookmark: () => void;
  onImportant: () => void;
  onComment: () => void;
  onCopyText: () => void;
  onDelete?: () => void;
  onEditDetails?: () => void;
  sx?: SxProps<Theme>;
};

function ActionIconButton({
  title,
  iconClassName,
  onClick,
}: {
  title: string;
  iconClassName: string;
  onClick: () => void;
}) {
  return (
    <Tooltip title={title}>
      <IconButton
        size="small"
        aria-label={title}
        onClick={onClick}
        sx={{
          width: 26,
          height: 26,
          color: 'var(--color-action)',
          borderRadius: 0.75,
          '& .bi': { fontSize: 15 },
        }}
      >
        <Box component="i" className={iconClassName} />
      </IconButton>
    </Tooltip>
  );
}

function ActionIconsRow({
  id,
  msg,
  copiedFeedbackId,
  onBookmark,
  onImportant,
  onComment,
  onCopyText,
  onDelete,
  onEditDetails,
  sx,
}: ActionIconsRowProps) {
  return (
    <Stack direction="row" spacing={0.25} useFlexGap flexWrap="wrap" alignItems="center" sx={sx}>
      <ActionIconButton
        title={msg.bookmarked ? 'Прибрати закладку' : 'Додати в закладки'}
        iconClassName={msg.bookmarked ? 'bi bi-bookmark-fill' : 'bi bi-bookmark'}
        onClick={onBookmark}
      />
      <ActionIconButton
        title={msg.important ? 'Прибрати важливе' : 'Помітити як важливе'}
        iconClassName={msg.important ? 'bi bi-exclamation-triangle-fill' : 'bi bi-exclamation-triangle'}
        onClick={onImportant}
      />
      <ActionIconButton title="Редагувати коментар" iconClassName="bi bi-chat-square" onClick={onComment} />
      <ActionIconButton
        title="Копіювати"
        iconClassName={copiedFeedbackId === `text-${id}` ? 'bi bi-clipboard-check-fill' : 'bi bi-clipboard'}
        onClick={onCopyText}
      />
      {onDelete != null ? (
        <ActionIconButton title="Видалити" iconClassName="bi bi-trash" onClick={onDelete} />
      ) : null}
      {onEditDetails != null ? (
        <ActionIconButton title="Редагувати додаткові поля" iconClassName="bi bi-sliders" onClick={onEditDetails} />
      ) : null}
    </Stack>
  );
}

function MetaLine({
  iconClassName,
  title,
  text,
}: {
  iconClassName: string;
  title: string;
  text: string;
}) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }} title={text}>
      <Box component="i" className={iconClassName} sx={{ color: 'var(--color-icons)', fontSize: 14, flexShrink: 0 }} title={title} />
      <Typography variant="caption" sx={{ minWidth: 0, color: 'text.secondary' }} noWrap>
        {text}
      </Typography>
    </Stack>
  );
}

function AnalysisLinks({ msg, mapHref }: { msg: InboxMessage; mapHref: string }) {
  return (
    <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap" alignItems="center">
      <Link
        href={buildAnalysisHref(msg, false)}
        target="_blank"
        rel="noopener noreferrer"
        underline="hover"
        color="inherit"
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 12, whiteSpace: 'nowrap' }}
      >
        <Box component="i" className="bi bi-bar-chart-line" />
        <span>Аналіз</span>
        <Box component="i" className="bi bi-box-arrow-up-right" sx={{ fontSize: 11 }} />
      </Link>
      <Link
        href={mapHref}
        target="_blank"
        rel="noopener noreferrer"
        underline="hover"
        color="inherit"
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 12, whiteSpace: 'nowrap' }}
      >
        <Box component="i" className="bi bi-map" />
        <span>Карта</span>
        <Box component="i" className="bi bi-box-arrow-up-right" sx={{ fontSize: 11 }} />
      </Link>
    </Stack>
  );
}

export type MessageCardHeaderProps = {
  layout: 'fluid' | 'dividers';
  compact?: boolean;
  feedCount: number;
  id: number;
  msg: InboxMessage;
  mapHref: string;
  copiedFeedbackId: string | null;
  groupName: string | null;
  senderName: string | null;
  onBookmark: () => void;
  onImportant: () => void;
  onComment: () => void;
  onCopyText: () => void;
  onCopyFreq: () => void;
  onDelete?: () => void;
  onEditDetails?: () => void;
};

export function MessageCardHeader({
  layout,
  compact = false,
  feedCount,
  id,
  msg,
  mapHref,
  copiedFeedbackId,
  groupName,
  senderName,
  onBookmark,
  onImportant,
  onComment,
  onCopyText,
  onCopyFreq,
  onDelete,
  onEditDetails,
}: MessageCardHeaderProps) {
  const dateTimeBlock = (
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
      <Stack direction="row" spacing={0.5} alignItems="center">
        <Box component="i" className="bi bi-clock" sx={{ color: 'var(--color-icons)', fontSize: 14 }} />
        <Typography variant="caption">{formatTime(msg.time)}</Typography>
      </Stack>
      {msg.date != null ? (
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Box component="i" className="bi bi-calendar" sx={{ color: 'var(--color-icons)', fontSize: 14 }} />
          <Typography variant="caption">{formatDateNoYear(msg.date)}</Typography>
        </Stack>
      ) : null}
    </Stack>
  );

  const freqBlock = msg.freq != null ? (
    <Stack direction="row" spacing={0.25} alignItems="center" sx={{ flexShrink: 0, marginRight: '-6px !important' }}>
      <Stack direction="row" spacing={0.5} alignItems="center">
        <Box component="i" className="bi bi-broadcast" sx={{ color: 'var(--color-icons)', fontSize: 14 }} title="Частота" />
        <Typography variant="caption" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
          {msg.freq}
        </Typography>
      </Stack>
      <ActionIconButton
        title="Копіювати частоту"
        iconClassName={copiedFeedbackId === `freq-${id}` ? 'bi bi-clipboard-check-fill' : 'bi bi-clipboard'}
        onClick={onCopyFreq}
      />
    </Stack>
  ) : null;

  if (layout === 'fluid') {
    return (
      <Stack spacing={1}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1.5} useFlexGap flexWrap="wrap">
          {dateTimeBlock}
          {groupName != null ? <MetaLine iconClassName="bi bi-signal" title="Група" text={groupName} /> : null}
          {senderName != null ? <MetaLine iconClassName="bi bi-person-circle" title="Відправник" text={senderName} /> : null}
          {freqBlock}
        </Stack>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1.5} useFlexGap flexWrap="wrap">
          <AnalysisLinks msg={msg} mapHref={mapHref} />
          <ActionIconsRow
            id={id}
            msg={msg}
            copiedFeedbackId={copiedFeedbackId}
            onBookmark={onBookmark}
            onImportant={onImportant}
            onComment={onComment}
            onCopyText={onCopyText}
            onDelete={onDelete}
            onEditDetails={onEditDetails}
          />
        </Stack>
      </Stack>
    );
  }

  if (compact) {
    return (
      <Stack spacing={0.75} sx={{ pb: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1.25} useFlexGap flexWrap="wrap">
          {dateTimeBlock}
          {freqBlock}
        </Stack>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1.25} useFlexGap flexWrap="wrap" sx={{ minWidth: 0 }}>
          <Stack
            direction="row"
            spacing={1.25}
            useFlexGap
            flexWrap="wrap"
            alignItems="center"
            sx={{ flex: 1, minWidth: 0, '& > *': { maxWidth: '100%' } }}
          >
            {groupName != null ? <MetaLine iconClassName="bi bi-signal" title="Група" text={groupName} /> : null}
            {senderName != null ? <MetaLine iconClassName="bi bi-person-circle" title="Відправник" text={senderName} /> : null}
            <AnalysisLinks msg={msg} mapHref={mapHref} />
          </Stack>
          <ActionIconsRow
            id={id}
            msg={msg}
            copiedFeedbackId={copiedFeedbackId}
            onBookmark={onBookmark}
            onImportant={onImportant}
            onComment={onComment}
            onCopyText={onCopyText}
            onDelete={onDelete}
            onEditDetails={onEditDetails}
          />
        </Stack>
      </Stack>
    );
  }

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        width: '100%',
        alignItems: 'stretch',
      }}
    >
      <Stack
        spacing={1}
        sx={{
          minWidth: 0,
          pl: 0,
          pr: 2,
          pt: 0.5,
          justifyContent: 'center',
          borderRight: '1px solid',
          borderColor: 'divider',
        }}
      >
        {dateTimeBlock}
        <ActionIconsRow
          sx={{ marginLeft: '-6px !important' }}
          id={id}
          msg={msg}
          copiedFeedbackId={copiedFeedbackId}
          onBookmark={onBookmark}
          onImportant={onImportant}
          onComment={onComment}
          onCopyText={onCopyText}
          onDelete={onDelete}
          onEditDetails={onEditDetails}
        />
      </Stack>
      <Stack
        spacing={0.75}
        sx={{
          minWidth: 0,
          px: 2,
          pt: 0.5,
          alignItems: 'center',
          justifyContent: 'center',
          borderRight: '1px solid',
          borderColor: 'divider',
        }}
      >
        {groupName != null ? <MetaLine iconClassName="bi bi-signal" title="Група" text={groupName} /> : <Typography variant="caption" color="text.secondary">—</Typography>}
        {senderName != null ? <MetaLine iconClassName="bi bi-person-circle" title="Відправник" text={senderName} /> : <Typography variant="caption" color="text.secondary">—</Typography>}
      </Stack>
      <Stack spacing={0.75} alignItems="flex-end" justifyContent="center" sx={{ minWidth: 0, pl: 2, pr: 2, pt: 0.5 }}>
        {freqBlock ?? <Typography variant="caption" color="text.secondary">—</Typography>}
        <AnalysisLinks msg={msg} mapHref={mapHref} />
      </Stack>
    </Box>
  );
}
