import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SaveIcon from '@mui/icons-material/Save';
import { CircularProgress, TextField, Typography } from '@mui/material';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';

export function MessageEditor({
  id,
  text,
  disabled,
  error,
  onChange,
  onBack,
  onSave,
}: {
  id: string | null;
  text: string;
  disabled: boolean;
  error: string | null;
  onChange: (text: string) => void;
  onBack: () => void;
  onSave: () => void;
}) {
  return (
    <section className="flex flex-col gap-echo-xl">
      <div className="flex items-center gap-echo-md">
        <PowerButton
          type="button"
          variant="outlined"
          disabled={disabled}
          onClick={onBack}
          startIcon={<ArrowBackIcon />}
        >
          Назад
        </PowerButton>
        <Typography component="h2" variant="h6">
          {id ? 'Редагувати тестове повідомлення' : 'Нове тестове повідомлення'}
        </Typography>
      </div>
      {error && <PowerAlert severity="error">{error}</PowerAlert>}
      <TextField
        fullWidth
        disabled
        label="ID"
        value={id ?? ''}
        helperText={id ? 'UUIDv7' : 'UUIDv7 буде створено автоматично'}
      />
      <TextField
        fullWidth
        required
        disabled={disabled}
        multiline
        minRows={8}
        label="Текст повідомлення"
        value={text}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="flex justify-end">
        <PowerButton
          type="button"
          variant="contained"
          disabled={disabled || !text.trim()}
          onClick={onSave}
          startIcon={disabled ? <CircularProgress size={18} /> : <SaveIcon />}
        >
          Зберегти
        </PowerButton>
      </div>
    </section>
  );
}
