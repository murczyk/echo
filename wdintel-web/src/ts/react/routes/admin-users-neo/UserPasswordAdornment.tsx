import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { InputAdornment } from '@mui/material';
import { PowerIconButton } from '../../components/PowerIconButton';

export function UserPasswordAdornment({
  visible,
  disabled,
  toggle,
}: {
  visible: boolean;
  disabled: boolean;
  toggle: () => void;
}) {
  return (
    <InputAdornment position="end">
      <PowerIconButton
        type="button"
        aria-label={visible ? 'Приховати пароль' : 'Показати пароль'}
        onClick={toggle}
        onMouseDown={(event) => event.preventDefault()}
        edge="end"
        disabled={disabled}
      >
        {visible ? <VisibilityOffIcon /> : <VisibilityIcon />}
      </PowerIconButton>
    </InputAdornment>
  );
}
