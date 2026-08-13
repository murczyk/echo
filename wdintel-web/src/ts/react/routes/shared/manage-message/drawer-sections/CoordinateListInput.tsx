import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import {
  Box,
  Chip,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useMemo, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';

import { getCoordinateText } from '../../../../../maps/coordinate-format';
import {
  isCoordinateBlockFullyParsed,
  parseCoordinateBlock,
  type CoordinateInputFormat,
  type ParsedCoordinate,
} from '../../../../../maps/coordinate-parser';

const FORMAT_LABELS: Record<CoordinateInputFormat, string> = {
  wgs84: 'WGS-84',
  dms: 'DMS',
  mgrs: 'MGRS',
  utm: 'UTM',
  sk42: 'СК-42',
  usk2000: 'УСК-2000',
};

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

function serializeCoordinates(points: ParsedCoordinate[]): string {
  return points.map((point) => getCoordinateText('wgs', point)).join('\n');
}

export function duplicateCoordinateHint(currentValue: string, input: string): string | null {
  const currentKeys = new Set(parseCoordinateBlock(currentValue).map(coordinateDuplicateKey));
  const parsed = parseCoordinateBlock(input);
  const duplicateCount = parsed.filter((point) =>
    currentKeys.has(coordinateDuplicateKey(point)),
  ).length;
  if (duplicateCount === 0) return null;
  if (duplicateCount < parsed.length) {
    return 'Деякі координати вже є у списку та не будуть додані';
  }
  return parsed.length === 1 ? 'Координата вже є у списку' : 'Координати вже є у списку';
}

export function matchingCoordinateKeys(currentValue: string, input: string): Set<string> {
  const inputKeys = new Set(parseCoordinateBlock(input).map(coordinateDuplicateKey));

  return new Set(
    parseCoordinateBlock(currentValue)
      .map(coordinateDuplicateKey)
      .filter((key) => inputKeys.has(key)),
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
  const current = parseCoordinateBlock(currentValue);
  const parsed = parseCoordinateBlock(input);
  const fullyParsed = isCoordinateBlockFullyParsed(input);
  if (!fullyParsed) {
    return {
      value: currentValue,
      added: 0,
      parsed: parsed.length,
      fullyParsed,
    };
  }
  const keys = new Set(current.map(coordinateDuplicateKey));
  const added = parsed.filter((point) => {
    const key = coordinateDuplicateKey(point);
    if (keys.has(key)) return false;
    keys.add(key);
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
    parseCoordinateBlock(value).filter((_, pointIndex) => pointIndex !== index),
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
  const points = useMemo(() => parseCoordinateBlock(value), [value]);
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

                return (
                  <Box
                    key={coordinateKey(point)}
                    data-coordinate-duplicate={isMatching ? 'true' : undefined}
                    sx={(theme) => ({
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1,
                      minWidth: 0,
                      px: 1,
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
                    {point.format !== 'wgs84' ? (
                      <Chip
                        label={FORMAT_LABELS[point.format]}
                        size="small"
                        variant="outlined"
                        sx={{ flexShrink: 0, height: 24 }}
                      />
                    ) : null}
                    <Typography
                      variant="body2"
                      noWrap
                      title={getCoordinateText('wgs', point)}
                      sx={{ flex: 1, minWidth: 0, fontVariantNumeric: 'tabular-nums' }}
                    >
                      {getCoordinateText('wgs', point)}
                    </Typography>
                    <IconButton
                      size="small"
                      aria-label={`Видалити координату ${index + 1}`}
                      onClick={() => {
                        onChange(removeCoordinateAt(value, index));
                        onBlur();
                      }}
                      disabled={disabled}
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
