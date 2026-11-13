import RefreshIcon from '@mui/icons-material/Refresh';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';

import { PowerButton } from '../../components/PowerButton';
import type { AiAgentProvider } from '../../services/api/ai-agent';

/** Offers another model, and optionally the same one, after a provider failure or refusal. */
export function ModelFallbackActions({
  next,
  disabled,
  onSwitch,
  onRetry,
}: {
  next: AiAgentProvider | null;
  disabled: boolean;
  onSwitch: (provider: AiAgentProvider) => void;
  onRetry?: () => void;
}) {
  if (!next && !onRetry) return null;
  return (
    <div className="flex flex-wrap items-center gap-echo-xs">
      {next ? (
        <PowerButton
          type="button"
          size="small"
          variant="outlined"
          startIcon={<SwapHorizIcon />}
          style={{ whiteSpace: 'normal' }}
          disabled={disabled}
          onClick={() => onSwitch(next)}
        >
          Спробувати з {next.name}
        </PowerButton>
      ) : null}
      {onRetry ? (
        <PowerButton
          type="button"
          size="small"
          variant="text"
          color="inherit"
          startIcon={<RefreshIcon />}
          disabled={disabled}
          onClick={onRetry}
          sx={{ color: 'text.secondary' }}
        >
          Спробувати ще раз
        </PowerButton>
      ) : null}
    </div>
  );
}
