import ManageSearchIcon from '@mui/icons-material/ManageSearch';
import { Typography } from '@mui/material';
import { useId } from 'react';

import { PowerButton } from '../../components/PowerButton';
import type { AiAgentMessage } from '../../services/api/ai-agent';
import type { LiveRequest } from './index';

// Follow-ups may legitimately reuse the previous answer without retrieval, and
// the saved gaps are private, so the prompt has to ask for new searches itself.
export const DEEP_CONTINUATION_PROMPT =
  'Продовж роботу над попереднім запитом. Порівняй його з попередньою відповіддю, визнач, що не охоплено, і знайди це в джерелах новим пошуком; не обмежуйся переформулюванням попередньої відповіді. Дай повну оновлену відповідь: збережи підтверджені факти з їхніми посиланнями, додай нові та вкажи, що лишилося неповним.';

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
        Продовжити глибоким аналізом
      </PowerButton>
      <Typography id={hintId} variant="caption" color="text.secondary">
        {hint}
      </Typography>
    </div>
  );
}
