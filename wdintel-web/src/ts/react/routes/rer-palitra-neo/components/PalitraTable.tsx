import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import {
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  Chip,
  CircularProgress,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  Tooltip,
  Typography,
} from '@mui/material';
import { getContrastRatio } from '@mui/material/styles';
import { ChangeEvent, useEffect, useState } from 'react';

import { AreaOfResponsibility, MyScope, Organism, Palitra, User } from '../../../../../Bindings';
import { formatDateTime24 } from '../../../utils/misc';
import { getAccessSummary, isAdmin } from '../helpers';
import { SortColumn, SortDirection } from '../types';

type Props = {
  loading: boolean;
  palitras: Palitra[];
  sortColumn: SortColumn;
  sortDirection: SortDirection;
  onSortColumn: (column: SortColumn) => void;
  user: User | null;
  myScope: MyScope | null;
  organisms: Organism[];
  aors: AreaOfResponsibility[];
  inFlightDeleteId: number | null;
  inFlightUploadId: number | null;
  selectedPalitraIds: number[];
  onOpenEdit: (palitra: Palitra) => void;
  onRequestUploadPoints: (palitraId: number) => void;
  onDelete: (palitra: Palitra) => void;
  onSetPalitraSelected: (palitraId: number, checked: boolean) => void;
  onSetAllPalitrasSelected: (palitraIds: number[], checked: boolean) => void;
};

const actionsColumnSx = {
  width: 148,
  minWidth: 148,
  pr: 2,
};
const tableColumnCount = 8;

const visuallyHiddenSx = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: 1,
  margin: -1,
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: 1,
};

function canModifyPalitra(user: User | null, palitra: Palitra): boolean {
  return isAdmin(user) || palitra.author === user?.name;
}

function getReadableTextColor(backgroundColor: string): string {
  try {
    const whiteContrast = getContrastRatio(backgroundColor, '#ffffff');
    const blackContrast = getContrastRatio(backgroundColor, '#000000');
    return whiteContrast >= blackContrast ? '#ffffff' : '#000000';
  } catch (_) {
    return '#000000';
  }
}

export function PalitraTable({
  loading,
  palitras,
  sortColumn,
  sortDirection,
  onSortColumn,
  user,
  myScope,
  organisms,
  aors,
  inFlightDeleteId,
  inFlightUploadId,
  selectedPalitraIds,
  onOpenEdit,
  onRequestUploadPoints,
  onDelete,
  onSetPalitraSelected,
  onSetAllPalitrasSelected,
}: Props) {
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const paginatedPalitras =
    rowsPerPage === -1 ? palitras : palitras.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);
  const selectedPalitraIdSet = new Set(selectedPalitraIds);
  const selectablePalitraIds = paginatedPalitras
    .filter((palitra) => canModifyPalitra(user, palitra) && inFlightDeleteId !== palitra.id && inFlightUploadId !== palitra.id)
    .map((palitra) => palitra.id);
  const selectedSelectableCount = selectablePalitraIds.filter((palitraId) => selectedPalitraIdSet.has(palitraId)).length;
  const allSelectableChecked = selectablePalitraIds.length > 0 && selectedSelectableCount === selectablePalitraIds.length;
  const hasPartialSelectableChecked = selectedSelectableCount > 0 && !allSelectableChecked;

  useEffect(() => {
    setPage(0);
  }, [sortColumn, sortDirection]);

  useEffect(() => {
    if (rowsPerPage === -1) {
      if (page !== 0) {
        setPage(0);
      }
      return;
    }

    const maxPage = Math.max(0, Math.ceil(palitras.length / rowsPerPage) - 1);
    if (page > maxPage) {
      setPage(maxPage);
    }
  }, [page, palitras.length, rowsPerPage]);

  function handlePageChange(_: unknown, nextPage: number) {
    setPage(nextPage);
  }

  function handleRowsPerPageChange(event: ChangeEvent<HTMLInputElement>) {
    setRowsPerPage(Number(event.target.value));
    setPage(0);
  }

  return (
    <Paper variant="outlined">
      <>
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table sx={{ minWidth: 880 }}>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  <Checkbox
                    slotProps={{ input: { 'aria-label': 'Вибрати всі палітри' } }}
                    checked={allSelectableChecked}
                    indeterminate={hasPartialSelectableChecked}
                    disabled={selectablePalitraIds.length === 0}
                    onChange={(_, checked) => onSetAllPalitrasSelected(selectablePalitraIds, checked)}
                  />
                </TableCell>
                <TableCell sortDirection={sortColumn === 'name' ? sortDirection : false}>
                  <TableSortLabel
                    active={sortColumn === 'name'}
                    direction={sortColumn === 'name' ? sortDirection : 'asc'}
                    onClick={() => onSortColumn('name')}
                  >
                    Назва
                  </TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortColumn === 'colorHex' ? sortDirection : false}>
                  <TableSortLabel
                    active={sortColumn === 'colorHex'}
                    direction={sortColumn === 'colorHex' ? sortDirection : 'asc'}
                    onClick={() => onSortColumn('colorHex')}
                  >
                    Колір
                  </TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortColumn === 'sourceFileName' ? sortDirection : false}>
                  <TableSortLabel
                    active={sortColumn === 'sourceFileName'}
                    direction={sortColumn === 'sourceFileName' ? sortDirection : 'asc'}
                    onClick={() => onSortColumn('sourceFileName')}
                  >
                    Файл
                  </TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortColumn === 'lastUploadedAtTs' ? sortDirection : false}>
                  <TableSortLabel
                    active={sortColumn === 'lastUploadedAtTs'}
                    direction={sortColumn === 'lastUploadedAtTs' ? sortDirection : 'desc'}
                    onClick={() => onSortColumn('lastUploadedAtTs')}
                  >
                    Додано
                  </TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortColumn === 'author' ? sortDirection : false}>
                  <TableSortLabel
                    active={sortColumn === 'author'}
                    direction={sortColumn === 'author' ? sortDirection : 'asc'}
                    onClick={() => onSortColumn('author')}
                  >
                    Автор
                  </TableSortLabel>
                </TableCell>
                <TableCell>Доступ</TableCell>
                <TableCell align="right" sx={actionsColumnSx}>
                  <Box component="span" sx={visuallyHiddenSx}>
                    Дії
                  </Box>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={tableColumnCount} sx={{ py: 6 }}>
                    <Box sx={{ display: 'flex', justifyContent: 'center' }}>
                      <CircularProgress size={28} />
                    </Box>
                  </TableCell>
                </TableRow>
              ) : paginatedPalitras.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={tableColumnCount} sx={{ py: 6 }}>
                    <Typography variant="body2" color="text.secondary" align="center">
                      Палітри відсутні
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                paginatedPalitras.map((palitra) => {
                  const canModify = canModifyPalitra(user, palitra);
                  const deleting = inFlightDeleteId === palitra.id;
                  const uploading = inFlightUploadId === palitra.id;
                  const chipTextColor = getReadableTextColor(palitra.colorHex);

                  return (
                    <TableRow key={palitra.id} hover>
                      <TableCell padding="checkbox">
                        <Checkbox
                          slotProps={{ input: { 'aria-label': `Вибрати палітру ${palitra.name}` } }}
                          checked={selectedPalitraIdSet.has(palitra.id)}
                          disabled={!canModify || deleting || uploading}
                          onChange={(_, checked) => onSetPalitraSelected(palitra.id, checked)}
                        />
                      </TableCell>
                      <TableCell>{palitra.name}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={palitra.colorHex}
                          sx={{
                            color: chipTextColor,
                            backgroundColor: palitra.colorHex,
                            minWidth: '90px',
                            fontFamily: 'monospace',
                          }}
                        />
                      </TableCell>
                      <TableCell>{palitra.sourceFileName ?? '—'}</TableCell>
                      <TableCell>{formatDateTime24(palitra.lastUploadedAtTs)}</TableCell>
                      <TableCell>{palitra.author ?? '—'}</TableCell>
                      <TableCell>
                        <Typography variant="caption" color="text.secondary">
                          {getAccessSummary(palitra, user, myScope, organisms, aors)}
                        </Typography>
                      </TableCell>
                      <TableCell align="right" sx={actionsColumnSx}>
                        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                          {canModify ? (
                            <ButtonGroup size="small" variant="outlined" aria-label="Дії з палітрою">
                              <Tooltip title="Редагувати">
                                <span>
                                  <Button
                                    aria-label="Редагувати палітру"
                                    onClick={() => onOpenEdit(palitra)}
                                    disabled={deleting || uploading}
                                    sx={{ minWidth: 36, px: 1 }}
                                  >
                                    <EditIcon fontSize="small" />
                                  </Button>
                                </span>
                              </Tooltip>
                              <Tooltip title="Завантажити точки">
                                <span>
                                  <Button
                                    aria-label="Завантажити точки палітри"
                                    onClick={() => onRequestUploadPoints(palitra.id)}
                                    disabled={deleting || uploading}
                                    sx={{ minWidth: 36, px: 1 }}
                                  >
                                    {uploading ? <CircularProgress size={16} /> : <CloudUploadIcon fontSize="small" />}
                                  </Button>
                                </span>
                              </Tooltip>
                              <Tooltip title="Видалити">
                                <span>
                                  <Button
                                    aria-label="Видалити палітру"
                                    onClick={() => onDelete(palitra)}
                                    disabled={deleting || uploading}
                                    sx={{ minWidth: 36, px: 1, color: 'error.main' }}
                                  >
                                    {deleting ? (
                                      <CircularProgress size={16} />
                                    ) : (
                                      <DeleteIcon fontSize="small" color="error" />
                                    )}
                                  </Button>
                                </span>
                              </Tooltip>
                            </ButtonGroup>
                          ) : (
                            '—'
                          )}
                        </Box>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </TableContainer>
        {palitras.length > 0 ? (
          <TablePagination
            component="div"
            count={palitras.length}
            page={rowsPerPage === -1 ? 0 : page}
            onPageChange={handlePageChange}
            rowsPerPage={rowsPerPage}
            onRowsPerPageChange={handleRowsPerPageChange}
            rowsPerPageOptions={[10, 25, 50, { label: 'Всі', value: -1 }]}
            labelRowsPerPage="Рядків на сторінці:"
            labelDisplayedRows={({ from, to, count }) => `${from}–${to} з ${count}`}
            sx={{
              '& .MuiTablePagination-toolbar': {
                minHeight: 52,
                alignItems: 'center',
              },
              '& .MuiTablePagination-selectLabel, & .MuiTablePagination-displayedRows': {
                mb: 0,
                display: 'flex',
                alignItems: 'center',
              },
            }}
          />
        ) : null}
      </>
    </Paper>
  );
}
