import EditNoteOutlinedIcon from '@mui/icons-material/EditNoteOutlined';
import { Chip, Stack } from '@mui/material';

/** Composer context while a document is open: whether this message refers to
 * it as the document to change. */
export function DocumentEditContext({
  title,
  revision,
  enabled,
  onToggle,
}: {
  title: string;
  revision: number;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ pb: 0.5 }}>
      <Chip
        size="small"
        icon={<EditNoteOutlinedIcon />}
        color={enabled ? 'primary' : 'default'}
        variant={enabled ? 'filled' : 'outlined'}
        label={
          enabled ? `Документ: ${title} · v${revision}` : `Документ «${title}» — лише перегляд`
        }
        title={
          enabled
            ? 'ШІ змінюватиме цей документ, створюючи нову версію. Натисніть, щоб лише питати.'
            : 'Натисніть, щоб ШІ міг змінювати цей документ'
        }
        onClick={onToggle}
        aria-pressed={enabled}
        sx={{ maxWidth: '100%' }}
      />
    </Stack>
  );
}
