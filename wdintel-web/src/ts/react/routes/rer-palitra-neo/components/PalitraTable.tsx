import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import {
  Box,
  Chip,
  CircularProgress,
  IconButton,
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

import { AreaOfResponsibility, MyScope, Organism, Palitra, User } from '../../../../../Bindings';
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
  onOpenEdit: (palitra: Palitra) => void;
  onRequestUploadPoints: (palitraId: number) => void;
  onDelete: (palitra: Palitra) => void;
};

function canModifyPalitra(user: User | null, palitra: Palitra): boolean {
  return isAdmin(user) || palitra.author === user?.name;
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
  onOpenEdit,
  onRequestUploadPoints,
  onDelete,
}: Props) {
  return (
    <Paper variant="outlined">
      {loading ? (
        <Box sx={{ p: 4, display: 'flex', justifyContent: 'center' }}>
          <CircularProgress size={28} />
        </Box>
      ) : (
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 820 }}>
            <TableHead>
              <TableRow>
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
                <TableCell align="right">Дія</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {palitras.map((palitra) => {
                const canModify = canModifyPalitra(user, palitra);
                const deleting = inFlightDeleteId === palitra.id;
                const uploading = inFlightUploadId === palitra.id;

                return (
                  <TableRow key={palitra.id} hover>
                    <TableCell>{palitra.name}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={palitra.colorHex}
                        sx={{
                          color: 'common.white',
                          backgroundColor: palitra.colorHex,
                          minWidth: '90px',
                          fontFamily: 'monospace',
                        }}
                      />
                    </TableCell>
                    <TableCell>{palitra.sourceFileName ?? '—'}</TableCell>
                    <TableCell>{palitra.author ?? '—'}</TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {getAccessSummary(palitra, user, myScope, organisms, aors)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      {canModify ? (
                        <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                          <Tooltip title="Редагувати">
                            <span>
                              <IconButton
                                size="small"
                                aria-label="Редагувати палітру"
                                onClick={() => onOpenEdit(palitra)}
                                disabled={deleting || uploading}
                              >
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title="Завантажити точки">
                            <span>
                              <IconButton
                                size="small"
                                aria-label="Завантажити точки палітри"
                                onClick={() => onRequestUploadPoints(palitra.id)}
                                disabled={deleting || uploading}
                              >
                                {uploading ? <CircularProgress size={16} /> : <CloudUploadIcon fontSize="small" />}
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title="Видалити">
                            <span>
                              <IconButton
                                size="small"
                                aria-label="Видалити палітру"
                                onClick={() => onDelete(palitra)}
                                disabled={deleting || uploading}
                              >
                                {deleting ? <CircularProgress size={16} /> : <DeleteIcon fontSize="small" color="error" />}
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Stack>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Paper>
  );
}
