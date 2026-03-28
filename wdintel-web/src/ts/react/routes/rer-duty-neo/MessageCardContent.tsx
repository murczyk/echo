import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Box, Button, Collapse, Link, Stack, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';

import type { ContentNode, InboxMessage, Network, Tag } from '../../../../Bindings';
import { PowerChip } from '../../components/PowerChip';
import { getPointEtalonsFromMessage, messageHasPalitraTag, messageRenderDistance } from './utils';
import { renderMarkedText } from './MarkedText';

function networkNeedsInvestigationBadge(network: Network | undefined): boolean {
  if (network == null) return false;
  const ids = network.unitIds;
  if (ids == null) return true;
  return ids.length === 0;
}

function ResolvedNetworkEtalonRows({
  networkIds,
  networkDisplayMap,
  networkMap,
}: {
  networkIds: number[];
  networkDisplayMap: Record<number, string>;
  networkMap: Record<number, Network>;
}) {
  return (
    <Stack spacing={0.5} sx={{ width: '100%', minWidth: 0 }}>
      {networkIds.map((networkId) => {
        const network = networkMap[networkId];
        const label = networkDisplayMap[networkId] ?? (network != null ? `р/м ${network.name}` : 'Невідома мережа');
        const badge = networkNeedsInvestigationBadge(network);
        const hasNetworkLink = network != null;

        return (
          <Stack key={networkId} direction="row" spacing={0.75} alignItems="flex-start" sx={{ width: '100%', minWidth: 0 }}>
            <Box component="i" className="bi bi-people" sx={{ mt: '2px', fontSize: 14, color: 'var(--color-icons)', flexShrink: 0 }} title="Еталонна прив'язка" />
            <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" alignItems="center" sx={{ minWidth: 0 }}>
              {hasNetworkLink ? (
                <Link
                  href={`/rer-networks/${networkId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  underline="hover"
                  color="inherit"
                  sx={{
                    display: 'inline-flex',
                    minWidth: 0,
                    maxWidth: '100%',
                    fontWeight: 700,
                    textDecorationThickness: 'from-font',
                  }}
                  title="Відкрити мережу в новій вкладці"
                >
                  <Typography component="span" variant="body2" sx={{ minWidth: 0, fontWeight: 700, lineHeight: 1.2, overflowWrap: 'anywhere' }}>
                    {label}
                  </Typography>
                </Link>
              ) : (
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  {label}
                </Typography>
              )}
              {badge ? (
                <Box
                  component="span"
                  sx={{
                    px: 0.75,
                    py: 0.25,
                    borderRadius: 0.75,
                    border: '1px solid',
                    borderColor: 'divider',
                    bgcolor: 'var(--color-bg-inactive)',
                    fontSize: 12,
                    lineHeight: 1.1,
                    opacity: 0.9,
                    whiteSpace: 'nowrap',
                  }}
                >
                  в дорозвідці
                </Box>
              ) : null}
            </Stack>
          </Stack>
        );
      })}
    </Stack>
  );
}

function NetworkSection({
  networkIds,
  networkDisplayMap,
  networkMap,
  etalonNoNetworkLabel,
}: {
  networkIds: number[];
  networkDisplayMap: Record<number, string>;
  networkMap: Record<number, Network>;
  etalonNoNetworkLabel: string | null;
}) {
  if (networkIds.length > 0) {
    return (
      <ResolvedNetworkEtalonRows
        networkIds={networkIds}
        networkDisplayMap={networkDisplayMap}
        networkMap={networkMap}
      />
    );
  }

  return (
    <Stack direction="row" spacing={0.75} alignItems="flex-start" sx={{ minWidth: 0 }}>
      <Box component="i" className="bi bi-people" sx={{ mt: '2px', fontSize: 14, color: 'var(--color-icons)', flexShrink: 0 }} title="Еталонна прив'язка" />
      <Typography variant="body2" sx={{ color: etalonNoNetworkLabel != null ? 'text.primary' : 'text.disabled' }}>
        {etalonNoNetworkLabel ?? ' '}
      </Typography>
    </Stack>
  );
}

export function MessageCardWatermark({ authUserName }: { authUserName: string }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: '10%',
          top: '20%',
          transform: 'rotate(-28deg)',
          fontSize: 'clamp(1.5rem, 4vw, 2.25rem)',
          fontWeight: 600,
          opacity: 0.08,
          color: 'currentColor',
          whiteSpace: 'nowrap',
        }}
      >
        {authUserName}
      </span>
      <span
        style={{
          position: 'absolute',
          right: '5%',
          bottom: '15%',
          transform: 'rotate(-28deg)',
          fontSize: 'clamp(1.5rem, 4vw, 2.25rem)',
          fontWeight: 600,
          opacity: 0.08,
          color: 'currentColor',
          whiteSpace: 'nowrap',
        }}
      >
        {authUserName}
      </span>
    </div>
  );
}

function MessageCardTagChips({
  compact = false,
  msg,
  tagsMap,
  onToggleTag,
}: {
  compact?: boolean;
  msg: InboxMessage;
  tagsMap: Record<number, Tag>;
  onToggleTag: (tagId: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleTagCount = 5;
  const tagIds = Object.keys(tagsMap);
  const inboxTagList = msg.inboxTags ?? [];
  const selectedTagIds = tagIds.filter((tagId) => (
    inboxTagList.length > 0
      ? inboxTagList.some((tag) => tag.tagId === Number(tagId))
      : (msg.tags ?? []).includes(Number(tagId))
  ));
  const unselectedTagIds = tagIds.filter((tagId) => !selectedTagIds.includes(tagId));
  const visibleTagIds = [...selectedTagIds, ...unselectedTagIds].slice(0, visibleTagCount);
  const hiddenTagIds = tagIds.filter((tagId) => !visibleTagIds.includes(tagId));

  function renderTagChip(tagId: string) {
    const tag = tagsMap[tagId];
    const label = tag.label ?? `#${tagId}`;
    const isSet =
      inboxTagList.length > 0
        ? inboxTagList.some((t) => t.tagId === Number(tagId))
        : (msg.tags ?? []).includes(Number(tagId));
    const contribs = inboxTagList.filter((t) => t.tagId === Number(tagId));
    const humanContribs = contribs.filter((t) => !t.model);
    const botContribs = contribs.filter((t) => t.model);
    const humanLogins = humanContribs.map((t) => t.login).filter(Boolean) as string[];
    const bots = botContribs.map((t) => `${t.model} (${Math.round((t.confidence ?? 0) * 100)}%)`);
    const tip =
      isSet &&
      (humanContribs.length > 0 || botContribs.length > 0) &&
      [
        ...(humanLogins.length > 0
          ? [`Користувачі: ${humanLogins.join(', ')}`]
          : humanContribs.length > 0
            ? ['Користувачі: (ваш вибір)']
            : []),
        ...(bots.length > 0 ? [`Боти: ${bots.join(', ')}`] : []),
      ].join('\n');
    const showBadge = isSet && (humanContribs.length > 0 || botContribs.length > 0);

    return (
      <Tooltip key={tagId} title={tip} placement="top">
        <Box component="span" sx={{ position: 'relative', display: 'inline-flex' }}>
          <PowerChip
            label={label}
            selected={isSet}
            onClick={() => onToggleTag(Number(tagId))}
            size="small"
            fontSize="0.875rem"
            unselectedBackgroundColor="var(--color-background)"
            unselectedBorderColor="var(--text-color)"
            unselectedTextColor="var(--text-color)"
            selectedBackgroundColor="var(--color-tag-selected)"
            selectedBorderColor="var(--color-border-selected)"
            selectedTextColor="var(--neutral-900)"
          />
          {showBadge ? (
            <Box
              component="span"
              sx={{
                position: 'absolute',
                top: -13,
                right: -4,
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                px: 0.75,
                py: 0.25,
                borderRadius: 999,
                border: '1px solid',
                borderColor: 'divider',
                bgcolor: 'var(--color-card)',
                fontSize: 12,
                boxShadow: 1,
              }}
              aria-hidden
            >
              {botContribs.length > 0 ? (
                <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }} title="Боти">
                  <Box component="i" className="bi bi-robot" />
                  <span>{botContribs.length}</span>
                </Box>
              ) : null}
              {humanContribs.length > 0 ? (
                <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }} title="Користувачі">
                  <Box component="i" className="bi bi-person-fill" />
                  <span>{humanContribs.length}</span>
                </Box>
              ) : null}
            </Box>
          ) : null}
        </Box>
      </Tooltip>
    );
  }

    return (
    <Stack spacing={compact ? 0.75 : 0.5} sx={{ minWidth: 0 }}>
      {visibleTagIds.length > 0 ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
          {visibleTagIds.map(renderTagChip)}
        </Box>
      ) : null}
      {hiddenTagIds.length > 0 ? (
        <Button
          size="small"
          variant="text"
          onClick={() => setExpanded((prev) => !prev)}
          endIcon={
            <ExpandMoreIcon
              sx={{
                fontSize: 16,
                transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 160ms ease',
              }}
            />
          }
          sx={{
            alignSelf: 'flex-start',
            minWidth: 0,
            px: 0.75,
            py: 0.5,
            mt: 1.25,
            color: 'text.secondary',
            textTransform: 'none',
            fontSize: 12,
            lineHeight: 1.2,
          }}
        >
          {expanded
            ? 'Сховати інші теги'
            : `Ще ${hiddenTagIds.length} тег${hiddenTagIds.length === 1 ? '' : hiddenTagIds.length < 5 ? 'и' : 'ів'}`}
        </Button>
      ) : null}
      <Collapse in={expanded} timeout="auto" unmountOnExit>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, pt: 0.25 }}>
          {hiddenTagIds.map(renderTagChip)}
        </Box>
      </Collapse>
    </Stack>
  );
}

export function MessageCardEtalonLocationTime({
  compact = false,
  networkIds,
  networkDisplayMap,
  networkMap,
  etalonNoNetworkLabel,
  msg,
  relativeTimeMs,
}: {
  compact?: boolean;
  networkIds: number[];
  networkDisplayMap: Record<number, string>;
  networkMap: Record<number, Network>;
  etalonNoNetworkLabel: string | null;
  msg: InboxMessage;
  relativeTimeMs: number | null;
}) {
  const timeDistance =
    msg.timestamp != null && relativeTimeMs != null ? messageRenderDistance(msg.timestamp, relativeTimeMs) : null;

  if (compact) {
    return (
      <Stack spacing={1.25} sx={{ minWidth: 0 }}>
        <NetworkSection
          networkIds={networkIds}
          networkDisplayMap={networkDisplayMap}
          networkMap={networkMap}
          etalonNoNetworkLabel={etalonNoNetworkLabel}
        />
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1} useFlexGap flexWrap="wrap" sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={0.75} alignItems="flex-start" sx={{ minWidth: 0, flex: 1 }}>
            <Box component="i" className="bi bi-geo" sx={{ mt: '2px', fontSize: 14, color: 'var(--color-icons)', flexShrink: 0 }} title="Локація" />
            <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: 'anywhere', fontWeight: 600 }}>
              {msg.location ?? 'Не встановлена'}
            </Typography>
          </Stack>
          {timeDistance != null ? (
            <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'nowrap', flexShrink: 0 }}>
              {timeDistance}
            </Typography>
          ) : null}
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
        minWidth: 0,
        alignItems: 'start',
      }}
    >
      <Box sx={{ minWidth: 0, pl: 0, pr: 2 }}>
        <NetworkSection
          networkIds={networkIds}
          networkDisplayMap={networkDisplayMap}
          networkMap={networkMap}
          etalonNoNetworkLabel={etalonNoNetworkLabel}
        />
      </Box>
      <Stack
        direction="row"
        spacing={0.75}
        alignItems="flex-start"
        justifyContent="center"
        sx={{ minWidth: 0, px: 2, justifySelf: 'stretch' }}
      >
        <Box component="i" className="bi bi-geo" sx={{ mt: '2px', fontSize: 14, color: 'var(--color-icons)', flexShrink: 0 }} title="Локація" />
        <Typography variant="body2" sx={{ minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere', fontWeight: 600, textAlign: 'center' }}>
          {msg.location ?? 'Не встановлена'}
        </Typography>
      </Stack>
      <Box sx={{ minWidth: 0, pl: 2, pr: 2, textAlign: 'right' }}>
        {timeDistance != null ? (
          <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
            {timeDistance}
          </Typography>
        ) : null}
      </Box>
    </Box>
  );
}

export function MessageCardMessageBody({
  compact = false,
  msg,
  tagsMap,
  onToggleTag,
}: {
  compact?: boolean;
  msg: InboxMessage;
  tagsMap: Record<number, Tag>;
  onToggleTag: (tagId: number) => void;
}) {
  const showPointLinks = messageHasPalitraTag(msg, tagsMap);
  const textPrimary =
    msg.textMarked && msg.textMarked.length > 0
      ? renderMarkedText(msg.textMarked, msg.text ?? '', getPointEtalonsFromMessage(msg, tagsMap), {
          showPointLinks,
        })
      : msg.text || '—';

  return (
    <Stack spacing={compact ? 1.5 : 1.25} sx={{ minWidth: 0 }}>
      <Typography
        component="div"
        variant="body2"
        className={msg.textMarked && msg.textMarked.length > 0 ? 'text-marked' : undefined}
        sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.35 }}
      >
        {textPrimary}
      </Typography>
      {msg.extendedForm != null && msg.extendedForm.trim() !== '' ? (
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
          <Box component="i" className="bi bi-chat-text" sx={{ fontSize: 13, color: 'var(--color-icons)', flexShrink: 0 }} title="Коментар" />
          <Typography variant="caption" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
            {msg.extendedForm}
          </Typography>
        </Stack>
      ) : null}
      <Box sx={{ pt: 0.25, minWidth: 0 }}>
        <MessageCardTagChips compact={compact} msg={msg} tagsMap={tagsMap} onToggleTag={onToggleTag} />
      </Box>
    </Stack>
  );
}
