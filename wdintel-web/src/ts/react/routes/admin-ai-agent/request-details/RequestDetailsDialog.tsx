import CloseIcon from '@mui/icons-material/Close';
import {
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material';
import { useId, useState } from 'react';

import { PowerButton } from '../../../components/PowerButton';
import { PowerChip } from '../../../components/PowerChip';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { usePowerSnackbar } from '../../../components/PowerSnackbar';
import {
  type AiAgentAuditRequestDetail,
  retryAiAgentSecurityReview,
} from '../../../services/api/ai-agent';
import type { LiveRequest } from '../../ai-agent-chat';
import { errorMessage, formatDateTime, statusColor } from '../format';
import { useLiveAdminRequest } from './live-request';
import { RequestMetadataPanel } from './RequestMetadataPanel';
import { RequestTranscript } from './RequestTranscript';

function RequestDialogTitle({
  titleId,
  request,
  live,
  onClose,
}: {
  titleId: string;
  request: AiAgentAuditRequestDetail;
  live: LiveRequest;
  onClose: () => void;
}) {
  return (
    <DialogTitle component="div">
      <div className="flex items-center gap-echo-sm pr-echo-2xl">
        <Typography
          id={titleId}
          variant="h6"
          component="h2"
          noWrap
          title={request.conversation.title || undefined}
          className="min-w-0"
        >
          {request.conversation.title || 'Запит ШІ'}
        </Typography>
        <span className="flex shrink-0 items-center gap-echo-sm">
          <PowerChip label={live.state} color={statusColor(live.state)} selected />
          <PowerChip
            label={`Перевірка: ${request.reviewState}`}
            color={statusColor(request.reviewState)}
          />
          {request.severity ? (
            <PowerChip label={request.severity} color={statusColor(request.severity)} selected />
          ) : null}
        </span>
      </div>
      <Typography variant="body2" color="text.secondary">
        {[
          request.humanLogin,
          request.providerName,
          request.metadata.aiEngineModelName,
          formatDateTime(request.createdAt),
        ].join(' · ')}
      </Typography>
      <span className="absolute right-echo-md top-echo-md">
        <PowerIconButton aria-label="Закрити" onClick={onClose}>
          <CloseIcon />
        </PowerIconButton>
      </span>
    </DialogTitle>
  );
}

function RequestDetailsBody({
  request,
  live,
  onOpenRequest,
  onReconnect,
}: {
  request: AiAgentAuditRequestDetail;
  live: LiveRequest;
  onOpenRequest: (requestId: string) => void;
  onReconnect: () => void;
}) {
  return (
    <DialogContent dividers className="p-0!">
      <div className="grid grid-cols-[minmax(0,1fr)] echo-lg:h-[78vh] echo-lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="h-[65vh] min-h-0 echo-lg:h-full">
          <RequestTranscript
            detail={request}
            live={live}
            onOpenRequest={onOpenRequest}
            onReconnect={onReconnect}
          />
        </div>
        <aside className="border-t border-echo-divider p-echo-lg echo-lg:overflow-y-auto echo-lg:border-l echo-lg:border-t-0">
          <RequestMetadataPanel request={request} live={live} />
        </aside>
      </div>
    </DialogContent>
  );
}

export function RequestDetailsDialog({
  request,
  onClose,
  onRequestUpdated,
  onOpenRequest,
}: {
  request: AiAgentAuditRequestDetail | null;
  onClose: () => void;
  onRequestUpdated: (request: AiAgentAuditRequestDetail) => void;
  onOpenRequest: (requestId: string) => void;
}) {
  const titleId = useId();
  const [retrying, setRetrying] = useState(false);
  const { notify } = usePowerSnackbar();
  const { live, reconnect } = useLiveAdminRequest(request, onRequestUpdated);

  async function retryReview() {
    if (!request) return;
    setRetrying(true);
    try {
      onRequestUpdated(await retryAiAgentSecurityReview(request.id));
      notify({ severity: 'success', message: 'Повторну перевірку поставлено в чергу.' });
    } catch (retryError) {
      notify({
        severity: 'error',
        message: `Не вдалося повторити перевірку: ${errorMessage(retryError)}`,
      });
    } finally {
      setRetrying(false);
    }
  }

  return (
    <Dialog
      open={request !== null}
      onClose={onClose}
      fullWidth
      maxWidth="xl"
      aria-labelledby={titleId}
    >
      {request && live ? (
        <>
          <RequestDialogTitle titleId={titleId} request={request} live={live} onClose={onClose} />
          <RequestDetailsBody
            request={request}
            live={live}
            onOpenRequest={onOpenRequest}
            onReconnect={reconnect}
          />
          <DialogActions>
            {request.reviewState === 'failed' ? (
              <PowerButton
                variant="outlined"
                disabled={retrying}
                startIcon={retrying ? <CircularProgress size={16} /> : undefined}
                onClick={() => void retryReview()}
              >
                Повторити перевірку
              </PowerButton>
            ) : null}
            <PowerButton variant="contained" onClick={onClose}>
              Закрити
            </PowerButton>
          </DialogActions>
        </>
      ) : null}
    </Dialog>
  );
}
