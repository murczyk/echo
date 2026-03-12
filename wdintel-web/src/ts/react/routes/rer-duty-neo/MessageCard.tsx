import { Box, Tooltip } from '@mui/material';
import React from 'react';

import type { InboxMessage, Tag } from '../../../../Bindings';
import { PowerChip } from '../../components/PowerChip';
import {
  buildAnalysisHref,
  buildAnalysisMapHrefWithSearch,
  formatDateNoYear,
  getPointEtalonsFromMessage,
  formatTime,
  messageRenderDistance,
} from './utils';
import { renderMarkedText } from './MarkedText';

export type MessageCardProps = {
  id: number;
  msg: InboxMessage;
  feedId: string;
  /** Number of feeds (columns). When >= 3, header columns use differential shrink (left 3, center 2, right 0). When 1 or 2, all columns shrink equally. */
  feedCount?: number;
  /** Reference time (ms) for "time ago" in top-right; set when feed was loaded. */
  referenceTimeMs: number | null;
  /** Auth user display name for background watermark */
  authUserName: string | null;
  groupName: string | null;
  senderName: string | null;
  copiedFeedbackId: string | null;
  networkDisplayMap: Record<number, string>;
  tagsMap: Record<number, Tag>;
  onBookmark: () => void;
  onImportant: () => void;
  onCopyText: () => void;
  onCopyFreq: () => void;
  onComment: () => void;
  onToggleTag: (tagId: number) => void;
};

export function MessageCard({
  id,
  msg,
  feedId: _feedId,
  feedCount = 1,
  referenceTimeMs,
  authUserName,
  groupName,
  senderName,
  copiedFeedbackId,
  networkDisplayMap,
  tagsMap,
  onBookmark,
  onImportant,
  onCopyText,
  onCopyFreq,
  onComment,
  onToggleTag,
}: MessageCardProps) {
  const networkIds = Array.from(new Set(msg.networkIds ?? []));
  const pointEtalons = getPointEtalonsFromMessage(msg);
  const mapHref = pointEtalons.length > 0 ? buildAnalysisMapHrefWithSearch(pointEtalons) : buildAnalysisHref(msg, true);

  const narrowColumns = feedCount >= 3;
  const colLeft = narrowColumns
    ? 'flex flex-col gap-1 pt-1.5 pl-2 pr-2 flex-1 shrink-3 border-r border-border min-w-[105px]'
    : 'flex flex-col gap-1 pt-1.5 pl-2 pr-2 flex-1 min-w-0 border-r border-border';
  const colCenter = narrowColumns
    ? 'flex flex-col gap-1 pt-1.5 px-2 min-w-0 flex-1 shrink-2 text-xs border-r border-border min-w-[62px]'
    : 'flex flex-col gap-1 pt-1.5 px-2 min-w-0 flex-1 text-xs border-r border-border';
  const colRight = narrowColumns
    ? 'flex flex-col gap-1 pt-1.5 pl-2 pr-2 flex-1 shrink-0 basis-auto text-xs'
    : 'flex flex-col gap-1 pt-1.5 pl-2 pr-2 flex-1 min-w-0 text-xs';

  return (
    <Box component="li" className="list-none flex flex-col pr-0 pl-2 rer-duty-message mb-2 font-size-[13px] pb-2">
      <div className="flex flex-col w-full bg-card rounded-t-sm p-2  border-b border-border">
        <div className="flex items-stretch w-full">
          <div className={colLeft}>
            <div className="flex items-center justify-around" style={{ fontSize: '.75rem' }}>
              <span className="flex items-center gap-1 pr-2">
                <i className="bi bi-clock text-icons" />
                {formatTime(msg.time)}
              </span>
              {msg.date != null && (
                <span className="flex items-center gap-1">
                  <i className="bi bi-calendar text-icons" />
                  {formatDateNoYear(msg.date)}
                </span>
              )}
            </div>
            <div className="flex items-stretch justify-around" style={{ fontSize: 14 }}>
              <span
                role="button"
                tabIndex={0}
                title={msg.bookmarked ? 'Прибрати закладку' : 'Додати в закладки'}
                className="cursor-pointer"
                onClick={onBookmark}
                onKeyDown={(e) => e.key === 'Enter' && onBookmark()}
              >
                <i
                  className={
                    msg.bookmarked ? 'bi bi-bookmark-fill text-action' : 'bi bi-bookmark text-action cursor-pointer'
                  }
                />
              </span>
              <span
                role="button"
                tabIndex={0}
                title={msg.important ? 'Прибрати важливе' : 'Помітити як важливе'}
                className="cursor-pointer"
                onClick={onImportant}
                onKeyDown={(e) => e.key === 'Enter' && onImportant()}
              >
                <i
                  className={
                    msg.important
                      ? 'bi bi-exclamation-triangle-fill text-action'
                      : 'bi bi-exclamation-triangle text-action'
                  }
                />
              </span>
              <span
                role="button"
                tabIndex={0}
                title="редагувати коментар"
                className="cursor-pointer"
                onClick={onComment}
                onKeyDown={(e) => e.key === 'Enter' && onComment()}
              >
                <i className="bi bi-chat-square text-action" />
              </span>
              <span
                role="button"
                tabIndex={0}
                title="Копіювати"
                className="cursor-pointer"
                onClick={onCopyText}
                onKeyDown={(e) => e.key === 'Enter' && onCopyText()}
              >
                <i
                  className={
                    copiedFeedbackId === `text-${id}`
                      ? 'bi bi-clipboard-check-fill text-action cursor-pointer'
                      : 'bi bi-clipboard text-action cursor-pointer'
                  }
                />
              </span>
            </div>
          </div>

          {/* Center: row1 group, row2 sender — native title shows full text on hover when clipped */}
          <div className={colCenter}>
            <div className="flex items-center min-w-0">
              {groupName != null ? (
                <span
                  className="flex items-center gap-1 truncate min-w-0 cursor-default"
                  title={groupName}
                >
                  <i className="bi bi-signal text-icons shrink-0" title="Група" />
                  <span className="truncate">{groupName}</span>
                </span>
              ) : (
                <span className="text-icons/70">—</span>
              )}
            </div>
            <div className="flex items-center min-w-0">
              {senderName != null ? (
                <span
                  className="flex items-center gap-1 truncate min-w-0 cursor-default"
                  title={senderName}
                >
                  <i className="bi bi-person-circle text-icons shrink-0" title="Відправник" />
                  <span className="truncate">{senderName}</span>
                </span>
              ) : (
                <span className="text-icons/70">—</span>
              )}
            </div>
          </div>

          {/* Right: row1 frequency, row2 analysis + map */}
          <div className={colRight} style={narrowColumns ? { minWidth: 'min-content' } : undefined}>
            <div className="flex items-center gap-1.5 min-w-0">
              {msg.freq != null ? (
                <>
                  <span className="flex items-center gap-1 font-semibold truncate">
                    <i className="bi bi-broadcast text-icons shrink-0" title="Частота" />
                    {msg.freq}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    title="Копіювати частоту"
                    className="cursor-pointer shrink-0"
                    onClick={onCopyFreq}
                    onKeyDown={(e) => e.key === 'Enter' && onCopyFreq()}
                  >
                    <i
                      className={
                        copiedFeedbackId === `freq-${id}`
                          ? 'bi bi-clipboard-check-fill cursor-pointer'
                          : 'bi bi-clipboard cursor-pointer'
                      }
                    />
                  </span>
                </>
              ) : (
                <span className="text-icons/70">—</span>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 flex-nowrap text-xs min-w-[70px]">
              <a
                href={buildAnalysisHref(msg, false)}
                target="_blank"
                rel="noopener noreferrer"
                title="Відкрити повідомлення в Аналізі"
                className="inline-flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                <i className="bi bi-bar-chart-line" />
                <span>Аналіз</span>
                <i className="bi bi-box-arrow-up-right text-xs" />
              </a>
              <a
                href={mapHref}
                target="_blank"
                rel="noopener noreferrer"
                title="Відкрити повідомлення на карті в аналізі"
                className="inline-flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                <i className="bi bi-map" />
                <span>Карта</span>
                <i className="bi bi-box-arrow-up-right text-xs" />
              </a>
            </div>
          </div>
        </div>
      </div>

      {msg.extendedForm != null && msg.extendedForm.trim() !== '' && (
        <div className="px-2 py-1 border-b border-border bg-card/50" style={{ fontSize: '.75rem' }}>
          <i className="bi bi-chat-text text-icons mr-1" title="Коментар" />
          <span className="font-semibold text-xs">{msg.extendedForm}</span>
        </div>
      )}

      {/* Message body */}
      <div className="mb-2 rounded-b-sm px-2 pt-2 pb-2 message-div bg-card relative min-w-0 break-words overflow-hidden">
        {/* Auth user name watermark in bg, twice same diagonal */}
        {(authUserName ?? '').trim() !== '' && (
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
        )}
        <div
          className="flex justify-start items-start flex-wrap py-1 border-b-2 border-border gap-2"
          style={{ position: 'relative' }}
        >
          {msg.timestamp != null && referenceTimeMs != null && (
            <div
              style={{
                position: 'absolute',
                top: 4,
                right: 8,
                fontSize: '.8rem',
                color: 'var(--bs-secondary-color)',
              }}
            >
              {messageRenderDistance(msg.timestamp, referenceTimeMs)}
            </div>
          )}
          <div className="font-semibold inline-flex gap-1">
            <i className="bi bi-people text-icons" title="Еталонна прив'язка" />
            {networkIds.length > 0 ? (
              networkIds.map((networkId) => (
                <a
                  href={`/rer-networks/${networkId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="opacity-70 hover:opacity-100 transition-opacity cursor-pointer inline-flex items-center gap-1 font-medium group"
                  title="Відкрити мережу в новій вкладці"
                  key={networkId}
                >
                  {networkDisplayMap[networkId] ?? `Мережа ${networkId}`}
                  <i className="bi bi-box-arrow-up-right text-sm" />
                </a>
              ))
            ) : (
              <span>Не встановлена</span>
            )}
          </div>
          <div className="font-semibold break-words min-w-0">
            <i className="bi bi-geo text-icons" title="Локація" /> {msg.location ?? 'Не встановлена'}
          </div>
        </div>
        <div className="whitespace-pre-wrap break-words mt-1 mb-3 text-marked">
          {msg.textMarked && msg.textMarked.length > 0
            ? renderMarkedText(msg.textMarked, msg.text ?? '', getPointEtalonsFromMessage(msg))
            : msg.text || '—'}
        </div>
        <Box className="flex flex-wrap gap-1 mt-1">
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
      </div>
    </Box>
  );
}
