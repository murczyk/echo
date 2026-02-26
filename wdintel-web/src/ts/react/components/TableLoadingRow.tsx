import { CircularProgress, Stack, TableCell, TableRow } from '@mui/material';

type Props = {
  colSpan: number;
  paddingY?: number;
  spinnerSize?: number;
  ariaLabel?: string;
};

export function TableLoadingRow({
  colSpan,
  paddingY = 6,
  spinnerSize = 28,
  ariaLabel = 'Завантаження',
}: Props) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan}>
        <Stack direction="row" alignItems="center" justifyContent="center" sx={{ py: paddingY }}>
          <CircularProgress size={spinnerSize} color="primary" aria-label={ariaLabel} />
        </Stack>
      </TableCell>
    </TableRow>
  );
}
