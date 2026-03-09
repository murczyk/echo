import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import {
  Backdrop,
  Box,
  Button,
  ButtonGroup,
  Checkbox,
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

import { loadingOverlayBackdropSx } from '../../../components/loadingOverlayStyles';
import { PowerChip } from '../../../components/PowerChip';
import { commonDenseTableSx } from '../../../components/tableDensity';
import { TableEmptyState } from '../../../components/TableEmptyState';
import { TableLoadingRow } from '../../../components/TableLoadingRow';
import { formatDateTime } from '../helpers';
import type { CallsignRowView, CallsignsSortState, SortColumn } from '../types';

type Props = {
  canEdit: boolean;
  denseTable: boolean;
  rows: CallsignRowView[];
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  hasActiveFilters: boolean;
  embedded?: boolean;
  inFlightDeleteId: number | null;
  bulkDeleteInFlight: boolean;
  selectedCallsignIds: number[];
  sort: CallsignsSortState;
  onSort: (column: SortColumn) => void;
  onClearFilters: () => void;
  onSetCallsignSelected: (callsignId: number, checked: boolean) => void;
  onSetAllCallsignsSelected: (callsignIds: number[], checked: boolean) => void;
  onEdit: (row: CallsignRowView) => void;
  onDelete: (row: CallsignRowView) => void;
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

export function CallsignsTable({
  canEdit,
  denseTable,
  rows,
  loading,
  refreshing,
  loadingMore,
  hasActiveFilters,
  embedded = false,
  inFlightDeleteId,
  bulkDeleteInFlight,
  selectedCallsignIds,
  sort,
  onSort,
  onClearFilters,
  onSetCallsignSelected,
  onSetAllCallsignsSelected,
  onEdit,
  onDelete,
}: Props) {
  const showEditColumns = canEdit || loading;
  const actionsColumnSx = denseTable
    ? { width: 92, minWidth: 92, pr: 1.25 }
    : { width: 104, minWidth: 104, pr: 2 };
  const selectionColumnSx = denseTable
    ? { width: 44, minWidth: 44, pl: 1, pr: 0.5 }
    : { width: 52, minWidth: 52, pl: 1.5, pr: 1 };
  const totalColumns = showEditColumns ? 10 : 8;
  const tableBusy = loading || refreshing || loadingMore;
  const showOverlay = (refreshing || loadingMore) && !loading;
  const selectedCallsignIdSet = new Set(selectedCallsignIds);
  const selectableCallsignIds = rows.filter((row) => inFlightDeleteId !== row.id && !bulkDeleteInFlight).map((row) => row.id);
  const selectedSelectableCount = selectableCallsignIds.filter((callsignId) => selectedCallsignIdSet.has(callsignId)).length;
  const allSelectableChecked = selectableCallsignIds.length > 0 && selectedSelectableCount === selectableCallsignIds.length;
  const hasPartialSelectableChecked = selectedSelectableCount > 0 && !allSelectableChecked;

  const tableContent = (
    <Box sx={{ position: 'relative', height: { xs: 'auto', lg: '100%' }, minHeight: 0 }} aria-busy={tableBusy}>
        <Backdrop
          open={showOverlay}
          sx={loadingOverlayBackdropSx}
        >
          <CircularProgress size={22} color="primary" role="status" aria-live="polite" aria-label={refreshing ? 'Оновлення' : 'Завантаження'} />
        </Backdrop>

        <TableContainer
          sx={{
            height: { xs: 'auto', lg: '100%' },
            maxHeight: { xs: '55vh', lg: '100%' },
            overflow: 'auto',
            WebkitOverflowScrolling: 'touch',
          }}
          aria-label="Список позивних"
        >
          <Table
            stickyHeader
            size={denseTable ? 'small' : 'medium'}
            aria-label="Таблиця позивних"
            sx={{
              minWidth: 980,
              ...(denseTable ? commonDenseTableSx : {}),
            }}
          >
          <TableHead>
            <TableRow>
              {showEditColumns ? (
                <TableCell padding="checkbox" sx={selectionColumnSx}>
                  <Checkbox
                    slotProps={{ input: { 'aria-label': 'Вибрати всі позивні' } }}
                    checked={allSelectableChecked}
                    indeterminate={hasPartialSelectableChecked}
                    disabled={!canEdit || selectableCallsignIds.length === 0}
                    onChange={(_, checked) => onSetAllCallsignsSelected(selectableCallsignIds, checked)}
                  />
                </TableCell>
              ) : null}
              <TableCell sortDirection={sort.column === 'callsign' ? sort.direction : false}>
                <TableSortLabel
                  active={sort.column === 'callsign'}
                  direction={sort.column === 'callsign' ? sort.direction : 'asc'}
                  disabled={loading}
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
                  disabled={loading}
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
                  disabled={loading}
                  onClick={() => onSort('createdAt')}
                >
                  Додано
                </TableSortLabel>
              </TableCell>
              {showEditColumns ? <TableCell align="right" sx={actionsColumnSx} aria-label="Дії" /> : null}
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableLoadingRow colSpan={totalColumns} paddingY={4} />
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={totalColumns}>
                  <TableEmptyState
                    message={hasActiveFilters ? 'Немає позивних за обраними фільтрами' : 'Позивні відсутні'}
                    actionLabel={hasActiveFilters ? 'Очистити фільтри' : undefined}
                    onAction={hasActiveFilters ? onClearFilters : undefined}
                  />
                </TableCell>
              </TableRow>
            ) : (
              <>
                {rows.map((row) => (
                  <TableRow key={row.id} hover>
                    {canEdit ? (
                      <TableCell padding="checkbox" sx={selectionColumnSx}>
                        <Checkbox
                          slotProps={{ input: { 'aria-label': `Вибрати позивний ${row.callsign}` } }}
                          checked={selectedCallsignIdSet.has(row.id)}
                          disabled={inFlightDeleteId === row.id || bulkDeleteInFlight}
                          onChange={(_, checked) => onSetCallsignSelected(row.id, checked)}
                        />
                      </TableCell>
                    ) : null}
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
                      <PowerChip
                        label={row.developing ? 'Дорозвідка' : 'Відомий'}
                        size="small"
                        interactive={false}
                        unselectedOpacity={1}
                        unselectedBackgroundColor={row.developing ? 'warning.main' : 'transparent'}
                        unselectedTextColor={row.developing ? 'warning.contrastText' : 'text.primary'}
                        unselectedBorderColor={row.developing ? 'warning.main' : 'divider'}
                      />
                    </TableCell>
                    <TableCell>{formatDateTime(row.createdAt)}</TableCell>
                    {canEdit ? (
                      <TableCell align="right" sx={actionsColumnSx}>
                        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                          <ButtonGroup size="small" variant="outlined" aria-label={`Дії з позивним ${row.callsign}`}>
                            <Tooltip title="Редагувати">
                              <span>
                                <Button
                                  aria-label={`Редагувати ${row.callsign}`}
                                  onClick={() => onEdit(row)}
                                  disabled={inFlightDeleteId === row.id || bulkDeleteInFlight}
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
                                  disabled={inFlightDeleteId === row.id || bulkDeleteInFlight}
                                  sx={{ minWidth: 36, px: 1, color: 'error.main' }}
                                >
                                  <DeleteIcon fontSize="small" color="error" />
                                </Button>
                              </span>
                            </Tooltip>
                          </ButtonGroup>
                        </Box>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
                {loadingMore && !refreshing ? (
                  <TableRow>
                    <TableCell colSpan={totalColumns}>
                      <Stack direction="row" alignItems="center" justifyContent="center" sx={{ py: 2 }} role="status" aria-live="polite">
                        <CircularProgress size={18} color="primary" aria-label="Завантаження" />
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
  );

  if (embedded) {
    return tableContent;
  }

  return (
    <Paper variant="outlined" sx={{ height: '100%' }}>
      {tableContent}
    </Paper>
  );
}
