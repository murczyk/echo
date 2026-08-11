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
import { useMemo, useState, type ClipboardEvent, type KeyboardEvent } from 'react';

import { getCoordinateText } from '../../../../../maps/coordinate-format';
import {
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
};

function coordinateKey(point: ParsedCoordinate): string {
  return `${point.lat.toFixed(7)}:${point.lng.toFixed(7)}`;
}

function serializeCoordinates(points: ParsedCoordinate[]): string {
  return points.map((point) => getCoordinateText('wgs', point)).join('\n');
}

export function mergeCoordinateInput(
  currentValue: string,
  input: string,
): {
  value: string;
  added: number;
  parsed: number;
} {
  const current = parseCoordinateBlock(currentValue);
  const parsed = parseCoordinateBlock(input);
  const keys = new Set(current.map(coordinateKey));
  const added = parsed.filter((point) => {
    const key = coordinateKey(point);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });

  return {
    value: serializeCoordinates([...current, ...added]),
    added: added.length,
    parsed: parsed.length,
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
}: Props) {
  const points = useMemo(() => parseCoordinateBlock(value), [value]);
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  const addCoordinates = (candidate: string) => {
    if (!candidate.trim()) return false;
    const result = mergeCoordinateInput(value, candidate);
    onBlur();
    if (result.parsed === 0) {
      setInputError('Не вдалося розпізнати координату');
      onErrorChange('Не вдалося розпізнати координату');
      return false;
    }
    if (result.added === 0) {
      setInputError('Координата вже додана');
      onErrorChange('Координата вже додана');
      return false;
    }

    onChange(result.value);
    onErrorChange(null);
    setInput('');
    setInputError(null);
    return true;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    addCoordinates(input);
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text');
    if (parseCoordinateBlock(pasted).length === 0) return;
    event.preventDefault();
    addCoordinates(pasted);
  };

  const shownError = inputError ?? error;

  return (
    <Stack spacing={1}>
      <TextField
        value={input}
        onChange={(event) => {
          setInput(event.target.value);
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
        disabled={disabled}
        error={!!shownError}
        helperText={shownError ?? 'Enter — додати; можна вставити одразу декілька координат'}
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

      {points.length > 0 ? (
        <Stack spacing={0.5}>
          {points.map((point, index) => (
            <Box
              key={coordinateKey(point)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                minWidth: 0,
                px: 1,
                py: 0.5,
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
              }}
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
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}
