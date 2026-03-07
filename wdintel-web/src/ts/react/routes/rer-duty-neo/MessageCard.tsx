import { Box, Chip, Tooltip } from '@mui/material';
import React from 'react';

import type { InboxMessage } from '../../../../Bindings';
import { buildAnalysisHref, formatDateNoYear, formatTime, messageRenderDistance } from './utils';

export type MessageCardProps = {
  id: number;
  msg: InboxMessage;
  feedId: string;
  /** Reference time (ms) for "time ago" in top-right; set when feed was loaded. */
  referenceTimeMs: number | null;
  /** Auth user display name for background watermark */
  authUserName: string | null;
  groupName: string | null;
  senderName: string | null;
  copiedFeedbackId: string | null;
  networkDisplayMap: Record<number, string>;
  tagsMap: Record<number, string>;
  tagIdsList: number[];
  messageHasTag: (msg: InboxMessage, tagId: number) => boolean;
  onBookmark: () => void;
  onImportant: () => void;
  onCopyText: () => void;
  onCopyFreq: () => void;
  onComment: () => void;
  onToggleTag: (tagId: number) => void;
  /** When true, hide the left column (date/time, actions, freq, etc.). Set per feed. */
  leftSideCollapsed?: boolean;
};

export function MessageCard({
  id,
  msg,
  feedId: _feedId,
  referenceTimeMs,
  authUserName,
  groupName,
  senderName,
  copiedFeedbackId,
  networkDisplayMap,
  tagsMap,
  tagIdsList,
  messageHasTag,
  onBookmark,
  onImportant,
  onCopyText,
  onCopyFreq,
  onComment,
  onToggleTag,
  leftSideCollapsed = true,
}: MessageCardProps) {
  const networkIds = Array.from(new Set(msg.networkIds ?? []));

  return (
    <Box component="li" className="list-none flex pr-0 pl-2 rer-duty-message mb-3 font-size-[13px]">
      {/* Left column: date/time, actions, group, sender, freq — hidden when leftSideCollapsed */}
      {!leftSideCollapsed && (
        <div
          className="min-w-[120px] mr-2 basis-1/4 mb-[8px]"
          style={{ minWidth: 120, marginRight: 8, flex: '0 0 25%', marginBottom: 8 }}
        >
          <div
            className="flex justify-around w-full text-center mb-1"
            style={{
              fontSize: '.75rem',
              display: 'flex',
              justifyContent: 'space-around',
              width: '100%',
              textAlign: 'center',
              marginBottom: 4,
            }}
          >
            <span>
              <i className="bi bi-clock mr-1 text-icons" style={{ marginRight: 4 }} />
              {formatTime(msg.time)}
            </span>
            {msg.date != null && (
              <span>
                <i className="bi bi-calendar mr-1 text-icons" style={{ marginRight: 4 }} />
                {formatDateNoYear(msg.date)}
              </span>
            )}
          </div>
          <div
            className="flex justify-around mb-2"
            style={{ display: 'flex', justifyContent: 'space-around', marginBottom: 8 }}
          >
            <span
              role="button"
              tabIndex={0}
              title={msg.bookmarked ? 'Прибрати закладку' : 'Додати в закладки'}
              className="me-1 cursor-pointer"
              style={{ fontSize: '1rem' }}
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
              className="me-1 cursor-pointer"
              style={{ fontSize: '1rem' }}
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
              className="me-1 cursor-pointer"
              style={{ fontSize: '1rem' }}
              onClick={onComment}
              onKeyDown={(e) => e.key === 'Enter' && onComment()}
            >
              <i className="bi bi-chat-square text-action" />
            </span>
            <span
              role="button"
              tabIndex={0}
              title="Копіювати"
              className="cursor-pointer text-normal"
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
          {groupName != null && (
            <div className="bg-card rounded-sm text-sm">
              <div className="flex items-center px-2 py-1 border-b-2 border-border">
                <i className="bi bi-signal mr-1 text-icons leading-none" title="Група" />
                <span>{groupName}</span>
              </div>
            </div>
          )}
          {senderName != null && (
            <div className="py-1 px-2 flex items-center bg-card rounded-sm text-sm mb-2">
              <i className="bi bi-person-circle mr-1 text-icons leading-none" title="Відправник" />
              <span>{senderName}</span>
            </div>
          )}
          {msg.freq != null && (
            <div className="bg-card text-sm mb-2 rounded-sm">
              <div className="flex justify-between items-center py-1 px-2 border-b-2 border-border">
                <div className="flex items-center">
                  <i className="bi bi-broadcast mr-1 text-icons leading-none" title="Частота" />
                  <span className="font-semibold">{msg.freq}</span>
                </div>
                <span
                  role="button"
                  tabIndex={0}
                  title="Копіювати частоту"
                  className="cursor-pointer text-action text-sm"
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
              </div>
              <div className="flex justify-between items-center py-1 px-2 border-b-2 border-border">
                <div className="flex items-center">
                  <i className="bi bi-bar-chart-line mr-1 text-icons leading-none" title="Аналіз" />
                  <span>Аналіз</span>
                </div>
                <a
                  href={buildAnalysisHref(msg, false)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Відкрити повідомлення в Аналізі"
                  className="text-action text-sm text-inherit"
                >
                  <i className="bi bi-box-arrow-up-right cursor-pointer" />
                </a>
              </div>
              <a
                href={buildAnalysisHref(msg, true)}
                target="_blank"
                rel="noopener noreferrer"
                title="Відкрити повідомлення на карті в аналізі"
                className="text-action text-sm text-inherit"
              >
                <div className="flex justify-between py-1 px-2 w-full">
                  <div>
                    <i
                      className="bi bi-map text-icons leading-none mr-2 text-sm"
                      title="Відкрити повідомлення на карті"
                    />
                    <span className="text-xs">Карта</span>
                  </div>
                  <i className="bi bi-box-arrow-up-right cursor-pointer leading-none" />
                </div>
              </a>
            </div>
          )}

          {msg.extendedForm != null && msg.extendedForm.trim() !== '' && (
            <div className="bg-card text-sm rounded-sm">
              <div className="flex justify-between items-center py-1 px-2 border-border">
                <div className="flex items-center">
                  <i className="bi bi-chat-text mr-1 text-icons leading-none" title="Коментар" />
                  <span className="text-xs">Коментар</span>
                </div>
              </div>
              <div className="flex justify-between items-center py-1 pl-6 pr-2">
                <div className="flex items-center">
                  <span className="font-semibold text-xs">{msg.extendedForm}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Right column: message card */}
      <div className="mb-2 rounded-sm px-2 pt-2 pb-2 basis-3/4 flex-1 message-div bg-card relative min-w-0 break-words overflow-hidden">
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
        <div className="whitespace-pre-wrap break-words mt-1 mb-3">{msg.text || '—'}</div>
        <Box className="flex flex-wrap gap-1 mt-1">
          {tagIdsList.map((tagId) => {
            const label = tagsMap[tagId] ?? `#${tagId}`;
            const isSet = messageHasTag(msg, tagId);
            const contribs = (msg.inboxTags ?? []).filter((t) => t.tagId === tagId);
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
                  <Chip
                    size="small"
                    label={label}
                    onClick={() => onToggleTag(tagId)}
                    variant="filled"
                    className="text-sm h-5 cursor-pointer"
                    sx={{
                      '& .MuiChip-label': { px: 0.75 },
                      ...(isSet
                        ? {
                            bgcolor: 'var(--color-tag-selected)',
                            color: 'black',
                            border: '1px solid var(--color-border-selected)',
                          }
                        : {
                            bgcolor: 'var(--color-tag)',
                            color: 'var(--color-text)',
                            border: '1px solid var(--color-border)',
                            opacity: 0.75,
                            '&:hover': { opacity: 1 },
                          }),
                    }}
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
