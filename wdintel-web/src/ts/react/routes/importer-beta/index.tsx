import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import CloudDownloadOutlinedIcon from '@mui/icons-material/CloudDownloadOutlined';
import ContentPasteGoOutlinedIcon from '@mui/icons-material/ContentPasteGoOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import KeyboardDoubleArrowDownIcon from '@mui/icons-material/KeyboardDoubleArrowDown';
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControl,
  IconButton,
  LinearProgress,
  Link,
  MenuItem,
  Radio,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import type { AlertColor, SelectChangeEvent } from '@mui/material';
import { useRef, useState } from 'react';

import type { DownloadKmzReq, RowInfo } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PageHeader } from '../../components/PageHeader';
import {
  downloadImporterGeojson,
  downloadImporterKmz,
  uploadImporterPdf,
  uploadImporterScreenshot,
} from '../../services/api/importer';
import { downloadBlob } from '../../utils/download-blob';
import {
  exampleContent,
  genericIcon,
  getIcon,
  isTitleStandard,
  knownIcons,
  operatyvkaExamples,
  renameIcons,
  replaceFilenameMacros,
} from './constants';
import {
  convertCoordinateToWgs84,
  coordinateToLatLng,
  extractCoordinates,
  renderCoordinate,
  renderWgsFloat,
  type ImporterCoordinate,
  type LatLng,
} from './coordinates';
import { proposeImporterIcons } from './icon-search';

type SelectedCoord = { kind: 'indices'; indices: number[] } | { kind: 'manual' } | { kind: 'none' };

type PendingUpload = {
  id: string;
};

type ImporterRow = {
  id: number;
  content: string;
  coordinates: ImporterCoordinate[];
  coordinatesWgs84: Record<number, LatLng>;
  selected: SelectedCoord;
  manualCoordTxt: string;
  title: string;
  icon: string;
  proposedIcons: string[];
  proposedTitles: string[];
  filesToUpload: PendingUpload[];
  imageUrls: string[];
};

type Status = {
  kind: AlertColor;
  text: string;
};

type DownloadKind = 'kmz' | 'geojson';

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Невідома помилка';
}

function createEmptyRow(id: number): ImporterRow {
  return {
    id,
    content: '',
    coordinates: [],
    coordinatesWgs84: {},
    selected: { kind: 'none' },
    manualCoordTxt: '',
    title: '',
    icon: genericIcon.icon,
    proposedIcons: [],
    proposedTitles: [],
    filesToUpload: [],
    imageUrls: [],
  };
}

function updateRow(
  rows: ImporterRow[],
  rowId: number,
  update: (row: ImporterRow, rowIndex: number) => ImporterRow,
): ImporterRow[] {
  return rows.map((row, rowIndex) => (row.id === rowId ? update(row, rowIndex) : row));
}

function selectFirstIfPossible(coordinates: ImporterCoordinate[]): SelectedCoord {
  return coordinates.length > 0 ? { kind: 'indices', indices: [0] } : { kind: 'none' };
}

function convertCoordinates(coordinates: ImporterCoordinate[]): Record<number, LatLng> {
  const converted: Record<number, LatLng> = {};
  coordinates.forEach((coord, index) => {
    const latLng = convertCoordinateToWgs84(coord);
    if (latLng && (coord.kind === 'usk2000' || coord.kind === 'mgrs')) {
      converted[index] = latLng;
    }
  });
  return converted;
}

function applyIconToRow(row: ImporterRow, icon: string): ImporterRow {
  const iconInfo = getIcon(icon);
  const title = isTitleStandard(row.title) ? iconInfo.titleMain : row.title;
  return {
    ...row,
    icon,
    title,
    proposedTitles: [title, ...iconInfo.titleExtras],
  };
}

function buildRowInfo(row: ImporterRow): RowInfo[] {
  if (row.selected.kind === 'none') return [];

  if (row.selected.kind === 'manual') {
    const coord = extractCoordinates(row.manualCoordTxt).find((item) => item.kind === 'wgs84');
    if (!coord || coord.kind !== 'wgs84') return [];
    return [rowInfoFromLatLng(row, { lat: coord.lat, lng: coord.lng })];
  }

  return row.selected.indices.flatMap((coordIndex) => {
    const coord = row.coordinates[coordIndex];
    if (!coord) return [];
    const latLng = coordinateToLatLng(coord, row.coordinatesWgs84[coordIndex]);
    return latLng ? [rowInfoFromLatLng(row, latLng)] : [];
  });
}

function rowInfoFromLatLng(row: ImporterRow, latLng: LatLng): RowInfo {
  return {
    content: row.content,
    imageUrls: row.imageUrls,
    lat: renderWgsFloat(latLng.lat),
    lng: renderWgsFloat(latLng.lng),
    title: row.title,
    icon: row.icon,
  };
}

function buildDownloadReq(rows: ImporterRow[], folderName: string): DownloadKmzReq {
  return {
    rows: rows.flatMap(buildRowInfo),
    folderName,
  };
}

function selectedIndices(selected: SelectedCoord): number[] {
  return selected.kind === 'indices' ? selected.indices : [];
}

function nextUploadId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function readClipboardPng(): Promise<Blob | null> {
  if (!navigator.clipboard || !('read' in navigator.clipboard)) return null;
  const contents = await navigator.clipboard.read();
  for (const item of contents) {
    if (item.types.includes('image/png')) {
      return item.getType('image/png');
    }
  }
  return null;
}

function rowsFromPdf(rows: RowInfo[], takeNextRowId: () => number): ImporterRow[] {
  return rows.flatMap((row) => {
    const lat = Number(row.lat);
    const lng = Number(row.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

    return [
      {
        ...createEmptyRow(takeNextRowId()),
        content: row.content,
        imageUrls: row.imageUrls,
        coordinates: [{ kind: 'wgs84', lat, lng }],
        selected: { kind: 'indices', indices: [0] },
        title: row.title,
        icon: row.icon,
      },
    ];
  });
}

function ImporterIconImage({ icon, size = 20 }: { icon: string; size?: number }) {
  return (
    <Box
      component="img"
      src={`/img/google_earth_icons/${icon}`}
      alt=""
      sx={{ width: size, height: size, objectFit: 'contain', flexShrink: 0 }}
    />
  );
}

function PdfProgress() {
  return (
    <Box sx={{ maxWidth: 680, mb: 3 }}>
      <LinearProgress />
      <Box component="ol" sx={{ mt: 1.5, mb: 0, pl: 3 }}>
        <Typography component="li" variant="body2">
          завантажую файл на сервер
        </Typography>
        <Typography component="li" variant="body2">
          перетворюю на текст
        </Typography>
        <Typography component="li" variant="body2">
          виймаю точки
        </Typography>
        <Typography component="li" variant="body2" sx={{ fontWeight: 700 }}>
          вирізаю картинки
        </Typography>
        <Typography component="li" variant="body2">
          готово
        </Typography>
      </Box>
    </Box>
  );
}

type ImporterRowViewProps = {
  row: ImporterRow;
  rowIndex: number;
  onContentChange: (rowId: number, content: string) => void;
  onSelectCoordinate: (rowId: number, coordIndex: number) => void;
  onSelectAll: (rowId: number) => void;
  onSelectManual: (rowId: number) => void;
  onManualCoordChange: (rowId: number, value: string) => void;
  onTitleChange: (rowId: number, title: string) => void;
  onIconChange: (rowId: number, icon: string) => void;
  onApplyIconDownwards: (rowId: number) => void;
  onDeleteRow: (rowId: number) => void;
  onUploadImages: (rowId: number) => void;
  onPasteImage: (rowId: number) => void;
  onDeleteImage: (rowId: number, url: string) => void;
};

function ImporterRowView(props: ImporterRowViewProps) {
  const {
    row,
    rowIndex,
    onContentChange,
    onSelectCoordinate,
    onSelectAll,
    onSelectManual,
    onManualCoordChange,
    onTitleChange,
    onIconChange,
    onApplyIconDownwards,
    onDeleteRow,
    onUploadImages,
    onPasteImage,
    onDeleteImage,
  } = props;
  const rowExample = operatyvkaExamples[rowIndex] ?? exampleContent;
  const hasCoordinates = row.coordinates.length > 0;

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: 'minmax(0, 1fr)',
          lg: '500px 190px 270px 210px 64px',
        },
        alignItems: 'start',
        columnGap: 2,
        rowGap: 2,
        mb: 3,
        pb: 3,
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Box>
        <TextField
          label={row.content === '' ? 'оперативка' : undefined}
          placeholder="Вставте текст оперативки"
          value={row.content}
          onChange={(event) => onContentChange(row.id, event.target.value)}
          multiline
          minRows={5}
          fullWidth
          size="small"
          inputProps={{ style: { fontFamily: 'monospace' } }}
        />
        <Button
          size="small"
          variant="text"
          onClick={() => onContentChange(row.id, rowExample)}
          sx={{ mt: 0.5, px: 0, minWidth: 0, textTransform: 'none' }}
        >
          наприклад
        </Button>

        <Stack
          direction="row"
          flexWrap="wrap"
          spacing={1}
          useFlexGap
          sx={{ mt: 1, alignItems: 'center' }}
        >
          {row.imageUrls.map((url) => (
            <Box key={url} sx={{ display: 'inline-flex', alignItems: 'flex-start', gap: 0.5 }}>
              <Link href={url} target="_blank" rel="noopener noreferrer">
                <Box
                  component="img"
                  src={url}
                  alt=""
                  sx={{
                    height: 50,
                    width: 'auto',
                    maxWidth: 96,
                    objectFit: 'cover',
                    borderRadius: 1,
                  }}
                />
              </Link>
              <Tooltip title="Видалити знімок">
                <IconButton
                  size="small"
                  color="error"
                  onClick={() => onDeleteImage(row.id, url)}
                  aria-label="Видалити знімок"
                >
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          ))}

          {row.filesToUpload.map((file) => (
            <CircularProgress key={file.id} size={20} />
          ))}

          <Button
            size="small"
            variant="outlined"
            startIcon={<ImageOutlinedIcon />}
            onClick={() => onUploadImages(row.id)}
          >
            додати знімки
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<ContentPasteGoOutlinedIcon />}
            onClick={() => onPasteImage(row.id)}
          >
            вставити з буферу
          </Button>
        </Stack>
      </Box>

      <Stack spacing={0.5}>
        {row.coordinates.map((coord, coordIndex) => {
          const checked = selectedIndices(row.selected).includes(coordIndex);
          return (
            <Box
              key={`${coordIndex}-${renderCoordinate(coord)}`}
              component="label"
              sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
            >
              <Checkbox
                size="small"
                checked={checked}
                onChange={() => onSelectCoordinate(row.id, coordIndex)}
                sx={{ p: 0.5 }}
              />
              <Box
                component="span"
                sx={{
                  px: 0.75,
                  py: 0.125,
                  borderRadius: 1,
                  bgcolor: 'text.secondary',
                  color: 'background.paper',
                  fontSize: '0.75rem',
                }}
              >
                {coordIndex + 1}
              </Box>
              <Typography variant="body2" sx={{ whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
                {renderCoordinate(coord)}
              </Typography>
            </Box>
          );
        })}
        {row.coordinates.length > 1 ? (
          <Button
            size="small"
            variant="text"
            onClick={() => onSelectAll(row.id)}
            sx={{ alignSelf: 'center', textTransform: 'none' }}
          >
            всі
          </Button>
        ) : null}
        {hasCoordinates ? (
          <Box component="label" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Radio
              size="small"
              checked={row.selected.kind === 'manual'}
              onChange={() => onSelectManual(row.id)}
              sx={{ p: 0.5 }}
            />
            <TextField
              value={row.manualCoordTxt}
              placeholder="ручний ввід"
              onClick={() => onSelectManual(row.id)}
              onChange={(event) => onManualCoordChange(row.id, event.target.value)}
              size="small"
              inputProps={{
                style: { textAlign: 'center', fontFamily: 'monospace', padding: '4px 6px' },
              }}
              sx={{ width: 140 }}
            />
          </Box>
        ) : null}
      </Stack>

      {hasCoordinates ? (
        <Stack spacing={1} sx={{ alignItems: 'center' }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', width: '100%' }}>
            <ImporterIconImage icon={row.icon} />
            <FormControl size="small" fullWidth>
              <Select
                value={row.icon}
                onChange={(event: SelectChangeEvent) => onIconChange(row.id, event.target.value)}
                renderValue={(value) => getIcon(value).name}
              >
                {knownIcons.map((icon) => (
                  <MenuItem key={icon.icon} value={icon.icon}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <ImporterIconImage icon={icon.icon} />
                      <span>{icon.name}</span>
                    </Stack>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Tooltip title="Застосувати до всіх вниз">
              <IconButton
                size="small"
                onClick={() => onApplyIconDownwards(row.id)}
                aria-label="Застосувати іконку до всіх рядків нижче"
              >
                <KeyboardDoubleArrowDownIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>

          <Stack direction="row" flexWrap="wrap" useFlexGap sx={{ justifyContent: 'center' }}>
            {row.proposedIcons.map((icon) => (
              <Tooltip title={getIcon(icon).name || icon} key={icon}>
                <IconButton
                  size="small"
                  onClick={() => onIconChange(row.id, icon)}
                  aria-label={`Обрати іконку ${getIcon(icon).name || icon}`}
                >
                  <ImporterIconImage icon={icon} />
                </IconButton>
              </Tooltip>
            ))}
          </Stack>
        </Stack>
      ) : (
        <Box />
      )}

      {hasCoordinates ? (
        <Stack spacing={0.5} sx={{ alignItems: 'stretch' }}>
          <TextField
            value={row.title}
            placeholder="заголовок"
            onChange={(event) => onTitleChange(row.id, event.target.value)}
            size="small"
            inputProps={{ style: { textAlign: 'center', padding: '6px 8px' } }}
          />
          {row.proposedTitles
            .filter((title) => title !== '')
            .map((title) => (
              <Button
                key={title}
                size="small"
                variant="text"
                onClick={() => onTitleChange(row.id, title)}
                sx={{ textTransform: 'none' }}
              >
                {title}
              </Button>
            ))}
        </Stack>
      ) : (
        <Box />
      )}

      <Box sx={{ display: 'flex', justifyContent: { xs: 'flex-start', lg: 'center' } }}>
        <Tooltip title="Видалити рядок">
          <IconButton color="error" onClick={() => onDeleteRow(row.id)} aria-label="Видалити рядок">
            <DeleteOutlineIcon />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}

export function ImporterBetaPage() {
  const nextRowIdRef = useRef(1);
  const iconProposalRequestRef = useRef(0);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const [rows, setRows] = useState<ImporterRow[]>([createEmptyRow(0)]);
  const [downloadFileName, setDownloadFileName] = useState('operatyvka-<DATETIME>');
  const [downloadInProgress, setDownloadInProgress] = useState<DownloadKind | null>(null);
  const [pdfToProcess, setPdfToProcess] = useState<string | null>(null);
  const [imageUploadRowId, setImageUploadRowId] = useState<number | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  const takeNextRowId = () => {
    const next = nextRowIdRef.current;
    nextRowIdRef.current += 1;
    return next;
  };

  const proposeIcons = (rowId: number, content: string) => {
    const requestId = ++iconProposalRequestRef.current;
    void proposeImporterIcons(content)
      .then((rawIcons) => {
        const icons = renameIcons(rawIcons);
        setRows((currentRows) =>
          updateRow(currentRows, rowId, (row) => {
            if (row.content !== content || requestId < iconProposalRequestRef.current - 8)
              return row;
            const rowWithProposals = { ...row, proposedIcons: icons };
            return icons[0] ? applyIconToRow(rowWithProposals, icons[0]) : rowWithProposals;
          }),
        );
      })
      .catch((error) => {
        setStatus({ kind: 'error', text: `Помилка підбору іконок: ${toErrorMessage(error)}` });
      });
  };

  const handleContentChange = (rowId: number, content: string) => {
    const coordinates = extractCoordinates(content);
    setRows((currentRows) =>
      updateRow(currentRows, rowId, (row) => ({
        ...row,
        content,
        coordinates,
        coordinatesWgs84: convertCoordinates(coordinates),
        selected: selectFirstIfPossible(coordinates),
        icon: genericIcon.icon,
        proposedIcons: [],
        proposedTitles: [],
      })),
    );
    proposeIcons(rowId, content);
  };

  const handleSelectCoordinate = (rowId: number, coordIndex: number) => {
    setRows((currentRows) =>
      updateRow(currentRows, rowId, (row) => {
        const current = selectedIndices(row.selected);
        const indices = current.includes(coordIndex)
          ? current.filter((item) => item !== coordIndex)
          : [...current, coordIndex];
        return { ...row, selected: { kind: 'indices', indices } };
      }),
    );
  };

  const handleSelectAll = (rowId: number) => {
    setRows((currentRows) =>
      updateRow(currentRows, rowId, (row) => ({
        ...row,
        selected: { kind: 'indices', indices: row.coordinates.map((_, index) => index) },
      })),
    );
  };

  const handleUploadOneImage = async (rowId: number, image: File | Blob) => {
    const pending = { id: nextUploadId() };
    setRows((currentRows) =>
      updateRow(currentRows, rowId, (row) => ({
        ...row,
        filesToUpload: [...row.filesToUpload, pending],
      })),
    );

    try {
      const res = await uploadImporterScreenshot(image);
      setRows((currentRows) =>
        updateRow(currentRows, rowId, (row) => ({
          ...row,
          filesToUpload: row.filesToUpload.filter((item) => item.id !== pending.id),
          imageUrls: [...row.imageUrls, res.imageUrl],
        })),
      );
    } catch (error) {
      setRows((currentRows) =>
        updateRow(currentRows, rowId, (row) => ({
          ...row,
          filesToUpload: row.filesToUpload.filter((item) => item.id !== pending.id),
        })),
      );
      setStatus({
        kind: 'error',
        text: `Помилка завантаження зображень: ${toErrorMessage(error)}`,
      });
    }
  };

  const handleImageFilesSelected = (files: FileList | null) => {
    if (imageUploadRowId === null || !files || files.length === 0) return;
    Array.from(files).forEach((file) => void handleUploadOneImage(imageUploadRowId, file));
    setImageUploadRowId(null);
  };

  const handlePdfSelected = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;

    setPdfToProcess(file.name);
    try {
      const res = await uploadImporterPdf(file);
      setRows((currentRows) => [...rowsFromPdf(res.rows, takeNextRowId), ...currentRows]);
    } catch (error) {
      setStatus({ kind: 'error', text: `Помилка завантаження PDF: ${toErrorMessage(error)}` });
    } finally {
      setPdfToProcess(null);
    }
  };

  const handlePasteImage = async (rowId: number) => {
    try {
      const blob = await readClipboardPng();
      if (!blob) {
        setStatus({ kind: 'warning', text: 'У буфері обміну немає PNG-зображення' });
        return;
      }
      await handleUploadOneImage(rowId, blob);
    } catch (error) {
      setStatus({ kind: 'error', text: `Помилка вставлення зображення: ${toErrorMessage(error)}` });
    }
  };

  const handleDownload = async (kind: DownloadKind) => {
    const req = buildDownloadReq(rows, downloadFileName);
    setDownloadInProgress(kind);
    try {
      const blob =
        kind === 'kmz' ? await downloadImporterKmz(req) : await downloadImporterGeojson(req);
      const now = new Date();
      const fileName =
        kind === 'kmz'
          ? `${replaceFilenameMacros(now, downloadFileName)}.kmz`
          : replaceFilenameMacros(now, `${downloadFileName}.geojson`);
      downloadBlob(blob, fileName);
    } catch (error) {
      setStatus({
        kind: 'error',
        text:
          kind === 'kmz'
            ? `Помилка завантаження KMZ: ${toErrorMessage(error)}`
            : `Помилка завантаження GeoJSON: ${toErrorMessage(error)}`,
      });
    } finally {
      setDownloadInProgress(null);
    }
  };

  return (
    <Box sx={{ width: '100%', maxWidth: 1280, mx: 'auto' }}>
      <PageHeader
        title={
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <span>Імпортер</span>
            <Box
              component="span"
              sx={{
                border: '1px solid',
                borderColor: 'rgba(245, 158, 11, 0.4)',
                bgcolor: '#fef3c7',
                color: '#b45309',
                borderRadius: 999,
                px: 0.75,
                py: 0.25,
                fontSize: '10px',
                fontWeight: 700,
                lineHeight: 1,
                textTransform: 'uppercase',
              }}
            >
              Beta
            </Box>
          </Stack>
        }
      />

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Окрім ручного вводу, ви також можете{' '}
        <Link
          component="button"
          type="button"
          onClick={() => {
            if (pdfInputRef.current) {
              pdfInputRef.current.value = '';
              pdfInputRef.current.click();
            }
          }}
          sx={{ verticalAlign: 'baseline' }}
        >
          підвантажити PDF-рапорт з програми "Термінал"
        </Link>
      </Typography>

      {status ? (
        <PowerAlert severity={status.kind} sx={{ mb: 2 }} onClose={() => setStatus(null)}>
          {status.text}
        </PowerAlert>
      ) : null}

      {pdfToProcess ? <PdfProgress /> : null}

      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpg,image/jpeg"
        multiple
        hidden
        onChange={(event) => handleImageFilesSelected(event.target.files)}
      />
      <input
        ref={pdfInputRef}
        type="file"
        accept="application/pdf"
        hidden
        onChange={(event) => void handlePdfSelected(event.target.files)}
      />

      {rows.map((row, rowIndex) => (
        <ImporterRowView
          key={row.id}
          row={row}
          rowIndex={rowIndex}
          onContentChange={handleContentChange}
          onSelectCoordinate={handleSelectCoordinate}
          onSelectAll={handleSelectAll}
          onSelectManual={(rowId) =>
            setRows((currentRows) =>
              updateRow(currentRows, rowId, (row) => ({ ...row, selected: { kind: 'manual' } })),
            )
          }
          onManualCoordChange={(rowId, value) =>
            setRows((currentRows) =>
              updateRow(currentRows, rowId, (row) => ({ ...row, manualCoordTxt: value })),
            )
          }
          onTitleChange={(rowId, title) =>
            setRows((currentRows) => updateRow(currentRows, rowId, (row) => ({ ...row, title })))
          }
          onIconChange={(rowId, icon) =>
            setRows((currentRows) =>
              updateRow(currentRows, rowId, (row) => applyIconToRow(row, icon)),
            )
          }
          onApplyIconDownwards={(rowId) =>
            setRows((currentRows) => {
              const rowIndex = currentRows.findIndex((row) => row.id === rowId);
              if (rowIndex < 0) return currentRows;
              const icon = currentRows[rowIndex].icon;
              return currentRows.map((row, index) => (index > rowIndex ? { ...row, icon } : row));
            })
          }
          onDeleteRow={(rowId) =>
            setRows((currentRows) => currentRows.filter((row) => row.id !== rowId))
          }
          onUploadImages={(rowId) => {
            setImageUploadRowId(rowId);
            if (imageInputRef.current) {
              imageInputRef.current.value = '';
              imageInputRef.current.click();
            }
          }}
          onPasteImage={(rowId) => void handlePasteImage(rowId)}
          onDeleteImage={(rowId, url) =>
            setRows((currentRows) =>
              updateRow(currentRows, rowId, (row) => ({
                ...row,
                imageUrls: row.imageUrls.filter((item) => item !== url),
              })),
            )
          }
        />
      ))}

      <Stack
        direction="row"
        flexWrap="wrap"
        spacing={1.5}
        useFlexGap
        sx={{ alignItems: 'center', pb: 4 }}
      >
        <Button
          variant="outlined"
          startIcon={<AddCircleOutlineIcon />}
          onClick={() =>
            setRows((currentRows) => [...currentRows, createEmptyRow(takeNextRowId())])
          }
        >
          ще
        </Button>
        <TextField
          value={downloadFileName}
          onChange={(event) => setDownloadFileName(event.target.value)}
          size="small"
          sx={{ width: { xs: '100%', sm: 260 } }}
        />
        <Button
          variant="contained"
          startIcon={
            downloadInProgress === 'kmz' ? (
              <CircularProgress size={16} color="inherit" />
            ) : (
              <CloudDownloadOutlinedIcon />
            )
          }
          disabled={downloadInProgress !== null}
          onClick={() => void handleDownload('kmz')}
        >
          скачати KMZ
        </Button>
        <Button
          variant="contained"
          startIcon={
            downloadInProgress === 'geojson' ? (
              <CircularProgress size={16} color="inherit" />
            ) : (
              <CloudDownloadOutlinedIcon />
            )
          }
          disabled={downloadInProgress !== null}
          onClick={() => void handleDownload('geojson')}
        >
          скачати GeoJSON
        </Button>
      </Stack>
    </Box>
  );
}
