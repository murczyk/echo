import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Tooltip, Typography } from '@mui/material';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import type {
  AiAgentFileCitation,
  AiAgentMapSummary,
  AiAgentMessageCitation,
} from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { PowerChip } from '../../../components/PowerChip';
import { PowerIconButton } from '../../../components/PowerIconButton';
import type {
  AiAgentAuditRequestDetail,
  AiAgentMessage,
  AiAgentUpload,
} from '../../../services/api/ai-agent';
import {
  currentActivityPresentation,
  type LiveRequest,
  MarkdownContent,
  REASONING_LABELS,
} from '../../ai-agent-chat';
import { formatFileSize } from '../../ai-agent-chat/ComposerAttachments';
import { ConversationMapsContext } from '../../ai-agent-chat/map-documents';
import { RequestActivity, RequestDuration } from '../../ai-agent-chat/RequestActivity';
import { formatDateTime } from '../format';
import { isTerminalRequestState } from './live-request';

type Turn = { requestId: string; user?: AiAgentMessage; assistant?: AiAgentMessage };

enum CurrentTurnPosition {
  Visible = 'visible',
  Above = 'above',
  Below = 'below',
}

function transcriptTurns(detail: AiAgentAuditRequestDetail): Turn[] {
  const turns: Turn[] = [];
  for (const message of detail.conversation.messages) {
    let turn = turns.find((item) => item.requestId === message.requestId);
    if (!turn) {
      turn = { requestId: message.requestId };
      turns.push(turn);
    }
    turn[message.role] = message;
  }
  if (!turns.some((turn) => turn.requestId === detail.id)) turns.push({ requestId: detail.id });
  return turns;
}

function UserBubble({
  login,
  content,
  createdAt,
  message,
}: {
  login: string;
  content: string;
  createdAt: number;
  message?: AiAgentMessage;
}) {
  const preset = message?.reasoningPreset;
  return (
    <div className="max-w-[95%] self-end rounded-echo-md border-1 border-solid border-echo-border bg-[color-mix(in_srgb,var(--echo-color-primary)_12%,var(--echo-color-dialog-surface))] px-echo-lg py-echo-md echo-lg:max-w-[80%]">
      <Typography variant="caption" color="text.secondary" component="p" className="mb-echo-xs">
        {[login, preset ? REASONING_LABELS[preset] : null, formatDateTime(createdAt)]
          .filter(Boolean)
          .join(' · ')}
      </Typography>
      <Typography component="div" className="whitespace-pre-wrap [overflow-wrap:anywhere]">
        {content}
      </Typography>
      <InertChips
        items={(message?.attachments ?? []).map((upload: AiAgentUpload) => ({
          key: upload.id,
          icon: <AttachFileIcon fontSize="inherit" color="action" />,
          label: `${upload.fileName} · ${formatFileSize(upload.sizeBytes)}`,
        }))}
      />
    </div>
  );
}

type InertChip = { key: string; icon: ReactNode; label: string };

function InertChips({ items }: { items: InertChip[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="m-0 mt-echo-sm flex list-none flex-wrap gap-echo-xs p-0">
      {items.map((item) => (
        <li
          key={item.key}
          className="flex min-w-0 items-center gap-echo-xs rounded-echo-pill border-1 border-solid border-echo-border px-echo-sm"
        >
          {item.icon}
          <Typography variant="caption" color="text.secondary" noWrap>
            {item.label}
          </Typography>
        </li>
      ))}
    </ul>
  );
}

function mapChips(maps: AiAgentMapSummary[]): InertChip[] {
  return maps.map((summary) => ({
    key: `${summary.requestId}:${summary.id}`,
    icon: <MapOutlinedIcon fontSize="inherit" color="action" />,
    label: `${summary.title} · ${summary.validCount}`,
  }));
}

function AssistantBubble({
  content,
  message,
  maps = message?.maps ?? [],
  citations = message?.citations ?? [],
  fileCitations = message?.fileCitations ?? [],
}: {
  content: string;
  message?: AiAgentMessage;
  maps?: AiAgentMapSummary[];
  citations?: AiAgentMessageCitation[];
  fileCitations?: AiAgentFileCitation[];
}) {
  return (
    <div className="w-full self-start rounded-echo-md border-1 border-solid border-echo-border bg-echo-dialog-surface px-echo-lg py-echo-md">
      <Typography variant="caption" color="text.secondary" component="p" className="mb-echo-xs">
        ЕХО Агент
        {message?.completionMetadata?.coverageLimited ? ' · Охоплення джерел неповне' : ''}
      </Typography>
      <MarkdownContent citations={citations} fileCitations={fileCitations} maps={maps} inertMaps>
        {content}
      </MarkdownContent>
      <InertChips
        items={mapChips(maps.filter((summary) => !content.includes(`](echo-map:${summary.id})`)))}
      />
    </div>
  );
}

function OtherTurn({
  turn,
  login,
  onOpenRequest,
}: {
  turn: Turn;
  login: string;
  onOpenRequest: (requestId: string) => void;
}) {
  return (
    <article
      data-testid={`admin-ai-turn-${turn.requestId}`}
      className="group relative -mx-echo-sm flex flex-col gap-echo-sm rounded-echo-md border-1 border-solid border-transparent p-echo-sm transition-colors focus-within:border-echo-border hover:border-echo-border"
    >
      {turn.user ? (
        <UserBubble
          login={login}
          content={turn.user.content}
          createdAt={turn.user.createdAt}
          message={turn.user}
        />
      ) : null}
      {turn.assistant ? (
        <AssistantBubble content={turn.assistant.content} message={turn.assistant} />
      ) : null}
      <span className="absolute left-echo-sm top-echo-sm opacity-[0] transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <Tooltip title="Відкрити цей запит">
          <PowerIconButton
            size="small"
            aria-label="Відкрити цей запит"
            onClick={() => onOpenRequest(turn.requestId)}
            className="border-1! border-solid! border-echo-border! bg-echo-dialog-surface!"
          >
            <OpenInNewIcon fontSize="small" />
          </PowerIconButton>
        </Tooltip>
      </span>
    </article>
  );
}

function currentAssistantContent(
  detail: AiAgentAuditRequestDetail,
  live: LiveRequest,
  assistant?: AiAgentMessage,
): string {
  if (!isTerminalRequestState(live.state)) return live.assistantText;
  return assistant?.content || detail.response || live.assistantText;
}

function CurrentTurnOutcome({
  detail,
  live,
  onReconnect,
}: {
  detail: AiAgentAuditRequestDetail;
  live: LiveRequest;
  onReconnect: () => void;
}) {
  return (
    <>
      {live.state === 'failed' ? (
        <PowerAlert severity="error">
          <Typography
            component="pre"
            variant="body2"
            className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            {detail.error ?? 'Запит не виконано.'}
          </Typography>
        </PowerAlert>
      ) : null}
      {live.state === 'cancelled' ? (
        <PowerAlert severity="info">Запит скасовано.</PowerAlert>
      ) : null}
      {live.streamError ? (
        <PowerAlert
          severity="warning"
          action={
            <PowerButton
              size="small"
              color="inherit"
              startIcon={<RefreshIcon />}
              onClick={onReconnect}
            >
              Відновити
            </PowerButton>
          }
        >
          Потік перервано: {live.streamError}
        </PowerAlert>
      ) : null}
    </>
  );
}

function CurrentTurn({
  detail,
  live,
  turn,
  turnRef,
  highlighted,
  onReconnect,
}: {
  detail: AiAgentAuditRequestDetail;
  live: LiveRequest;
  turn: Turn;
  turnRef: RefObject<HTMLElement>;
  highlighted: boolean;
  onReconnect: () => void;
}) {
  const active = !isTerminalRequestState(live.state);
  const presentation = currentActivityPresentation(live);
  const content = currentAssistantContent(detail, live, turn.assistant);
  const maps = turn.assistant?.maps ?? live.maps ?? [];
  return (
    <article
      ref={turnRef}
      data-testid="admin-ai-current-turn"
      aria-current="true"
      className={`-mx-echo-sm flex scroll-mt-echo-lg flex-col gap-echo-sm rounded-echo-md border-1 border-solid p-echo-sm ${highlighted ? 'border-echo-primary' : 'border-transparent'}`}
    >
      {highlighted ? (
        <span className="self-start">
          <PowerChip label="Поточний запит" color="primary" selected />
        </span>
      ) : null}
      <UserBubble
        login={detail.humanLogin}
        content={turn.user?.content ?? detail.prompt}
        createdAt={turn.user?.createdAt ?? detail.createdAt}
        message={turn.user}
      />
      <RequestActivity
        tools={live.tools}
        activity={live.activity ?? []}
        active={active}
        completed={live.state === 'completed'}
        status={presentation.title}
        detail={presentation.detail}
        duration={
          live.state === 'queued' ? (
            'У черзі'
          ) : (
            <RequestDuration
              createdAt={live.startedAt ?? live.createdAt}
              finishedAt={live.finishedAt}
              active={active}
            />
          )
        }
      />
      {content || maps.length ? (
        <AssistantBubble
          content={content}
          message={turn.assistant}
          maps={maps}
          citations={turn.assistant?.citations ?? live.citations ?? []}
          fileCitations={turn.assistant?.fileCitations ?? live.fileCitations ?? []}
        />
      ) : null}
      <CurrentTurnOutcome detail={detail} live={live} onReconnect={onReconnect} />
    </article>
  );
}

function useCurrentTurnPosition(
  scrollRef: RefObject<HTMLElement>,
  turnRef: RefObject<HTMLElement>,
  requestId: string,
): CurrentTurnPosition {
  const [position, setPosition] = useState(CurrentTurnPosition.Visible);
  useEffect(() => {
    const root = scrollRef.current;
    const target = turnRef.current;
    if (!root || !target) return;
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setPosition(CurrentTurnPosition.Visible);
        else
          setPosition(
            entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0)
              ? CurrentTurnPosition.Above
              : CurrentTurnPosition.Below,
          );
      },
      { root },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [requestId]);
  return position;
}

export function RequestTranscript({
  detail,
  live,
  onOpenRequest,
  onReconnect,
}: {
  detail: AiAgentAuditRequestDetail;
  live: LiveRequest;
  onOpenRequest: (requestId: string) => void;
  onReconnect: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const turnRef = useRef<HTMLElement>(null);
  const position = useCurrentTurnPosition(scrollRef, turnRef, detail.id);
  const turns = transcriptTurns(detail);
  // Answers may link maps created in earlier turns, as in the chat.
  const conversationMaps = [
    ...detail.conversation.messages.flatMap((message) => message.maps ?? []),
    ...(live.maps ?? []),
  ];
  return (
    <div className="relative h-full min-h-0 bg-echo-background">
      <ConversationMapsContext.Provider value={conversationMaps}>
        <div
          ref={scrollRef}
          data-testid="admin-ai-request-transcript"
          className="flex h-full flex-col gap-echo-md overflow-y-auto px-echo-xl py-echo-lg"
        >
          {turns.map((turn) =>
            turn.requestId === detail.id ? (
              <CurrentTurn
                key={turn.requestId}
                detail={detail}
                live={live}
                turn={turn}
                turnRef={turnRef}
                highlighted={turns.length > 1}
                onReconnect={onReconnect}
              />
            ) : (
              <OtherTurn
                key={turn.requestId}
                turn={turn}
                login={detail.humanLogin}
                onOpenRequest={onOpenRequest}
              />
            ),
          )}
        </div>
      </ConversationMapsContext.Provider>
      {position !== CurrentTurnPosition.Visible ? (
        <div className="absolute bottom-echo-lg left-1/2 -translate-x-1/2">
          <PowerButton
            size="small"
            variant="contained"
            startIcon={
              position === CurrentTurnPosition.Above ? <ArrowUpwardIcon /> : <ArrowDownwardIcon />
            }
            onClick={() => turnRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            До поточного запиту
          </PowerButton>
        </div>
      ) : null}
    </div>
  );
}
