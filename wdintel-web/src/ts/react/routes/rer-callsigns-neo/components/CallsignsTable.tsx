import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import {
  Backdrop,
  Box,
  Button,
  ButtonGroup,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Tooltip,
  Typography,
} from '@mui/material';

import { formatDateTime } from '../helpers';
import type { CallsignRowView, CallsignsSortState, SortColumn } from '../types';

type Props = {
  rows: CallsignRowView[];
  loading: boolean;
  loadingMore: boolean;
  sort: CallsignsSortState;
  onSort: (column: SortColumn) => void;
  onEdit: (row: CallsignRowView) => void;
  onDelete: (row: CallsignRowView) => void;
};

const actionsColumnSx = {
  width: 96,
  minWidth: 96,
  pr: 2,
};

function CommentCell({ comment }: { comment: string }) {
  if (!comment) return <Typography variant="body2">—</Typography>;
  if (comment.length <= 80) return <Typography variant="body2">{comment}</Typography>;

  return (
    <Tooltip title={comment} placement="top-start">
      <Typography variant="body2" sx={{ maxWidth: 280 }} noWrap>
        {comment}
      </Typography>
    </Tooltip>
  );
}

export function CallsignsTable({ rows, loading, loadingMore, sort, onSort, onEdit, onDelete }: Props) {
  const tableBusy = loading || loadingMore;

  return (
    <Paper variant="outlined" sx={{ height: '100%' }}>
      <Box sx={{ position: 'relative', height: '100%' }} aria-busy={tableBusy}>
        <Backdrop
          open={loadingMore && !loading}
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 10,
            color: 'text.primary',
            backgroundColor: 'rgba(255, 255, 255, 0.45)',
          }}
        >
          <Stack direction="row" spacing={1.25} alignItems="center" role="status" aria-live="polite">
            <CircularProgress size={20} color="inherit" />
            <Typography variant="body2">Завантаження…</Typography>
          </Stack>
        </Backdrop>

        <TableContainer sx={{ height: '100%', maxHeight: '100%' }} aria-label="Список позивних">
          <Table stickyHeader size="small" aria-label="Таблиця позивних">
          <TableHead>
            <TableRow>
              <TableCell sortDirection={sort.column === 'callsign' ? sort.direction : false}>
                <TableSortLabel
                  active={sort.column === 'callsign'}
                  direction={sort.column === 'callsign' ? sort.direction : 'asc'}
                  onClick={() => onSort('callsign')}
                >
                  Позивний
                </TableSortLabel>
              </TableCell>
              <TableCell>Посада</TableCell>
              <TableCell>Коментар</TableCell>
              <TableCell sortDirection={sort.column === 'unit' ? sort.direction : false}>
                <TableSortLabel
                  active={sort.column === 'unit'}
                  direction={sort.column === 'unit' ? sort.direction : 'asc'}
                  onClick={() => onSort('unit')}
                >
                  Підрозділ
                </TableSortLabel>
              </TableCell>
              <TableCell>Джерело</TableCell>
              <TableCell>Частота</TableCell>
              <TableCell>Статус</TableCell>
              <TableCell sortDirection={sort.column === 'createdAt' ? sort.direction : false}>
                <TableSortLabel
                  active={sort.column === 'createdAt'}
                  direction={sort.column === 'createdAt' ? sort.direction : 'desc'}
                  onClick={() => onSort('createdAt')}
                >
                  Створено
                </TableSortLabel>
              </TableCell>
              <TableCell align="right" sx={actionsColumnSx} aria-label="Дії" />
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={9}>
                  <Stack direction="row" spacing={1} alignItems="center" justifyContent="center" sx={{ py: 4 }}>
                    <CircularProgress size={28} />
                  </Stack>
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9}>
                  <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
                    Нічого не знайдено за поточними фільтрами
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              <>
                {rows.map((row) => (
                  <TableRow key={row.id} hover>
                    <TableCell>
                      <Typography variant="body2" fontWeight={600}>
                        {row.callsign}
                      </Typography>
                    </TableCell>
                    <TableCell>{row.position || '—'}</TableCell>
                    <TableCell>
                      <CommentCell comment={row.comment} />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ maxWidth: 260 }} noWrap title={row.unitName}>
                        {row.unitName}
                      </Typography>
                    </TableCell>
                    <TableCell>{row.sourceName}</TableCell>
                    <TableCell>{row.radioFreq?.trim() ? row.radioFreq : '—'}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={row.developing ? 'Дорозвідка' : 'Відомий'}
                        color={row.developing ? 'warning' : 'default'}
                        variant={row.developing ? 'filled' : 'outlined'}
                      />
                    </TableCell>
                    <TableCell>{formatDateTime(row.createdAt)}</TableCell>
                    <TableCell align="right" sx={actionsColumnSx}>
                      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <ButtonGroup size="small" variant="outlined" aria-label={`Дії з позивним ${row.callsign}`}>
                          <Tooltip title="Редагувати">
                            <span>
                              <Button
                                aria-label={`Редагувати ${row.callsign}`}
                                onClick={() => onEdit(row)}
                                sx={{ minWidth: 36, px: 1 }}
                              >
                                <EditIcon fontSize="small" />
                              </Button>
                            </span>
                          </Tooltip>
                          <Tooltip title="Видалити">
                            <span>
                              <Button
                                aria-label={`Видалити ${row.callsign}`}
                                onClick={() => onDelete(row)}
                                sx={{ minWidth: 36, px: 1, color: 'error.main' }}
                              >
                                <DeleteIcon fontSize="small" color="error" />
                              </Button>
                            </span>
                          </Tooltip>
                        </ButtonGroup>
                      </Box>
                    </TableCell>
                  </TableRow>
                ))}
                {loadingMore ? (
                  <TableRow>
                    <TableCell colSpan={9}>
                      <Stack
                        direction="row"
                        spacing={1}
                        alignItems="center"
                        justifyContent="center"
                        sx={{ py: 2 }}
                        role="status"
                        aria-live="polite"
                      >
                        <CircularProgress size={18} />
                        <Typography variant="body2" color="text.secondary">
                          Завантаження…
                        </Typography>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ) : null}
              </>
            )}
          </TableBody>
          </Table>
        </TableContainer>
      </Box>
    </Paper>
  );
}
