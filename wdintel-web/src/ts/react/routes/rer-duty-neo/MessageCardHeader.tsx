import type { InboxMessage } from '../../../../Bindings';
import { buildAnalysisHref, formatDateNoYear, formatTime } from './utils';

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
}: {
  id: number;
  msg: InboxMessage;
  copiedFeedbackId: string | null;
  onBookmark: () => void;
  onImportant: () => void;
  onComment: () => void;
  onCopyText: () => void;
  onDelete?: () => void;
  onEditDetails?: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5" style={{ fontSize: 14 }}>
      <span
        role="button"
        tabIndex={0}
        title={msg.bookmarked ? 'Прибрати закладку' : 'Додати в закладки'}
        className="cursor-pointer"
        onClick={onBookmark}
        onKeyDown={(e) => e.key === 'Enter' && onBookmark()}
      >
        <i
          className={msg.bookmarked ? 'bi bi-bookmark-fill text-action' : 'bi bi-bookmark text-action cursor-pointer'}
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
            msg.important ? 'bi bi-exclamation-triangle-fill text-action' : 'bi bi-exclamation-triangle text-action'
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
      {onDelete != null && (
        <span
          role="button"
          tabIndex={0}
          title="Видалити"
          className="cursor-pointer"
          onClick={onDelete}
          onKeyDown={(e) => e.key === 'Enter' && onDelete()}
        >
          <i className="bi bi-trash text-action cursor-pointer" />
        </span>
      )}
      {onEditDetails != null && (
        <span
          role="button"
          tabIndex={0}
          title="Редагувати додаткові поля"
          className="cursor-pointer"
          onClick={onEditDetails}
          onKeyDown={(e) => e.key === 'Enter' && onEditDetails()}
        >
          <i className="bi bi-sliders text-action cursor-pointer" />
        </span>
      )}
    </div>
  );
}

export type MessageCardHeaderProps = {
  layout: 'fluid' | 'dividers';
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
  if (layout === 'fluid') {
    return (
      <>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs justify-between">
          <span className="inline-flex items-center gap-1 shrink-0">
            <i className="bi bi-clock text-icons" />
            {formatTime(msg.time)}
            {msg.date != null && (
              <>
                <span className="text-icons/70 mx-0.5">·</span>
                <i className="bi bi-calendar text-icons shrink-0" />
                {formatDateNoYear(msg.date)}
              </>
            )}
          </span>
          {groupName != null && (
            <span className="inline-flex items-center gap-1 shrink-0 min-w-0 max-w-full" title={groupName}>
              <i className="bi bi-signal text-icons shrink-0" title="Група" />
              <span className="truncate">{groupName}</span>
            </span>
          )}
          {senderName != null && (
            <span className="inline-flex items-center gap-1 shrink-0 min-w-0 max-w-full" title={senderName}>
              <i className="bi bi-person-circle text-icons shrink-0" title="Відправник" />
              <span className="truncate">{senderName}</span>
            </span>
          )}
          {msg.freq != null && (
            <span>
              <span className="inline-flex items-center gap-1 font-semibold shrink-0">
                <i className="bi bi-broadcast text-icons" title="Частота" />
                {msg.freq}
              </span>
              <span
                role="button"
                tabIndex={0}
                title="Копіювати частоту"
                className="cursor-pointer shrink-0 inline-flex"
                onClick={onCopyFreq}
                onKeyDown={(e) => e.key === 'Enter' && onCopyFreq()}
              >
                &nbsp;
                <i className={copiedFeedbackId === `freq-${id}` ? 'bi bi-clipboard-check-fill' : 'bi bi-clipboard'} />
              </span>
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs justify-between">
          <a
            href={buildAnalysisHref(msg, false)}
            target="_blank"
            rel="noopener noreferrer"
            title="Відкрити повідомлення в Аналізі"
            className="inline-flex items-center gap-1 shrink-0"
          >
            <i className="bi bi-bar-chart-line" />
            Аналіз
            <i className="bi bi-box-arrow-up-right text-xs" />
          </a>
          <a
            href={mapHref}
            target="_blank"
            rel="noopener noreferrer"
            title="Відкрити повідомлення на карті в аналізі"
            className="inline-flex items-center gap-1 shrink-0"
          >
            <i className="bi bi-map" />
            Карта
            <i className="bi bi-box-arrow-up-right text-xs" />
          </a>

          <span className="shrink-0 inline-flex">
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
          </span>
        </div>
      </>
    );
  }

  const narrowColumns = feedCount >= 3;
  const colLeft = narrowColumns
    ? 'flex flex-col gap-1 pt-1.5 pl-2 pr-2 flex-1 shrink-3 border-r border-border min-w-[105px]'
    : 'flex flex-col gap-1 pt-1.5 pl-2 pr-2 flex-1 min-w-0 border-r border-border';
  const colCenter = narrowColumns
    ? 'flex flex-col gap-1 pt-1.5 px-2 min-w-0 flex-1 shrink-1 text-xs border-r border-border min-w-[62px]'
    : 'flex flex-col gap-1 pt-1.5 px-2 min-w-0 flex-1 text-xs border-r border-border';
  const colRight = narrowColumns
    ? 'flex flex-col gap-1 pt-1.5 pl-2 pr-2 flex-1 shrink-0 basis-auto text-xs items-end'
    : 'flex flex-col gap-1 pt-1.5 pl-2 pr-2 flex-1 min-w-0 text-xs items-end';

  return (
    <div className="flex items-stretch w-full">
      <div className={colLeft}>
        <div className="flex items-center justify-left" style={{ fontSize: '.75rem' }}>
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
        <div className="flex items-stretch gap-2" style={{ fontSize: 14 }}>
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
        </div>
      </div>
      <div className={colCenter}>
        <div className="flex items-center min-w-0">
          {groupName != null ? (
            <span className="flex items-center gap-1 truncate min-w-0 cursor-default" title={groupName}>
              <i className="bi bi-signal text-icons shrink-0" title="Група" />
              <span className="truncate">{groupName}</span>
            </span>
          ) : (
            <span className="text-icons/70">—</span>
          )}
        </div>
        <div className="flex items-center min-w-0">
          {senderName != null ? (
            <span className="flex items-center gap-1 truncate min-w-0 cursor-default" title={senderName}>
              <i className="bi bi-person-circle text-icons shrink-0" title="Відправник" />
              <span className="truncate">{senderName}</span>
            </span>
          ) : (
            <span className="text-icons/70">—</span>
          )}
        </div>
      </div>
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
        <div className="flex items-center gap-2 flex-nowrap text-xs min-w-[70px]">
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
  );
}
