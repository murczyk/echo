import { Fab } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';

type Props = {
  onClick: () => void;
};

export function CreateMessageFab({ onClick }: Props) {
  return (
    <Fab
      color="primary"
      aria-label="Додати повідомлення"
      onClick={onClick}
      sx={{
        position: 'absolute',
        bottom: 24,
        right: 24,
        zIndex: 1000,
      }}
    >
      <AddIcon />
    </Fab>
  );
}
