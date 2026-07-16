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
        right: { xs: 'max(12px, env(safe-area-inset-right, 0px))', sm: 12 },
        bottom: { xs: 'max(12px, env(safe-area-inset-bottom, 0px))', sm: 12 },
        zIndex: 1000,
        width: 35,
        minWidth: 35,
        height: 35,
        minHeight: 35,
        boxShadow: 'none',
        '&:hover': {
          boxShadow: 'none',
        },
        '& .MuiSvgIcon-root': { fontSize: 20 },
      }}
    >
      <AddIcon />
    </Fab>
  );
}
