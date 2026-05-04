import ViewAgendaIcon from '@mui/icons-material/ViewAgenda';
import ViewHeadlineIcon from '@mui/icons-material/ViewHeadline';
import { Box, Button, Tooltip } from '@mui/material';
import { isNullOrUndefined } from '../utils/misc';


type Props = {
  dense: boolean;
  onToggle: () => void;
  disabled?: boolean;
  slotWidth?: number;
};

export function TableDensityToggleButton({
  dense,
  onToggle,
  disabled = false,
  slotWidth,
}: Props) {
  return (
    <Box
      sx={{
        width: slotWidth ?? 'auto',
        display: 'flex',
        justifyContent: isNullOrUndefined(slotWidth) ? 'flex-end' : 'center',
        flexShrink: 0,
      }}
    >
      <Tooltip title={dense ? 'Звичайна таблиця' : 'Щільна таблиця'}>
        <span>
          <Button
            aria-label={dense ? 'Увімкнено щільну таблицю' : 'Увімкнути щільну таблицю'}
            color="primary"
            variant="outlined"
            disableElevation
            onClick={onToggle}
            disabled={disabled}
            size="small"
            sx={[
              {
                minWidth: 40,
                width: 40,
                height: 40,
                px: 1,
                py: 1,
              },
            ]}
          >
            {dense ? <ViewHeadlineIcon /> : <ViewAgendaIcon />}
          </Button>
        </span>
      </Tooltip>
    </Box>
  );
}
