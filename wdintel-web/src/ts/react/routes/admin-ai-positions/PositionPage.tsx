import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { Box, Card, CardContent, Chip, Link, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';

import type { AiPositionKnowledgeItem } from '../../../../Bindings';
import { PageLoadingState } from '../../components/PageLoadingState';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { listAiPositionKnowledge } from '../../services/api/ai-positions';
import { FeedbackChips, FeedbackDialog } from './feedback';
import { MentionsTab } from './MentionsTab';

const CERTAINTY_LABELS: Record<string, string> = {
  high: 'висока',
  medium: 'середня',
  low: 'низька',
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function formatDate(millis: number): string {
  return new Date(millis).toLocaleString('uk-UA');
}

/** One known position: where it is, feedback on that, and its interceptions. */
export function AdminAiPositionPage({ id }: { id: number }) {
  const { notify } = usePowerSnackbar();
  const [position, setPosition] = useState<AiPositionKnowledgeItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  useEffect(() => {
    if (!Number.isSafeInteger(id)) {
      setError('Невідома позиція');
      return;
    }
    void listAiPositionKnowledge({
      limit: 1,
      after: null,
      globalFilter: null,
      columnFilters: [{ id: 'id', value: String(id) }],
    })
      .then((response) => {
        const [item] = response.items;
        if (item) setPosition(item);
        else setError('Позицію не знайдено або вона вам недоступна');
      })
      .catch((nextError) => {
        const message = `Не вдалося завантажити позицію: ${errorMessage(nextError)}`;
        setError(message);
        notify({ severity: 'error', message });
      });
  }, [id, notify]);

  if (error) return <PowerAlert severity="error">{error}</PowerAlert>;
  if (!position) return <PageLoadingState />;

  return (
    <Stack spacing={2} sx={{ height: '100%', minHeight: 0 }}>
      <Box>
        <Link href="/admin/ai/positions" underline="hover">
          <Stack direction="row" spacing={0.5} alignItems="center">
            <ArrowBackIcon fontSize="small" />
            <span>Позиції</span>
          </Stack>
        </Link>
      </Box>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="h5">{position.name}</Typography>
              <Typography color="text.secondary">{position.nameKey}</Typography>
              <Chip
                size="small"
                label={`${position.scopeKind === 'aor' ? 'РВ' : 'Група'}: ${position.scopeName || '—'}`}
              />
              {position.scopeIsSecret ? <Chip size="small" label="приватна" /> : null}
            </Stack>
            <Typography>
              {position.mgrs} · {position.lat.toFixed(5)}, {position.lng.toFixed(5)}
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Chip size="small" label={`впевненість: ${CERTAINTY_LABELS[position.certainty]}`} />
              {position.conflicting ? (
                <Chip size="small" color="warning" label="є розбіжності" />
              ) : null}
              <Typography variant="body2" color="text.secondary">
                Підтверджень: {position.factCount}; з {formatDate(position.firstFactAt)} до{' '}
                {formatDate(position.lastFactAt)}
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="body2">Відгук на розташування:</Typography>
              <FeedbackChips
                feedback={position.feedback}
                onDeleted={(feedbackId) =>
                  setPosition({
                    ...position,
                    feedback: position.feedback.filter((item) => item.id !== feedbackId),
                  })
                }
              />
              <PowerButton size="small" variant="outlined" onClick={() => setFeedbackOpen(true)}>
                Оцінити розташування
              </PowerButton>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <MentionsTab
          tableId="admin-ai-position-interceptions"
          title="Перехоплення з цією позицією"
          fixedFilters={[
            { id: 'positionKey', value: position.nameKey },
            { id: 'positionScope', value: `${position.scopeKind}:${position.scopeKey}` },
          ]}
        />
      </Box>
      <FeedbackDialog
        target={feedbackOpen ? { kind: 'knowledge', id: position.id, title: position.name } : null}
        onClose={() => setFeedbackOpen(false)}
        onSaved={(item) => setPosition({ ...position, feedback: [item, ...position.feedback] })}
      />
    </Stack>
  );
}
