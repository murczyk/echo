import {
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useState } from 'react';

import type { AiPositionFeedbackItem } from '../../../../Bindings';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { deleteAiPositionFeedback, saveAiPositionFeedback } from '../../services/api/ai-positions';

export const VERDICT_LABELS: Record<string, string> = {
  correct: 'правильно',
  not_position: 'не позиція',
  wrong_name: 'неправильна назва',
  wrong_coordinates: 'неправильні координати',
  missed: 'пропущено позиції',
  wrong_kind: 'неправильний тип',
  other: 'інше',
};

export const KIND_LABELS: Record<string, string> = {
  position: 'позиція',
  crew: 'розрахунок',
  callsign: 'позивний',
};

/** What the reviewer is asked to fill in as «expected» for each verdict. */
const EXPECTED_HINTS: Record<string, string> = {
  correct: '',
  not_position: '',
  wrong_name: 'Правильна назва позиції',
  wrong_coordinates: 'Правильні координати (якщо відомі)',
  missed: 'Пропущені позиції, через кому',
  wrong_kind: '',
  other: 'Як має бути',
};

const MENTION_VERDICTS = [
  'not_position',
  'wrong_name',
  'wrong_coordinates',
  'missed',
  'wrong_kind',
  'correct',
  'other',
];
const LOCATION_VERDICTS = ['wrong_coordinates', 'not_position', 'correct', 'other'];

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export type FeedbackTarget =
  { kind: 'mention'; id: string; title: string } | { kind: 'knowledge'; id: string; title: string };

export function FeedbackDialog({
  target,
  onClose,
  onSaved,
}: {
  target: FeedbackTarget | null;
  onClose: () => void;
  onSaved: (item: AiPositionFeedbackItem) => void;
}) {
  const { notify } = usePowerSnackbar();
  const verdicts = target?.kind === 'knowledge' ? LOCATION_VERDICTS : MENTION_VERDICTS;
  const [verdict, setVerdict] = useState(verdicts[0]);
  const [expected, setExpected] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!target) return;
    setBusy(true);
    try {
      const item = await saveAiPositionFeedback({
        mentionId: target.kind === 'mention' ? target.id : null,
        knowledgeId: target.kind === 'knowledge' ? target.id : null,
        verdict,
        expected,
        comment,
      });
      onSaved(item);
      setExpected('');
      setComment('');
      onClose();
    } catch (error) {
      notify({ severity: 'error', message: `Не вдалося зберегти відгук: ${errorMessage(error)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={target !== null} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Відгук: {target?.title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            select
            label="Оцінка"
            value={verdicts.includes(verdict) ? verdict : verdicts[0]}
            onChange={(event) => setVerdict(event.target.value)}
          >
            {verdicts.map((value) => (
              <MenuItem key={value} value={value}>
                {VERDICT_LABELS[value]}
              </MenuItem>
            ))}
          </TextField>
          {verdict === 'wrong_kind' ? (
            <TextField
              select
              label="Правильний тип"
              value={expected}
              onChange={(event) => setExpected(event.target.value)}
            >
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <MenuItem key={value} value={value}>
                  {label}
                </MenuItem>
              ))}
            </TextField>
          ) : null}
          {EXPECTED_HINTS[verdict] ? (
            <TextField
              label={EXPECTED_HINTS[verdict]}
              value={expected}
              onChange={(event) => setExpected(event.target.value)}
            />
          ) : null}
          <TextField
            label="Коментар: що не так і як покращити"
            multiline
            minRows={3}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <PowerButton onClick={onClose}>Скасувати</PowerButton>
        <PowerButton variant="contained" disabled={busy} onClick={() => void save()}>
          Зберегти
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}

/** Feedback chips; a chip's tooltip shows the details, its cross deletes it. */
export function FeedbackChips({
  feedback,
  onDeleted,
}: {
  feedback: AiPositionFeedbackItem[];
  onDeleted: (id: string) => void;
}) {
  const { notify } = usePowerSnackbar();
  if (feedback.length === 0) return <Typography color="text.secondary">—</Typography>;
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
      {feedback.map((item) => (
        <Tooltip
          key={item.id}
          title={[
            item.expected && `Очікується: ${item.expected}`,
            item.comment,
            item.createdBy &&
              `${item.createdBy}, ${new Date(item.createdAt).toLocaleString('uk-UA')}`,
            item.reparsedAt && 'Перепарсено після відгуку',
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          <Chip
            size="small"
            color={item.verdict === 'correct' ? 'success' : 'warning'}
            variant={item.reparsedAt ? 'outlined' : 'filled'}
            label={VERDICT_LABELS[item.verdict] ?? item.verdict}
            onDelete={() =>
              void deleteAiPositionFeedback(item.id)
                .then(() => onDeleted(item.id))
                .catch((error) =>
                  notify({
                    severity: 'error',
                    message: `Не вдалося видалити відгук: ${errorMessage(error)}`,
                  }),
                )
            }
          />
        </Tooltip>
      ))}
    </Stack>
  );
}
