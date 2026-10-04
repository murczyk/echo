import {
  Box,
  Chip,
  Link,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useState } from 'react';

import type { AiPositionFeedbackListItem } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { listAiPositionFeedback } from '../../services/api/ai-positions';
import { FeedbackChips, KIND_LABELS, VERDICT_LABELS } from './feedback';

const ALL = 'all';

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** Every verdict, including snapshots whose mentions were reparsed. */
export function FeedbackTab() {
  const { notify } = usePowerSnackbar();
  const [verdict, setVerdict] = useState('not_position');
  const [items, setItems] = useState<AiPositionFeedbackListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listAiPositionFeedback({
        verdict: verdict === ALL ? null : verdict,
        limit: 200,
      });
      setItems(response.items);
    } catch (nextError) {
      const message = `Не вдалося завантажити відгуки: ${errorMessage(nextError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setLoading(false);
    }
  }, [verdict, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <TextField
          select
          size="small"
          label="Оцінка"
          value={verdict}
          onChange={(event) => setVerdict(event.target.value)}
          sx={{ minWidth: 240 }}
        >
          <MenuItem value={ALL}>усі</MenuItem>
          {Object.entries(VERDICT_LABELS).map(([value, label]) => (
            <MenuItem key={value} value={value}>
              {label}
            </MenuItem>
          ))}
        </TextField>
        <PowerButton variant="outlined" disabled={loading} onClick={() => void load()}>
          Оновити
        </PowerButton>
        {verdict === 'not_position' ? (
          <Typography variant="body2" color="text.secondary">
            Відгуки не видаляють згадки й не блокують назву. Покращіть промпт і перепарсіть джерела.
          </Typography>
        ) : null}
      </Stack>
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Назва</TableCell>
              <TableCell>Тип</TableCell>
              <TableCell>Відгук</TableCell>
              <TableCell>Очікується</TableCell>
              <TableCell>Коментар</TableCell>
              <TableCell>Джерело</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.feedback.id}>
                <TableCell>
                  <Typography variant="body2" fontWeight={600}>
                    {item.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {item.nameKey}
                  </Typography>
                </TableCell>
                <TableCell>
                  {item.kind ? (
                    <Chip size="small" label={KIND_LABELS[item.kind] ?? item.kind} />
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell>
                  <FeedbackChips
                    feedback={[item.feedback]}
                    onDeleted={(id) =>
                      setItems((current) => current.filter((row) => row.feedback.id !== id))
                    }
                  />
                </TableCell>
                <TableCell>{item.feedback.expected || '—'}</TableCell>
                <TableCell>{item.feedback.comment || '—'}</TableCell>
                <TableCell>
                  {item.messageUuid ? (
                    <Link
                      href={`/rer-analysis-neo?m=${encodeURIComponent(item.messageUuid)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Повідомлення
                    </Link>
                  ) : item.feedback.targetKind === 'knowledge' ? (
                    'Розташування'
                  ) : (
                    '—'
                  )}
                </TableCell>
              </TableRow>
            ))}
            {items.length === 0 && !loading ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <Typography color="text.secondary">Відгуків немає</Typography>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </Box>
    </Stack>
  );
}
