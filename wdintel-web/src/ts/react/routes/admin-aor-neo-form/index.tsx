import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import {
  Box,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Checkbox as MuiCheckbox,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import {
  AorCoordinates,
  AreaOfResponsibility,
  AreaOfResponsibilityInsert,
  DeleteAreaOfResponsibilityReq,
  UpdateAreaOfResponsibilityReq,
} from '../../../../Bindings';
import { FormPageHeader } from '../../components/FormPageHeader';
import { FormPageLayout } from '../../components/FormPageLayout';
import { PageErrorState } from '../../components/PageErrorState';
import { Info } from '../../components/info';
import { PageLoadingState } from '../../components/PageLoadingState';
import { PowerButton } from '../../components/PowerButton';
import { createAor, deleteAor, listAors, updateAor } from '../../services/api/aor';
import { navigateWithinSpa } from '../../utils/browser';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

type StatusMessage = { kind: 'error' | 'success'; message: string } | null;

type AorFormState = {
  name: string;
  description: string;
  leftBound: string;
  rightBound: string;
  leftLatitude: string;
  leftLongitude: string;
  leftSettlement: string;
  rightLatitude: string;
  rightLongitude: string;
  rightSettlement: string;
  isTopLevel: boolean;
};

const emptyForm: AorFormState = {
  name: '',
  description: '',
  leftBound: '',
  rightBound: '',
  leftLatitude: '',
  leftLongitude: '',
  leftSettlement: '',
  rightLatitude: '',
  rightLongitude: '',
  rightSettlement: '',
  isTopLevel: false,
};

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

function parseNumberValue(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildCoordinates(
  latitude: string,
  longitude: string,
  settlement: string,
): AorCoordinates | null {
  if (!latitude.trim() || !longitude.trim()) return null;

  const trimmedSettlement = settlement.trim();

  return {
    latitude: parseNumberValue(latitude),
    longitude: parseNumberValue(longitude),
    settlement: trimmedSettlement ? trimmedSettlement : null,
  };
}

function buildInsertRequest(form: AorFormState): AreaOfResponsibilityInsert {
  const trimmedDescription = form.description.trim();

  return {
    name: form.name.trim(),
    description: trimmedDescription ? trimmedDescription : null,
    leftBound: parseNumberValue(form.leftBound),
    rightBound: parseNumberValue(form.rightBound),
    leftCoordinates: buildCoordinates(form.leftLatitude, form.leftLongitude, form.leftSettlement),
    rightCoordinates: buildCoordinates(
      form.rightLatitude,
      form.rightLongitude,
      form.rightSettlement,
    ),
    isTopLevel: form.isTopLevel,
  };
}

function aorToForm(aor: AreaOfResponsibility): AorFormState {
  return {
    name: aor.name,
    description: aor.description ?? '',
    leftBound: String(aor.leftBound),
    rightBound: String(aor.rightBound),
    leftLatitude: aor.leftCoordinates ? String(aor.leftCoordinates.latitude) : '',
    leftLongitude: aor.leftCoordinates ? String(aor.leftCoordinates.longitude) : '',
    leftSettlement: aor.leftCoordinates?.settlement ?? '',
    rightLatitude: aor.rightCoordinates ? String(aor.rightCoordinates.latitude) : '',
    rightLongitude: aor.rightCoordinates ? String(aor.rightCoordinates.longitude) : '',
    rightSettlement: aor.rightCoordinates?.settlement ?? '',
    isTopLevel: aor.isTopLevel,
  };
}

function getBackToPath(): string {
  const params = new URLSearchParams(window.location.search);
  const backTo = params.get('backTo');
  if (!backTo) return '/admin/aor-neo';

  try {
    return decodeURIComponent(backTo);
  } catch (_) {
    return '/admin/aor-neo';
  }
}

function AorFormFields(props: { form: AorFormState; onChange: (next: AorFormState) => void }) {
  const update = (patch: Partial<AorFormState>) => props.onChange({ ...props.form, ...patch });

  return (
    <div className="space-y-8">
      <div>
        <TextField
          label="Назва *"
          value={props.form.name}
          onChange={(event) => update({ name: event.target.value })}
          fullWidth
        />
        <TextField
          className="mt-4"
          label="Опис"
          value={props.form.description}
          onChange={(event) => update({ description: event.target.value })}
          fullWidth
        />
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <TextField
            label="Ліва межа *"
            value={props.form.leftBound}
            onChange={(event) => update({ leftBound: event.target.value })}
            fullWidth
            type="number"
            slotProps={{ htmlInput: { step: 0.1 } }}
          />
          <TextField
            label="Права межа *"
            value={props.form.rightBound}
            onChange={(event) => update({ rightBound: event.target.value })}
            fullWidth
            type="number"
            slotProps={{ htmlInput: { step: 0.1 } }}
          />
        </div>
      </div>
      <div className="space-y-5 pt-2">
        <Typography variant="subtitle1" className="!font-medium">
          Координати лівої межі
        </Typography>
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <TextField
            label="Широта"
            value={props.form.leftLatitude}
            onChange={(event) => update({ leftLatitude: event.target.value })}
            fullWidth
            type="number"
            slotProps={{ htmlInput: { step: 0.000001 } }}
          />
          <TextField
            label="Довгота"
            value={props.form.leftLongitude}
            onChange={(event) => update({ leftLongitude: event.target.value })}
            fullWidth
            type="number"
            slotProps={{ htmlInput: { step: 0.000001 } }}
          />
          <TextField
            label="Населений пункт"
            value={props.form.leftSettlement}
            onChange={(event) => update({ leftSettlement: event.target.value })}
            fullWidth
          />
        </div>
      </div>
      <div className="space-y-5 pt-2">
        <Typography variant="subtitle1" className="!font-medium">
          Координати правої межі
        </Typography>
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <TextField
            label="Широта"
            value={props.form.rightLatitude}
            onChange={(event) => update({ rightLatitude: event.target.value })}
            fullWidth
            type="number"
            slotProps={{ htmlInput: { step: 0.000001 } }}
          />
          <TextField
            label="Довгота"
            value={props.form.rightLongitude}
            onChange={(event) => update({ rightLongitude: event.target.value })}
            fullWidth
            type="number"
            slotProps={{ htmlInput: { step: 0.000001 } }}
          />
          <TextField
            label="Населений пункт"
            value={props.form.rightSettlement}
            onChange={(event) => update({ rightSettlement: event.target.value })}
            fullWidth
          />
        </div>
      </div>
      <div className="pt-2">
        <FormControlLabel
          control={
            <MuiCheckbox
              checked={props.form.isTopLevel}
              onChange={(event) => update({ isTopLevel: event.target.checked })}
            />
          }
          label="Топ-рівень"
        />
      </div>
    </div>
  );
}

function LoadingState() {
  return <PageLoadingState />;
}

function ErrorState(props: { message: string; onBack: () => void }) {
  return <PageErrorState message={props.message} actionLabel="Назад" onAction={props.onBack} />;
}

function FormActions(props: {
  isNew: boolean;
  isMutating: boolean;
  onDelete: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flex flex-wrap justify-between gap-3">
      {!props.isNew ? (
        <PowerButton
          variant="outlined"
          color="error"
          startIcon={<DeleteOutlineIcon />}
          onClick={props.onDelete}
          disabled={props.isMutating}
        >
          Видалити смугу
        </PowerButton>
      ) : (
        <div />
      )}
      <div className="flex gap-3">
        <PowerButton onClick={props.onCancel} disabled={props.isMutating}>
          Скасувати
        </PowerButton>
        <PowerButton variant="contained" onClick={props.onSubmit} disabled={props.isMutating}>
          {props.isNew ? 'Створити' : 'Зберегти'}
        </PowerButton>
      </div>
    </div>
  );
}

function DeleteDialog(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  disabled: boolean;
}) {
  return (
    <Dialog open={props.open} onClose={props.onClose}>
      <DialogTitle>Підтвердження видалення</DialogTitle>
      <DialogContent>
        <Typography className="text-sm text-muted-foreground">
          Ви впевнені, що хочете видалити цю смугу?
        </Typography>
      </DialogContent>
      <DialogActions>
        <PowerButton onClick={props.onClose}>Скасувати</PowerButton>
        <PowerButton
          variant="contained"
          color="error"
          onClick={props.onConfirm}
          disabled={props.disabled}
        >
          Видалити
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}

type AdminAorNeoFormPageProps = {
  aorId: string | null;
};

function AdminAorNeoFormPageBody(props: AdminAorNeoFormPageProps) {
  const isNew = props.aorId === 'new' || !props.aorId;
  const [loadStatus, setLoadStatus] = useState<LoadingStatus>(isNew ? 'success' : 'idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<AorFormState>(emptyForm);
  const [editId, setEditId] = useState<number | null>(null);
  const [actionStatus, setActionStatus] = useState<StatusMessage>(null);
  const [isMutating, setIsMutating] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const backToPath = useMemo(getBackToPath, []);

  async function loadAor(id: number) {
    setLoadStatus('loading');
    setLoadError(null);
    try {
      const list = await listAors({ sortBy: null });
      const found = list.find((item) => item.id === id);
      if (!found) {
        setLoadStatus('error');
        setLoadError('Смугу не знайдено');
        return;
      }
      setForm(aorToForm(found));
      setEditId(found.id);
      setLoadStatus('success');
    } catch (error) {
      setLoadStatus('error');
      setLoadError(formatErrorMessage(error));
    }
  }

  useEffect(() => {
    if (isNew) {
      setLoadStatus('success');
      setLoadError(null);
      setForm(emptyForm);
      setEditId(null);
      return;
    }

    const parsedId = Number(props.aorId);
    if (!Number.isFinite(parsedId)) {
      setLoadStatus('error');
      setLoadError('Некоректний id');
      return;
    }

    loadAor(parsedId);
  }, [props.aorId]);

  function navigateBack() {
    navigateWithinSpa(backToPath);
  }

  async function handleSubmit() {
    setIsMutating(true);
    setActionStatus(null);
    try {
      if (isNew) {
        await createAor(buildInsertRequest(form));
      } else if (editId !== null) {
        const request: UpdateAreaOfResponsibilityReq = {
          id: editId,
          insert: buildInsertRequest(form),
        };
        await updateAor(request);
      }
      navigateBack();
    } catch (error) {
      setActionStatus({
        kind: 'error',
        message: isNew
          ? `Помилка створення смуги: ${formatErrorMessage(error)}`
          : `Помилка оновлення смуги: ${formatErrorMessage(error)}`,
      });
    } finally {
      setIsMutating(false);
    }
  }

  async function handleDeleteConfirm() {
    if (editId === null) return;

    const request: DeleteAreaOfResponsibilityReq = { id: editId };

    setIsMutating(true);
    setActionStatus(null);
    try {
      await deleteAor(request);
      navigateBack();
    } catch (error) {
      setActionStatus({
        kind: 'error',
        message: `Помилка видалення смуги: ${formatErrorMessage(error)}`,
      });
    } finally {
      setIsMutating(false);
    }
  }

  if (loadStatus === 'loading') return <LoadingState />;

  if (loadStatus === 'error')
    return <ErrorState message={loadError || 'Помилка завантаження'} onBack={navigateBack} />;

  return (
    <FormPageLayout>
      <Box className="space-y-6">
        <FormPageHeader
          title={isNew ? 'Створити смугу' : 'Редагувати смугу'}
          subtitle={
            isNew
              ? 'Додайте нову смугу відповідальності'
              : 'Оновіть параметри смуги відповідальності'
          }
          onBack={navigateBack}
        />

        <Box className="space-y-6">
          <AorFormFields form={form} onChange={setForm} />
          <FormActions
            isNew={isNew}
            isMutating={isMutating}
            onDelete={() => setDeleteDialogOpen(true)}
            onCancel={navigateBack}
            onSubmit={handleSubmit}
          />
        </Box>

        {actionStatus?.kind === 'error' ? (
          <Info text={actionStatus.message} color="error" className="mt-4" />
        ) : null}
      </Box>
      <DeleteDialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        onConfirm={handleDeleteConfirm}
        disabled={isMutating}
      />
    </FormPageLayout>
  );
}

export function AdminAorNeoFormPage(props: AdminAorNeoFormPageProps) {
  return <AdminAorNeoFormPageBody aorId={props.aorId} />;
}
