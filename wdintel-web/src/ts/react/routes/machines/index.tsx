import type { Network, Unit, UnitMachineItem } from '../../../../Bindings';
import { Add, Archive, Edit, Refresh, Restore } from '@mui/icons-material';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { HttpRequestError } from '../../services/api/client';
import { getNetworksList } from '../../services/api/networks';
import { getUnitsList } from '../../services/api/units';
import {
  archiveUnitMachine,
  createUnitMachine,
  listUnitMachines,
  restoreUnitMachine,
  updateUnitMachine,
} from '../../services/api/unit-machines';

type MachineForm = {
  id: number | null;
  sigintNetworkId: number | '';
  machineId: string;
  machineTags: string[];
};

function emptyForm(): MachineForm {
  return { id: null, sigintNetworkId: '', machineId: '', machineTags: [] };
}

function formatApiError(error: unknown): string {
  if (error instanceof HttpRequestError && error.status === 400 && error.message.includes('465986')) {
    return 'Машина з таким ID вже активна.';
  }
  if (error instanceof Error) return error.message;
  return 'Помилка запиту';
}

function normalizeMachineTags(machineTags: string[]): string[] {
  return machineTags.map((tag) => tag.trim()).filter(Boolean);
}

function machineIdentityValidationMessage(machineId: string, machineTags: string[]): string | null {
  if (machineId.trim() || normalizeMachineTags(machineTags).length > 0) return null;
  return 'Вкажіть ID машини або хоча б один тег машини.';
}

function canEdit(authUserRoles: string[]): boolean {
  return authUserRoles.includes('Admin') || authUserRoles.includes('NetworkEditor');
}

function networkOptionLabel(network: Network, unitsById: Map<number, Unit>): string {
  const unitNames = (network.unitIds ?? [])
    .map((unitId) => unitsById.get(unitId)?.name?.trim() || `#${unitId}`)
    .filter(Boolean);
  if (unitNames.length === 0) return network.name;
  return `${network.name} - ${unitNames.join(', ')}`;
}

export function MachinesPage({ authUserRoles = [] }: { authUserRoles?: string[] }) {
  const [items, setItems] = useState<UnitMachineItem[]>([]);
  const [networks, setNetworks] = useState<Network[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<MachineForm>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const editable = canEdit(authUserRoles);
  const identityValidationMessage = dialogOpen ? machineIdentityValidationMessage(form.machineId, form.machineTags) : null;

  const load = useCallback(async () => {
    if (!editable) return;
    setLoading(true);
    try {
      const [nextItems, nextNetworks, nextUnits] = await Promise.all([
        listUnitMachines({ includeArchived, sigintNetworkId: null, query: query.trim() || null }),
        getNetworksList(),
        getUnitsList(),
      ]);
      setItems(nextItems);
      setNetworks(nextNetworks);
      setUnits(nextUnits);
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setLoading(false);
    }
  }, [editable, includeArchived, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const networkOptions = useMemo(() => {
    const unitsById = new Map(units.map((unit) => [unit.id, unit]));
    return networks.map((network) => ({
      id: network.id,
      label: networkOptionLabel(network, unitsById),
    }));
  }, [networks, units]);

  const openCreate = () => {
    setForm(emptyForm());
    setDialogOpen(true);
  };

  const openEdit = (item: UnitMachineItem) => {
    setForm({
      id: item.id,
      sigintNetworkId: item.sigintNetworkId,
      machineId: item.machineId ?? '',
      machineTags: item.machineTags,
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (form.sigintNetworkId === '') {
      setError('Оберіть мережу.');
      return;
    }
    try {
      const machineId = form.machineId.trim() || null;
      const machineTags = normalizeMachineTags(form.machineTags);
      if (!machineId && machineTags.length === 0) {
        setError('Вкажіть ID машини або хоча б один тег машини.');
        return;
      }
      const payload = {
        sigintNetworkId: form.sigintNetworkId,
        machineId,
        machineTags,
      };
      const rsp =
        form.id === null
          ? await createUnitMachine(payload)
          : await updateUnitMachine({ id: form.id, ...payload });
      if (rsp.warning) setWarning(rsp.warning.message);
      setDialogOpen(false);
      await load();
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  const toggleArchive = async (item: UnitMachineItem) => {
    try {
      if (item.deleted) {
        await restoreUnitMachine({ id: item.id });
      } else {
        await archiveUnitMachine({ id: item.id });
      }
      await load();
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  if (!editable) {
    return <Alert severity="warning">Сторінка недоступна</Alert>;
  }

  return (
    <Stack spacing={2} sx={{ minHeight: 0, height: '100%' }}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', md: 'center' }}>
        <Typography variant="h5" sx={{ flex: 1 }}>
          Машини
        </Typography>
        <TextField size="small" label="Пошук" value={query} onChange={(event) => setQuery(event.target.value)} />
        <FormControlLabel
          control={<Checkbox checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />}
          label="Архівні"
        />
        <Tooltip title="Оновити">
          <IconButton onClick={() => void load()} disabled={loading}>
            <Refresh />
          </IconButton>
        </Tooltip>
        <Button variant="contained" startIcon={<Add />} onClick={openCreate}>
          Створити
        </Button>
      </Stack>

      <TableContainer component={Paper} sx={{ minHeight: 0, flex: 1 }}>
        <Table stickyHeader size="small">
          <TableHead>
            <TableRow>
              <TableCell>ID машини</TableCell>
              <TableCell>Теги машини</TableCell>
              <TableCell>Мережа</TableCell>
              <TableCell>Стан</TableCell>
              <TableCell align="right">Дії</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id} hover sx={{ opacity: item.deleted ? 0.55 : 1 }}>
                <TableCell>
                  <Box component="span" sx={{ color: item.machineId ? 'text.primary' : 'text.disabled' }}>
                    {item.machineId || 'НВ'}
                  </Box>
                </TableCell>
                <TableCell>
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    {item.machineTags.map((tag) => (
                      <Chip key={tag} label={tag} size="small" />
                    ))}
                  </Stack>
                </TableCell>
                <TableCell>{item.networkDisplayName}</TableCell>
                <TableCell>{item.deleted ? <Chip label="Архів" size="small" /> : <Chip label="Активна" size="small" color="success" />}</TableCell>
                <TableCell align="right">
                  <Tooltip title="Редагувати">
                    <IconButton onClick={() => openEdit(item)}>
                      <Edit />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={item.deleted ? 'Відновити' : 'Архівувати'}>
                    <IconButton onClick={() => void toggleArchive(item)}>
                      {item.deleted ? <Restore /> : <Archive />}
                    </IconButton>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{form.id === null ? 'Нова машина' : 'Редагування машини'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              select
              label="Мережа"
              value={form.sigintNetworkId}
              onChange={(event) => setForm((prev) => ({ ...prev, sigintNetworkId: Number(event.target.value) }))}
              fullWidth
            >
              {networkOptions.map((network) => (
                <MenuItem key={network.id} value={network.id}>
                  {network.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="ID машини"
              value={form.machineId}
              onChange={(event) => setForm((prev) => ({ ...prev, machineId: event.target.value }))}
              error={Boolean(identityValidationMessage)}
              fullWidth
            />
            <Autocomplete
              multiple
              freeSolo
              options={[]}
              value={form.machineTags}
              onChange={(_, value) => setForm((prev) => ({ ...prev, machineTags: value }))}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Теги машини"
                  error={Boolean(identityValidationMessage)}
                  helperText={identityValidationMessage ?? undefined}
                />
              )}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Скасувати</Button>
          <Button variant="contained" onClick={() => void save()} disabled={Boolean(identityValidationMessage)}>
            Зберегти
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={Boolean(error)} autoHideDuration={6000} onClose={() => setError(null)}>
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      </Snackbar>
      <Snackbar open={Boolean(warning)} autoHideDuration={6000} onClose={() => setWarning(null)}>
        <Alert severity="warning" onClose={() => setWarning(null)}>
          {warning}
        </Alert>
      </Snackbar>
    </Stack>
  );
}
