import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';

import type { Unit } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { HttpRequestError } from '../../services/api/client';
import {
  DEFAULT_LIST_UNITS_REQ,
  searchUnitsByMatchTier,
  type UnitSearchMatches,
} from '../../services/api/units';

const UNIT_SEARCH_DEBOUNCE_MS = 300;

type UnitOption = {
  unit: Unit;
  strict: boolean;
};

type Props = {
  open: boolean;
  unitTxt: string;
  processing: boolean;
  onClose: () => void;
  onSubmit: (sigintUnitId: number) => void;
};

function formatError(error: unknown): string {
  if (error instanceof HttpRequestError && error.message.trim()) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Помилка запиту до сервера.';
}

function unitSegments(unit: Unit): string {
  return [
    unit.other,
    unit.teamOrCrew,
    unit.section,
    unit.squad,
    unit.platoon,
    unit.company,
    unit.battalion,
    unit.regiment,
    unit.brigade,
    unit.division,
    unit.corps,
    unit.army,
    unit.militaryDistrict,
    unit.armyRegion,
  ]
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(' ');
}

function unitTitle(unit: Unit): string {
  const segments = unitSegments(unit);
  return segments ? `${unit.name} — ${segments}` : unit.name;
}

function unitEchelon(unit: Unit): number {
  return [
    unit.other,
    unit.teamOrCrew,
    unit.section,
    unit.squad,
    unit.platoon,
    unit.company,
    unit.battalion,
    unit.regiment,
    unit.brigade,
    unit.division,
    unit.corps,
    unit.army,
    unit.militaryDistrict,
    unit.armyRegion,
  ].findIndex((segment) => segment.trim().length > 0);
}

function sortUnitsByDescendingEchelon(units: Unit[]): Unit[] {
  return [...units].sort((left, right) => unitEchelon(right) - unitEchelon(left));
}

function sortUnitMatches(matches: UnitSearchMatches): UnitOption[] {
  return [
    ...sortUnitsByDescendingEchelon(matches.strict).map((unit) => ({ unit, strict: true })),
    ...sortUnitsByDescendingEchelon(matches.relaxed).map((unit) => ({ unit, strict: false })),
  ];
}

function UnitCandidateButton({
  unit,
  strict,
  selected,
  disabled,
  onClick,
}: {
  unit: Unit;
  strict: boolean;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant={selected ? 'contained' : 'outlined'}
      color={unit.active ? 'primary' : 'warning'}
      disabled={disabled}
      onClick={onClick}
      sx={{ justifyContent: 'flex-start', textAlign: 'left', py: 1 }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="flex-start"
        sx={{ minWidth: 0, width: '100%' }}
      >
        {strict ? (
          <Box component="span" aria-label="Точний збіг" sx={{ lineHeight: 1.5 }}>
            ⭐
          </Box>
        ) : null}
        <Stack spacing={0.5} sx={{ minWidth: 0, width: '100%' }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
              {unit.name || `#${unit.id}`}
            </Typography>
            <Chip
              size="small"
              label={unit.active ? 'Активний' : 'Неактивний'}
              color={unit.active ? 'success' : 'warning'}
              variant={selected ? 'filled' : 'outlined'}
            />
          </Stack>
          {unitSegments(unit) ? (
            <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {unitSegments(unit)}
            </Typography>
          ) : null}
        </Stack>
      </Stack>
    </Button>
  );
}

export function UnresolvedUnitLinkDialog({ open, unitTxt, processing, onClose, onSubmit }: Props) {
  const [selectedUnit, setSelectedUnit] = useState<Unit | null>(null);
  const [unitSearch, setUnitSearch] = useState('');
  const [unitOptions, setUnitOptions] = useState<UnitOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedUnit(null);
    setUnitSearch(unitTxt);
    setUnitOptions([]);
    setError(null);
  }, [open, unitTxt]);

  useEffect(() => {
    if (!open) {
      setUnitOptions([]);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const search = unitSearch.trim() || unitTxt;
    setLoading(true);
    setError(null);
    setUnitOptions([]);
    const timeout = window.setTimeout(() => {
      void searchUnitsByMatchTier(
        {
          ...DEFAULT_LIST_UNITS_REQ,
          sortBy: 'UnitNameLengthAsc',
          includeInactive: true,
          filterText: search,
          limit: 50,
          offset: 0,
        },
        { signal: controller.signal },
      )
        .then((matches) => {
          if (!controller.signal.aborted) setUnitOptions(sortUnitMatches(matches));
        })
        .catch((requestError) => {
          if (!controller.signal.aborted) setError(formatError(requestError));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, UNIT_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [open, unitSearch, unitTxt]);

  return (
    <Dialog open={open} fullWidth maxWidth="md" onClose={processing ? undefined : onClose}>
      <DialogTitle>Прив'язати до підрозділу {unitTxt}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {unitOptions.length > 0 ? (
            <Stack spacing={1}>
              <Typography variant="subtitle2">Топ кандидатів</Typography>
              {unitOptions.slice(0, 3).map(({ unit, strict }) => (
                <UnitCandidateButton
                  key={unit.id}
                  unit={unit}
                  strict={strict}
                  selected={selectedUnit?.id === unit.id}
                  disabled={processing}
                  onClick={() => setSelectedUnit(unit)}
                />
              ))}
            </Stack>
          ) : null}
          <TextField
            fullWidth
            label="Пошук підрозділу SIGINT"
            value={unitSearch}
            disabled={processing}
            helperText="Пошук включає неактивні підрозділи. Неактивний підрозділ буде активовано після збереження синоніму."
            onChange={(event) => setUnitSearch(event.target.value)}
          />
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
          <Stack spacing={1}>
            {loading ? (
              <Stack direction="row" alignItems="center" spacing={1}>
                <CircularProgress size={18} />
                <Typography variant="body2" color="text.secondary">
                  Пошук підрозділів…
                </Typography>
              </Stack>
            ) : null}
            {!loading && unitOptions.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                Підрозділів не знайдено.
              </Typography>
            ) : null}
            {unitOptions.slice(3).map(({ unit, strict }) => (
              <UnitCandidateButton
                key={unit.id}
                unit={unit}
                strict={strict}
                selected={selectedUnit?.id === unit.id}
                disabled={processing}
                onClick={() => setSelectedUnit(unit)}
              />
            ))}
          </Stack>
          <Typography variant="body2">
            {selectedUnit ? `Обрано: ${unitTitle(selectedUnit)}` : 'Підрозділ SIGINT не обрано.'}
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={processing}>
          Скасувати
        </Button>
        <Button
          variant="contained"
          disabled={processing || selectedUnit === null}
          onClick={() => {
            if (selectedUnit !== null) onSubmit(selectedUnit.id);
          }}
        >
          {processing ? 'Збереження…' : "Прив'язати"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
