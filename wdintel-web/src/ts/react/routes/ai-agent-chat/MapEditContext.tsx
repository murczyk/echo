import EditLocationAltOutlinedIcon from '@mui/icons-material/EditLocationAltOutlined';
import { Chip, Stack } from '@mui/material';

const SELECTION_PROMPTS = ['Зміни тип вибраних точок на ', 'Перейменуй вибрані точки: '];

/** Composer context while a map is open: whether this message may edit it,
 * and prompt starters for the current selection. */
export function MapEditContext({
  title,
  enabled,
  selectionCount,
  onToggle,
  onPrompt,
}: {
  title: string;
  enabled: boolean;
  selectionCount: number;
  onToggle: () => void;
  onPrompt: (text: string) => void;
}) {
  return (
    <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ pb: 0.5 }}>
      <Chip
        size="small"
        icon={<EditLocationAltOutlinedIcon />}
        color={enabled ? 'primary' : 'default'}
        variant={enabled ? 'filled' : 'outlined'}
        label={
          enabled
            ? `Редагую: ${title}${selectionCount ? ` · вибрано ${selectionCount}` : ''}`
            : `Мапа «${title}» — лише перегляд`
        }
        title={
          enabled
            ? 'ШІ може змінювати цю мапу. Натисніть, щоб лише питати.'
            : 'Натисніть, щоб ШІ міг змінювати цю мапу'
        }
        onClick={onToggle}
        aria-pressed={enabled}
        sx={{ maxWidth: '100%' }}
      />
      {enabled && selectionCount
        ? SELECTION_PROMPTS.map((prompt) => (
            <Chip
              key={prompt}
              size="small"
              variant="outlined"
              label={prompt.trim()}
              onClick={() => onPrompt(prompt)}
            />
          ))
        : null}
    </Stack>
  );
}
