import ManageSearchIcon from '@mui/icons-material/ManageSearch';
import { Typography } from '@mui/material';
import { useId } from 'react';

import { PowerButton } from '../../components/PowerButton';
import type { AiAgentMessage } from '../../services/api/ai-agent';
import type { LiveRequest } from './index';
import { modelFailureNote } from './provider-fallback';

// Follow-ups may legitimately reuse the previous answer without using tools, so the
// prompt has to ask for the work itself. It stays task-neutral: the unfinished request
// may be a search, a map or a document.
export const DEEP_CONTINUATION_PROMPT =
  'Продовж попереднє завдання й доведи його до кінця: виконай усе, що лишилося незробленим, і скористайся потрібними інструментами, а не лише попередньою відповіддю. Дай повний оновлений результат, зберігши вже зроблене разом із посиланнями, мапами й документами.';

/**
 * The newest request, when it finished below Deep with incomplete coverage.
 * Older answers are excluded because the prompt refers to the previous answer.
 */
export function continuableRequestId(
  messages: AiAgentMessage[],
  liveRequests: LiveRequest[],
): string | null {
  const listed = new Set(messages.map((message) => message.requestId));
  const lastMessage = messages.at(-1);
  // Messages are server-ordered, so a live request they omit is newer than all of them.
  const live =
    liveRequests.filter((request) => !listed.has(request.id)).at(-1) ??
    liveRequests.find((request) => request.id === lastMessage?.requestId);
  const latest = live ?? lastMessage;
  const requestId = live?.id ?? lastMessage?.requestId;
  const state = live?.state ?? lastMessage?.requestState;
  return requestId &&
    state === 'completed' &&
    latest?.completionMetadata?.coverageLimited &&
    !modelFailureNote(latest.completionMetadata) &&
    latest.reasoningPreset !== 'deep'
    ? requestId
    : null;
}

export function DeepContinuationButton({
  hint,
  disabled,
  onClick,
}: {
  hint: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const hintId = useId();
  return (
    <div className="flex flex-wrap items-center gap-echo-xs">
      <PowerButton
        type="button"
        size="small"
        variant="outlined"
        startIcon={<ManageSearchIcon />}
        style={{ whiteSpace: 'normal' }}
        aria-describedby={hintId}
        disabled={disabled}
        onClick={onClick}
      >
        Продовжити в глибокому режимі
      </PowerButton>
      <Typography id={hintId} variant="caption" color="text.secondary">
        {hint}
      </Typography>
    </div>
  );
}
