import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import {
  Box,
  Button,
  ButtonGroup,
  Chip,
  CircularProgress,
  Paper,
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
import { getContrastRatio } from '@mui/material/styles';

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
  onOpenEdit: (palitra: Palitra) => void;
  onRequestUploadPoints: (palitraId: number) => void;
  onDelete: (palitra: Palitra) => void;
};

const actionsColumnSx = {
  width: 148,
  minWidth: 148,
  pr: 2,
};

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
          <Table sx={{ minWidth: 820 }}>
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
              {palitras.map((palitra) => {
                const canModify = canModifyPalitra(user, palitra);
                const deleting = inFlightDeleteId === palitra.id;
                const uploading = inFlightUploadId === palitra.id;
                const chipTextColor = getReadableTextColor(palitra.colorHex);

                return (
                  <TableRow key={palitra.id} hover>
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
                                  {deleting ? <CircularProgress size={16} /> : <DeleteIcon fontSize="small" color="error" />}
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
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Paper>
  );
}
