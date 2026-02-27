import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import {
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  Chip,
  CircularProgress,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { getContrastRatio } from '@mui/material/styles';
import { ChangeEvent, useEffect, useMemo, useState } from 'react';

import { AreaOfResponsibility, MyScope, Organism, Palitra, User } from '../../../../../Bindings';
import { commonDenseTableSx } from '../../../components/tableDensity';
import { TableDensityToggleButton } from '../../../components/TableDensityToggleButton';
import { TableEmptyState } from '../../../components/TableEmptyState';
import { TableLoadingRow } from '../../../components/TableLoadingRow';
import { formatDateTime24 } from '../../../utils/misc';
import { getAccessSummary, isAdmin } from '../helpers';
import { SortColumn, SortDirection } from '../types';

type Props = {
  loading: boolean;
  denseTable: boolean;
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
  onClearSelectedPalitras: () => void;
  onDenseTableChange: (dense: boolean) => void;
};

type AuthorFilterOptions = {
  authors: string[];
  hasEmptyAuthor: boolean;
};

type PalitraTableToolbarProps = {
  denseTable: boolean;
  authorFilter: string;
  authorFilterOptions: AuthorFilterOptions;
  searchInput: string;
  hasActiveFilters: boolean;
  isSearchPending: boolean;
  selectedCount: number;
  onAuthorFilterChange: (value: string) => void;
  onSearchInputChange: (value: string) => void;
  onResetFilters: () => void;
  onClearSelectedPalitras: () => void;
  onDenseTableChange: (dense: boolean) => void;
};

const actionsColumnSx = {
  width: 148,
  minWidth: 148,
  pr: 2,
};
const tableColumnCount = 8;
const allAuthorsFilterValue = '__all__';
const emptyAuthorFilterValue = '__empty__';
const searchDebounceMs = 200;

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

function updateUrlSearchParams(mutator: (params: URLSearchParams) => void) {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  mutator(params);
  const nextSearch = params.toString();
  const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash}`;
  window.history.replaceState({}, '', nextUrl);
}

function readInitialPalitraTableFilters(): { authorFilter: string; searchInput: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    authorFilter: params.get('pal_author') ?? allAuthorsFilterValue,
    searchInput: params.get('pal_q') ?? '',
  };
}

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

function normalizeFilterText(value: string | null): string {
  return (value ?? '').trim().toLocaleLowerCase('uk');
}

function isEmptyAuthor(author: string | null): boolean {
  return author === null || author.trim() === '';
}

function hasNonEmptyAuthor(author: string | null): author is string {
  return !isEmptyAuthor(author);
}

function useDebouncedSearchQuery(value: string, delayMs: number): string {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    if (value === '') {
      setDebouncedValue('');
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [delayMs, value]);

  return debouncedValue;
}

function PalitraTableToolbar({
  denseTable,
  authorFilter,
  authorFilterOptions,
  searchInput,
  hasActiveFilters,
  isSearchPending,
  selectedCount,
  onAuthorFilterChange,
  onSearchInputChange,
  onResetFilters,
  onClearSelectedPalitras,
  onDenseTableChange,
}: PalitraTableToolbarProps) {
  return (
    <Box
      sx={{
        px: 2,
        pt: 2,
        pb: 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 2,
        flexWrap: 'wrap',
      }}
    >
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center', flex: '1 1 auto', minWidth: 0 }}>
        <FormControl size="small" sx={{ minWidth: 220 }}>
          <InputLabel id="palitra-author-filter-label">Автор</InputLabel>
          <Select
            labelId="palitra-author-filter-label"
            label="Автор"
            value={authorFilter}
            onChange={(event) => onAuthorFilterChange(event.target.value)}
          >
            <MenuItem value={allAuthorsFilterValue}>Усі</MenuItem>
            {authorFilterOptions.hasEmptyAuthor ? <MenuItem value={emptyAuthorFilterValue}>—</MenuItem> : null}
            {authorFilterOptions.authors.map((author) => (
              <MenuItem key={author} value={author}>
                {author}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <TextField
          size="small"
          label="Назва / файл"
          value={searchInput}
          onChange={(event) => onSearchInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || searchInput === '') return;
            event.preventDefault();
            onSearchInputChange('');
          }}
          sx={{ minWidth: 260, flex: '1 1 320px' }}
          InputProps={{
            endAdornment: searchInput !== '' ? (
              <InputAdornment position="end">
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  {isSearchPending ? (
                    <Box component="span" aria-hidden="true" sx={{ display: 'flex', alignItems: 'center' }}>
                      <CircularProgress size={14} color="inherit" />
                    </Box>
                  ) : null}
                  <Tooltip title="Очистити пошук">
                    <IconButton
                      size="small"
                      edge="end"
                      aria-label="Очистити пошук"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => onSearchInputChange('')}
                    >
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>
              </InputAdornment>
            ) : undefined,
          }}
        />

        {hasActiveFilters ? (
          <Button size="small" onClick={onResetFilters} sx={{ ml: 0.5, px: 1.5 }}>
            Очистити фільтри
          </Button>
        ) : null}

      </Box>

      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexShrink: 0 }}>
        {selectedCount > 0 ? (
          <Button size="small" onClick={onClearSelectedPalitras} sx={{ px: 1.5 }}>
            Очистити вибір
          </Button>
        ) : null}
        <TableDensityToggleButton dense={denseTable} onToggle={() => onDenseTableChange(!denseTable)} />
      </Box>
    </Box>
  );
}

export function PalitraTable({
  loading,
  denseTable,
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
  onClearSelectedPalitras,
  onDenseTableChange,
}: Props) {
  const actionsColumnSxDense = denseTable
    ? { width: 128, minWidth: 128, pr: 1.25 }
    : actionsColumnSx;
  const selectionColumnSx = denseTable
    ? { width: 44, minWidth: 44, pl: 1, pr: 0.5 }
    : { width: 52, minWidth: 52, pl: 1.5, pr: 1 };
  const initialUrlFilters = useMemo(() => readInitialPalitraTableFilters(), []);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [authorFilter, setAuthorFilter] = useState(initialUrlFilters.authorFilter);
  const [searchInput, setSearchInput] = useState(initialUrlFilters.searchInput);
  const searchQuery = useDebouncedSearchQuery(searchInput, searchDebounceMs);
  const authorFilterOptions = useMemo<AuthorFilterOptions>(() => {
    const authorSet = new Set<string>();
    let hasEmptyAuthor = false;

    for (const palitra of palitras) {
      const author = palitra.author;

      if (!hasNonEmptyAuthor(author)) {
        hasEmptyAuthor = true;
        continue;
      }

      authorSet.add(author);
    }

    return {
      authors: Array.from(authorSet).sort((left, right) => left.localeCompare(right, 'uk')),
      hasEmptyAuthor,
    };
  }, [palitras]);
  const filteredPalitras = useMemo(() => {
    const authorFilteredPalitras = (() => {
      if (authorFilter === allAuthorsFilterValue) {
        return palitras;
      }

      if (authorFilter === emptyAuthorFilterValue) {
        return palitras.filter((palitra) => isEmptyAuthor(palitra.author));
      }

      return palitras.filter((palitra) => palitra.author === authorFilter);
    })();
    const searchNeedle = normalizeFilterText(searchQuery);

    if (searchNeedle === '') {
      return authorFilteredPalitras;
    }

    return authorFilteredPalitras.filter((palitra) => {
      const nameText = normalizeFilterText(palitra.name);
      const sourceFileText = normalizeFilterText(palitra.sourceFileName);
      return nameText.includes(searchNeedle) || sourceFileText.includes(searchNeedle);
    });
  }, [authorFilter, palitras, searchQuery]);
  const hasActiveFiltersInput = authorFilter !== allAuthorsFilterValue || searchInput.trim() !== '';
  const hasActiveFiltersApplied = authorFilter !== allAuthorsFilterValue || searchQuery.trim() !== '';
  const isSearchPending = searchInput !== searchQuery;
  const paginatedPalitras =
    rowsPerPage === -1
      ? filteredPalitras
      : filteredPalitras.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);
  const selectedPalitraIdSet = new Set(selectedPalitraIds);
  const selectablePalitraIds = paginatedPalitras
    .filter((palitra) => canModifyPalitra(user, palitra) && inFlightDeleteId !== palitra.id && inFlightUploadId !== palitra.id)
    .map((palitra) => palitra.id);
  const selectedSelectableCount = selectablePalitraIds.filter((palitraId) => selectedPalitraIdSet.has(palitraId)).length;
  const allSelectableChecked = selectablePalitraIds.length > 0 && selectedSelectableCount === selectablePalitraIds.length;
  const hasPartialSelectableChecked = selectedSelectableCount > 0 && !allSelectableChecked;

  useEffect(() => {
    onClearSelectedPalitras();
    setPage(0);
  }, [authorFilter, onClearSelectedPalitras, sortColumn, sortDirection]);

  useEffect(() => {
    onClearSelectedPalitras();
    setPage(0);
  }, [onClearSelectedPalitras, searchInput]);

  useEffect(() => {
    if (
      authorFilter !== allAuthorsFilterValue &&
      authorFilter !== emptyAuthorFilterValue &&
      !authorFilterOptions.authors.includes(authorFilter)
    ) {
      setAuthorFilter(allAuthorsFilterValue);
    }

    if (authorFilter === emptyAuthorFilterValue && !authorFilterOptions.hasEmptyAuthor) {
      setAuthorFilter(allAuthorsFilterValue);
    }
  }, [authorFilter, authorFilterOptions]);

  useEffect(() => {
    updateUrlSearchParams((params) => {
      if (authorFilter === allAuthorsFilterValue) {
        params.delete('pal_author');
      } else {
        params.set('pal_author', authorFilter);
      }

      if (searchInput.trim() === '') {
        params.delete('pal_q');
      } else {
        params.set('pal_q', searchInput);
      }
    });
  }, [authorFilter, searchInput]);

  useEffect(() => {
    if (rowsPerPage === -1) {
      if (page !== 0) {
        setPage(0);
      }
      return;
    }

    const maxPage = Math.max(0, Math.ceil(filteredPalitras.length / rowsPerPage) - 1);
    if (page > maxPage) {
      onClearSelectedPalitras();
      setPage(maxPage);
    }
  }, [filteredPalitras.length, onClearSelectedPalitras, page, rowsPerPage]);

  function handlePageChange(_: unknown, nextPage: number) {
    onClearSelectedPalitras();
    setPage(nextPage);
  }

  function handleRowsPerPageChange(event: ChangeEvent<HTMLInputElement>) {
    onClearSelectedPalitras();
    setRowsPerPage(Number(event.target.value));
    setPage(0);
  }

  function resetFilters() {
    setAuthorFilter(allAuthorsFilterValue);
    setSearchInput('');
  }

  return (
    <Paper variant="outlined" sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <>
        <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
          <PalitraTableToolbar
            denseTable={denseTable}
            authorFilter={authorFilter}
            authorFilterOptions={authorFilterOptions}
            searchInput={searchInput}
            hasActiveFilters={hasActiveFiltersInput}
            isSearchPending={isSearchPending}
            selectedCount={selectedPalitraIds.length}
            onAuthorFilterChange={setAuthorFilter}
            onSearchInputChange={setSearchInput}
            onResetFilters={resetFilters}
            onClearSelectedPalitras={onClearSelectedPalitras}
            onDenseTableChange={onDenseTableChange}
          />
        </Box>
        <TableContainer
          sx={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: { xs: 'auto', lg: 'hidden' },
            WebkitOverflowScrolling: 'touch',
          }}
        >
          <Table
            stickyHeader
            size={denseTable ? 'small' : 'medium'}
            sx={{
              minWidth: 880,
              width: '100%',
              ...(denseTable ? commonDenseTableSx : {}),
            }}
          >
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" sx={selectionColumnSx}>
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
                    disabled={loading}
                    onClick={() => onSortColumn('name')}
                  >
                    Назва
                  </TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortColumn === 'colorHex' ? sortDirection : false}>
                  <TableSortLabel
                    active={sortColumn === 'colorHex'}
                    direction={sortColumn === 'colorHex' ? sortDirection : 'asc'}
                    disabled={loading}
                    onClick={() => onSortColumn('colorHex')}
                  >
                    Колір
                  </TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortColumn === 'sourceFileName' ? sortDirection : false}>
                  <TableSortLabel
                    active={sortColumn === 'sourceFileName'}
                    direction={sortColumn === 'sourceFileName' ? sortDirection : 'asc'}
                    disabled={loading}
                    onClick={() => onSortColumn('sourceFileName')}
                  >
                    Файл
                  </TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortColumn === 'lastUploadedAtTs' ? sortDirection : false}>
                  <TableSortLabel
                    active={sortColumn === 'lastUploadedAtTs'}
                    direction={sortColumn === 'lastUploadedAtTs' ? sortDirection : 'desc'}
                    disabled={loading}
                    onClick={() => onSortColumn('lastUploadedAtTs')}
                  >
                    Додано
                  </TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortColumn === 'author' ? sortDirection : false}>
                  <TableSortLabel
                    active={sortColumn === 'author'}
                    direction={sortColumn === 'author' ? sortDirection : 'asc'}
                    disabled={loading}
                    onClick={() => onSortColumn('author')}
                  >
                    Автор
                  </TableSortLabel>
                </TableCell>
                <TableCell>Доступ</TableCell>
                <TableCell align="right" sx={actionsColumnSxDense}>
                  <Box component="span" sx={visuallyHiddenSx}>
                    Дії
                  </Box>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                <TableLoadingRow colSpan={tableColumnCount} paddingY={6} />
              ) : filteredPalitras.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={tableColumnCount} sx={{ py: 6 }}>
                    <TableEmptyState
                      message={hasActiveFiltersApplied ? 'Немає палітр за обраними фільтрами' : 'Палітри відсутні'}
                      actionLabel={hasActiveFiltersInput ? 'Очистити фільтри' : undefined}
                      onAction={hasActiveFiltersInput ? resetFilters : undefined}
                    />
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
                      <TableCell padding="checkbox" sx={selectionColumnSx}>
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
                        <Typography variant="body2" color="text.secondary">
                          {getAccessSummary(palitra, user, myScope, organisms, aors)}
                        </Typography>
                      </TableCell>
                      <TableCell align="right" sx={actionsColumnSxDense}>
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
        {filteredPalitras.length > 0 ? (
          <TablePagination
            component="div"
            count={filteredPalitras.length}
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
