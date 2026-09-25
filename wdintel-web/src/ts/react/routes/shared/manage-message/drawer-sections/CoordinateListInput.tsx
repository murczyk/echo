import AddIcon from '@mui/icons-material/Add';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import {
  Box,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { copyTextToClipboard } from '../../../../../copy-to-clipboard';
import { getCoordinateMgrsText, getCoordinateText } from '../../../../../maps/coordinate-format';
import {
  isCoordinateBlockFullyParsed,
  parseCoordinateBlock,
  type ParsedCoordinate,
} from '../../../../../maps/coordinate-parser';
import { COORDINATE_PANEL_MAX_HEIGHT_PX } from './coordinate-input.constants';

const COPY_FEEDBACK_MS = 1200;

type CopyStatus = 'idle' | 'copying' | 'copied' | 'error';

type Props = {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  onErrorChange: (message: string | null) => void;
  disabled: boolean;
  error?: string;
  previewSlot?: ReactNode;
};

function coordinateKey(point: ParsedCoordinate): string {
  return `${point.lat.toFixed(7)}:${point.lng.toFixed(7)}`;
}

function coordinateDuplicateKey(point: ParsedCoordinate): string {
  return getCoordinateText('wgs', point);
}

function coordinateIdentityKeys(point: ParsedCoordinate): string[] {
  const wgs = coordinateDuplicateKey(point);
  const mgrs = getCoordinateMgrsText(point);
  return mgrs ? [wgs, mgrs] : [wgs];
}

function parseUniqueCoordinates(value: string): ParsedCoordinate[] {
  const keys = new Set<string>();
  return parseCoordinateBlock(value).filter((point) => {
    const pointKeys = coordinateIdentityKeys(point);
    if (pointKeys.some((key) => keys.has(key))) return false;
    pointKeys.forEach((key) => keys.add(key));
    return true;
  });
}

function serializeCoordinates(points: ParsedCoordinate[]): string {
  return points.map((point) => getCoordinateText('wgs', point)).join('\n');
}

function CoordinateCopyButton({
  value,
  index,
  disabled,
}: {
  value: string | null;
  index: number;
  disabled: boolean;
}) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const resetTimeoutRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimeoutRef.current != null) window.clearTimeout(resetTimeoutRef.current);
    },
    [],
  );

  const scheduleReset = () => {
    if (resetTimeoutRef.current != null) window.clearTimeout(resetTimeoutRef.current);
    resetTimeoutRef.current = window.setTimeout(() => setStatus('idle'), COPY_FEEDBACK_MS);
  };

  const handleCopy = () => {
    if (!value) return;
    setStatus('copying');
    void copyTextToClipboard(value)
      .then(() => {
        setStatus('copied');
        scheduleReset();
      })
      .catch(() => {
        setStatus('error');
        scheduleReset();
      });
  };

  const title =
    status === 'copied'
      ? 'Скопійовано'
      : status === 'error'
        ? 'Не вдалося скопіювати'
        : 'Копіювати MGRS';

  return (
    <>
      <IconButton
        size="small"
        title={title}
        aria-label={`Копіювати координату ${index + 1}`}
        onClick={handleCopy}
        disabled={disabled || !value || status === 'copying'}
        sx={{ p: 0.5 }}
      >
        {status === 'copied' ? (
          <CheckIcon fontSize="small" />
        ) : status === 'error' ? (
          <ErrorOutlineIcon fontSize="small" />
        ) : (
          <ContentCopyIcon
            fontSize="small"
            sx={{ transform: 'scale(0.82)', transformOrigin: 'center' }}
          />
        )}
      </IconButton>
      {status === 'copied' || status === 'error' ? (
        <Box
          component="span"
          role="status"
          aria-live="polite"
          sx={{
            position: 'absolute',
            width: 1,
            height: 1,
            p: 0,
            m: -1,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
            whiteSpace: 'nowrap',
            border: 0,
          }}
        >
          {status === 'copied' ? 'Скопійовано' : 'Не вдалося скопіювати'}
        </Box>
      ) : null}
    </>
  );
}

export function duplicateCoordinateHint(currentValue: string, input: string): string | null {
  const currentKeys = new Set(parseUniqueCoordinates(currentValue).flatMap(coordinateIdentityKeys));
  const parsed = parseUniqueCoordinates(input);
  const duplicateCount = parsed.filter((point) =>
    coordinateIdentityKeys(point).some((key) => currentKeys.has(key)),
  ).length;
  if (duplicateCount === 0) return null;
  if (duplicateCount < parsed.length) {
    return 'Деякі координати вже є у списку та не будуть додані';
  }
  return parsed.length === 1 ? 'Координата вже є у списку' : 'Координати вже є у списку';
}

export function matchingCoordinateKeys(currentValue: string, input: string): Set<string> {
  const inputKeys = new Set(parseUniqueCoordinates(input).flatMap(coordinateIdentityKeys));

  return new Set(
    parseUniqueCoordinates(currentValue)
      .filter((point) => coordinateIdentityKeys(point).some((key) => inputKeys.has(key)))
      .map(coordinateDuplicateKey),
  );
}

export function mergeCoordinateInput(
  currentValue: string,
  input: string,
): {
  value: string;
  added: number;
  parsed: number;
  fullyParsed: boolean;
} {
  const current = parseUniqueCoordinates(currentValue);
  const parsed = parseUniqueCoordinates(input);
  const fullyParsed = isCoordinateBlockFullyParsed(input);
  if (!fullyParsed) {
    return {
      value: currentValue,
      added: 0,
      parsed: parsed.length,
      fullyParsed,
    };
  }
  const keys = new Set(current.flatMap(coordinateIdentityKeys));
  const added = parsed.filter((point) => {
    const pointKeys = coordinateIdentityKeys(point);
    if (pointKeys.some((key) => keys.has(key))) return false;
    pointKeys.forEach((key) => keys.add(key));
    return true;
  });

  return {
    value: serializeCoordinates([...current, ...added]),
    added: added.length,
    parsed: parsed.length,
    fullyParsed,
  };
}

export function removeCoordinateAt(value: string, index: number): string {
  return serializeCoordinates(
    parseUniqueCoordinates(value).filter((_, pointIndex) => pointIndex !== index),
  );
}

export function CoordinateListInput({
  value,
  onChange,
  onBlur,
  onErrorChange,
  disabled,
  error,
  previewSlot,
}: Props) {
  const points = useMemo(() => parseUniqueCoordinates(value), [value]);
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [inputHint, setInputHint] = useState<string | null>(null);
  const duplicateHint = useMemo(() => duplicateCoordinateHint(value, input), [input, value]);
  const matchingKeys = useMemo(() => matchingCoordinateKeys(value, input), [input, value]);

  const addCoordinates = (candidate: string) => {
    if (!candidate.trim()) return false;
    const result = mergeCoordinateInput(value, candidate);
    onBlur();
    if (!result.fullyParsed) {
      const message =
        result.parsed === 0
          ? 'Не вдалося розпізнати координату'
          : 'Не вдалося розпізнати всі координати';
      setInput(candidate);
      setInputHint(null);
      setInputError(message);
      onErrorChange(message);
      return false;
    }
    if (result.added === 0) {
      setInput(candidate);
      setInputError(null);
      setInputHint(null);
      onErrorChange(null);
      return false;
    }

    onChange(result.value);
    onErrorChange(null);
    setInput('');
    setInputError(null);
    setInputHint(
      result.added < result.parsed ? 'Деякі координати вже є у списку та не були додані' : null,
    );
    return true;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    addCoordinates(input);
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const pasted = event.clipboardData.getData('text');
    if (parseCoordinateBlock(pasted).length === 0) return;
    event.preventDefault();
    addCoordinates(pasted);
  };

  const shownError = inputError ?? error;
  const shownHint = duplicateHint ?? inputHint;

  return (
    <Stack spacing={1}>
      <TextField
        value={input}
        onChange={(event) => {
          setInput(event.target.value);
          setInputHint(null);
          if (inputError || error) {
            setInputError(null);
            onErrorChange(null);
          }
        }}
        onBlur={() => {
          if (!input.trim()) onBlur();
          else addCoordinates(input);
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        label="Додати координату"
        placeholder="WGS-84, MGRS, UTM, СК-42…"
        size="small"
        fullWidth
        multiline
        maxRows={4}
        disabled={disabled}
        error={!!shownError}
        helperText={
          shownError ?? shownHint ?? 'Enter — додати; можна вставити одразу декілька координат'
        }
        slotProps={{
          input: {
            endAdornment: (
              <InputAdornment position="end">
                <Tooltip title="Додати координату">
                  <span>
                    <IconButton
                      edge="end"
                      size="small"
                      aria-label="Додати координату"
                      onClick={() => addCoordinates(input)}
                      disabled={disabled || !input.trim()}
                    >
                      <AddIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </InputAdornment>
            ),
          },
        }}
      />

      <Box
        sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, alignItems: 'flex-start' }}
      >
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            width: '100%',
            aspectRatio: '1 / 1',
            maxHeight: COORDINATE_PANEL_MAX_HEIGHT_PX,
            borderRadius: 2,
            border: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
            p: points.length > 0 ? 0.75 : 1,
            overflowY: 'auto',
            display: points.length > 0 ? 'block' : 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxSizing: 'border-box',
          }}
        >
          {points.length > 0 ? (
            <Stack spacing={0.5}>
              {points.map((point, index) => {
                const isMatching = matchingKeys.has(coordinateDuplicateKey(point));
                const mgrsText = getCoordinateMgrsText(point);

                return (
                  <Box
                    key={coordinateKey(point)}
                    data-coordinate-duplicate={isMatching ? 'true' : undefined}
                    sx={(theme) => ({
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0,
                      minWidth: 0,
                      px: 0.5,
                      py: 0.5,
                      borderBottom: 1,
                      borderColor: 'divider',
                      borderRadius: 1,
                      bgcolor: isMatching ? alpha(theme.palette.info.main, 0.18) : 'transparent',
                      transition: theme.transitions.create('background-color', {
                        duration: theme.transitions.duration.shortest,
                      }),
                      '&:last-child': {
                        borderBottom: 'none',
                      },
                    })}
                  >
                    <Typography
                      variant="body2"
                      title={mgrsText ?? undefined}
                      sx={{
                        flex: 1,
                        minWidth: 0,
                        fontVariantNumeric: 'tabular-nums',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {mgrsText ?? 'MGRS недоступний'}
                    </Typography>
                    <CoordinateCopyButton value={mgrsText} index={index} disabled={disabled} />
                    <IconButton
                      size="small"
                      aria-label={`Видалити координату ${index + 1}`}
                      onClick={() => {
                        onChange(removeCoordinateAt(value, index));
                        onBlur();
                      }}
                      disabled={disabled}
                      sx={{ p: 0.5 }}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Box>
                );
              })}
            </Stack>
          ) : (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontSize: 11, textAlign: 'center' }}
            >
              Координати ще не додані
            </Typography>
          )}
        </Box>

        {previewSlot}
      </Box>
    </Stack>
  );
}
