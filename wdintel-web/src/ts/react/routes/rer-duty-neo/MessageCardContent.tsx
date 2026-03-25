import { Box, Tooltip } from '@mui/material';

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
    <span className="flex flex-col gap-1 items-start w-full min-w-0">
      {networkIds.map((networkId) => {
        const network = networkMap[networkId];
        const label = networkDisplayMap[networkId] ?? (network != null ? `р/м ${network.name}` : 'Невідома мережа');
        const badge = networkNeedsInvestigationBadge(network);
        const hasNetworkLink = network != null;
        return (
          <span key={networkId} className="flex items-center gap-1 group w-full min-w-0">
            <span className="min-w-0">
              <span className="inline-grid shrink-0 mr-1 place-items-start" title="Еталонна прив'язка">
                <i className="bi bi-people text-icons col-start-1 row-start-1 group-hover:hidden" aria-hidden />
                <i
                  className="bi bi-people-fill text-icons col-start-1 row-start-1 hidden group-hover:inline"
                  aria-hidden
                />
              </span>

              {badge ? (
                <span className="ml-1 shrink-0 rounded border border-border bg-[var(--color-bg-inactive)] px-1.5 py-0.5 text-[10px] leading-none opacity-90">
                  в дорозвідці
                </span>
              ) : null}
              {hasNetworkLink ? (
                <a
                  href={`/rer-networks/${networkId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="items-baseline gap-1 min-w-0 cursor-pointer shrink-0"
                  title="Відкрити мережу в новій вкладці"
                >
                  <span className="min-w-0 break-words font-bold">{label}</span>
                  <i
                    className="bi bi-box-arrow-up-right text-sm ml-1 shrink-0 text-icons/60 transition-[color,transform] duration-150 group-hover:text-action group-hover:scale-110"
                    aria-hidden
                  />
                </a>
              ) : (
                <span className="min-w-0 break-words font-normal">{label}</span>
              )}
            </span>
          </span>
        );
      })}
    </span>
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
  return (
    <>
      {networkIds.length > 0 ? (
        <ResolvedNetworkEtalonRows
          networkIds={networkIds}
          networkDisplayMap={networkDisplayMap}
          networkMap={networkMap}
        />
      ) : etalonNoNetworkLabel != null ? (
        <span className="inline-flex items-center gap-1">
          <i className="bi bi-people text-icons shrink-0 mt-0.5" title="Еталонна прив'язка" />
          <span className="ml-1">{etalonNoNetworkLabel}</span>
        </span>
      ) : (
        <span className="flex items-center gap-1" aria-hidden>
          <i className="bi bi-people text-icons shrink-0 mt-0.5" title="Еталонна прив'язка" />
          <span aria-hidden>{' '}</span>
        </span>
      )}
    </>
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
  msg,
  tagsMap,
  onToggleTag,
}: {
  msg: InboxMessage;
  tagsMap: Record<number, Tag>;
  onToggleTag: (tagId: number) => void;
}) {
  return (
    <Box className="flex flex-wrap gap-1">
      {Object.keys(tagsMap).map((tagId) => {
        const tag = tagsMap[tagId];
        const label = tag.label ?? `#${tagId}`;
        const inboxTagList = msg.inboxTags ?? [];
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
            <Box component="span" className="relative inline-flex">
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
              {showBadge && (
                <span
                  className="absolute -top-[13px] -right-1 flex items-center gap-1 text-[10px] bg-card border border-border rounded-full px-1.5 py-0.5 shadow-sm"
                  aria-hidden
                >
                  {botContribs.length > 0 && (
                    <span className="flex items-center gap-0.5" title="Боти">
                      <i className="bi bi-robot" />
                      <span>{botContribs.length}</span>
                    </span>
                  )}
                  {humanContribs.length > 0 && (
                    <span className="flex items-center gap-0.5" title="Користувачі">
                      <i className="bi bi-person-fill" />
                      <span>{humanContribs.length}</span>
                    </span>
                  )}
                </span>
              )}
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}

export function MessageCardEtalonLocationTime({
  networkIds,
  networkDisplayMap,
  networkMap,
  etalonNoNetworkLabel,
  msg,
  relativeTimeMs,
}: {
  networkIds: number[];
  networkDisplayMap: Record<number, string>;
  networkMap: Record<number, Network>;
  etalonNoNetworkLabel: string | null;
  msg: InboxMessage;
  relativeTimeMs: number | null;
}) {
  return (
    <div className="inline-flex gap-x-3">
      <div className="flex flex-col items-baseline gap-x-2 gap-y-1">
        <span className="inline-flex shrink-1 items-start gap-1 w-full min-w-0">
          <NetworkSection
            networkIds={networkIds}
            networkDisplayMap={networkDisplayMap}
            networkMap={networkMap}
            etalonNoNetworkLabel={etalonNoNetworkLabel}
          />
        </span>
      </div>

      <span className="inline-flex break-words items-baseline gap-1 font-medium shrink-2">
        <i className="bi bi-geo text-icons shrink-0" title="Локація" />
        {msg.location ?? 'Не встановлена'}
      </span>
      {msg.timestamp != null && relativeTimeMs != null && (
        <div className="shrink-0 mr-0 ml-auto" style={{ color: 'var(--bs-secondary-color)' }}>
          {messageRenderDistance(msg.timestamp, relativeTimeMs)}
        </div>
      )}
    </div>
  );
}

export function MessageCardMessageBody({
  msg,
  tagsMap,
  onToggleTag,
}: {
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
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0">
      <span className="whitespace-pre-wrap break-words text-marked min-w-0">{textPrimary}</span>
      {msg.extendedForm != null && msg.extendedForm.trim() !== '' && (
        <span className="inline-flex items-center gap-1 shrink-0" style={{ fontSize: '.75rem' }}>
          <i className="bi bi-chat-text text-icons shrink-0" title="Коментар" />
          <span className="font-semibold text-xs">{msg.extendedForm}</span>
        </span>
      )}
      <span className="inline-flex flex-wrap gap-1 min-w-0">
        <MessageCardTagChips msg={msg} tagsMap={tagsMap} onToggleTag={onToggleTag} />
      </span>
    </div>
  );
}
