import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { Tooltip, Typography } from '@mui/material';
import type { ReactNode } from 'react';

import { PowerChip } from '../../../components/PowerChip';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { usePowerSnackbar } from '../../../components/PowerSnackbar';
import type { AiAgentAuditRequestDetail } from '../../../services/api/ai-agent';
import { isNullOrUndefined, isPresent } from '../../../utils/misc';
import { type LiveRequest, REASONING_LABELS } from '../../ai-agent-chat';
import { RequestDuration } from '../../ai-agent-chat/RequestActivity';
import { formatDateTime, statusColor } from '../format';
import { isTerminalRequestState } from './live-request';
import { modelFailureNote } from '../../ai-agent-chat/provider-fallback';

function formatSeconds(seconds: number | null | undefined): string | null {
  if (isNullOrUndefined(seconds)) return null;
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} хв ${rest} с` : `${minutes} хв`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-echo-sm py-echo-lg first:pt-0 last:pb-0">
      <Typography variant="overline" component="h3" color="text.secondary" className="leading-none">
        {title}
      </Typography>
      {children}
    </section>
  );
}

function MetaList({ children }: { children: ReactNode }) {
  return <dl className="m-0 flex flex-col gap-echo-sm">{children}</dl>;
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-x-echo-md">
      <Typography variant="body2" component="dt" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" component="dd" className="m-0 [overflow-wrap:anywhere]">
        {isPresent(children) && children !== '' ? children : '—'}
      </Typography>
    </div>
  );
}

type OptionalRow = [label: string, value: ReactNode];

/** Rows recorded only for newer requests; hidden when the request has no value. */
function OptionalRows({ rows, empty }: { rows: OptionalRow[]; empty?: string }) {
  const present = rows.filter(([, value]) => isPresent(value) && value !== '');
  if (present.length === 0 && empty)
    return (
      <Typography variant="body2" color="text.secondary">
        {empty}
      </Typography>
    );
  return (
    <MetaList>
      {present.map(([label, value]) => (
        <MetaRow key={label} label={label}>
          {value}
        </MetaRow>
      ))}
    </MetaList>
  );
}

function CopyableValue({ value }: { value: string }) {
  const { notify } = usePowerSnackbar();
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      notify({ severity: 'success', message: 'Скопійовано.' });
    } catch (_) {
      notify({ severity: 'error', message: 'Не вдалося скопіювати.' });
    }
  }
  return (
    <span className="flex min-w-0 items-center gap-echo-xs">
      <Typography variant="caption" component="span" className="font-mono [overflow-wrap:anywhere]">
        {value}
      </Typography>
      <Tooltip title="Копіювати">
        <PowerIconButton size="small" aria-label="Копіювати" onClick={() => void copy()}>
          <ContentCopyIcon fontSize="inherit" />
        </PowerIconButton>
      </Tooltip>
    </span>
  );
}

function EngineSection({ request }: { request: AiAgentAuditRequestDetail }) {
  const { metadata } = request;
  return (
    <Section title="Модель">
      <OptionalRows
        rows={[
          ['Провайдер', request.providerName],
          ['Модель', metadata.aiEngineModelName],
          ['API', metadata.providerApi],
          ['Хост', metadata.aiEngineHost],
        ]}
      />
    </Section>
  );
}

function ExecutionSection({ request }: { request: AiAgentAuditRequestDetail }) {
  const { metadata } = request;
  const efforts = [metadata.reasoningEffort, metadata.checkpointEffort, metadata.synthesisEffort];
  return (
    <Section title="Виконання">
      <OptionalRows
        empty="Параметри виконання для цього запиту не збережено."
        rows={[
          ['Режим', metadata.reasoningPreset ? REASONING_LABELS[metadata.reasoningPreset] : null],
          [
            'Зусилля',
            efforts.some(isPresent) ? efforts.map((effort) => effort ?? '—').join(' / ') : null,
          ],
          ['Ліміт часу', formatSeconds(metadata.maxRuntimeSeconds)],
          ['Фіналізація', formatSeconds(metadata.finalizationSeconds)],
          [
            'Охоплення',
            metadata.completionMetadata?.coverageLimited
              ? `Неповне: ${metadata.completionMetadata.reason}`
              : null,
          ],
          ['Збій моделі', modelFailureNote(metadata.completionMetadata)],
        ]}
      />
    </Section>
  );
}

function TimingSection({
  request,
  live,
}: {
  request: AiAgentAuditRequestDetail;
  live: LiveRequest;
}) {
  const startedAt = live.startedAt ?? request.startedAt;
  const finishedAt = live.finishedAt ?? request.completedAt ?? undefined;
  return (
    <Section title="Час">
      <MetaList>
        <MetaRow label="Створено">{formatDateTime(request.createdAt)}</MetaRow>
        <MetaRow label="Запущено">{formatDateTime(startedAt ?? null)}</MetaRow>
        <MetaRow label="Завершено">{formatDateTime(finishedAt ?? null)}</MetaRow>
        <MetaRow label="У черзі">
          {startedAt ? formatSeconds(Math.round((startedAt - request.createdAt) / 1000)) : null}
        </MetaRow>
        <MetaRow label="Виконання">
          {startedAt ? (
            <RequestDuration
              createdAt={startedAt}
              finishedAt={finishedAt}
              active={!isTerminalRequestState(live.state)}
              variant="body2"
            />
          ) : null}
        </MetaRow>
      </MetaList>
    </Section>
  );
}

function ErrorText({ children }: { children: string | null }) {
  if (!children) return null;
  return (
    <Typography variant="body2" color="error" className="[overflow-wrap:anywhere]">
      {children}
    </Typography>
  );
}

function ReviewSection({ request }: { request: AiAgentAuditRequestDetail }) {
  return (
    <Section title="Безпекова перевірка">
      <div className="flex flex-wrap items-center gap-echo-sm">
        <PowerChip label={request.reviewState} color={statusColor(request.reviewState)} selected />
        {request.severity ? (
          <PowerChip label={request.severity} color={statusColor(request.severity)} selected />
        ) : null}
        <Typography variant="caption" color="text.secondary">
          Спроб: {request.reviewAttemptCount}
        </Typography>
      </div>
      {request.reviewSummary ? (
        <Typography variant="body2" className="whitespace-pre-wrap [overflow-wrap:anywhere]">
          {request.reviewSummary}
        </Typography>
      ) : null}
      {request.reviewCategories.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-echo-xs p-0">
          {request.reviewCategories.map((category) => (
            <li key={category}>
              <PowerChip label={category} color="default" />
            </li>
          ))}
        </ul>
      ) : null}
      <ErrorText>{request.reviewLastError}</ErrorText>
    </Section>
  );
}

function AlertSection({ request }: { request: AiAgentAuditRequestDetail }) {
  return (
    <Section title="Mattermost сповіщення">
      <div className="flex items-center gap-echo-sm">
        <PowerChip
          label={request.alertState ?? 'не потрібне'}
          color={statusColor(request.alertState ?? '')}
          selected
        />
        <Typography variant="caption" color="text.secondary">
          Спроб: {request.alertAttemptCount}
        </Typography>
      </div>
      <ErrorText>{request.alertLastError}</ErrorText>
    </Section>
  );
}

export function RequestMetadataPanel({
  request,
  live,
}: {
  request: AiAgentAuditRequestDetail;
  live: LiveRequest;
}) {
  return (
    <div
      className="flex flex-col divide-y divide-echo-divider"
      data-testid="admin-ai-request-metadata"
    >
      <EngineSection request={request} />
      <ExecutionSection request={request} />
      <Section title="Учасники">
        <MetaList>
          <MetaRow label="Користувач">{request.humanLogin}</MetaRow>
          <MetaRow label="Агент">{request.metadata.agentLogin}</MetaRow>
        </MetaList>
      </Section>
      <TimingSection request={request} live={live} />
      <Section title="Ідентифікатори">
        <MetaList>
          <MetaRow label="Запит">
            <CopyableValue value={request.id} />
          </MetaRow>
          <MetaRow label="Розмова">
            <CopyableValue value={request.conversationId} />
          </MetaRow>
        </MetaList>
      </Section>
      <ReviewSection request={request} />
      <AlertSection request={request} />
    </div>
  );
}
