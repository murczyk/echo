import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
} from '@mui/material';
import { useState } from 'react';

import { PowerAlert } from '../../components/PowerAlert';
import { createDeviceNetwork } from '../../services/api/units';
import { AutoNetworkFields } from '../rer-units-neo/components/AutoNetworkFields';
import { formatUnitError, uniqueTrimmed } from '../rer-units-neo/helpers';

type Props = {
  unitId: number;
  unitName: string;
  defaultUnitMask: string[];
  onClose: () => void;
  onCreated: () => void;
};

export function CreateDeviceNetworkDialog({
  unitId,
  unitName,
  defaultUnitMask,
  onClose,
  onCreated,
}: Props) {
  const [locations, setLocations] = useState<string[]>([]);
  const [unitMask, setUnitMask] = useState<string[]>(defaultUnitMask);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await createDeviceNetwork({
        unitId,
        locations: uniqueTrimmed(locations),
        unitMask: uniqueTrimmed(unitMask),
      });
      onCreated();
    } catch (requestError) {
      setError(formatUnitError(requestError));
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onClose={submitting ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Налаштування радіомережі</DialogTitle>
      <DialogContent>
        <Stack spacing={3} sx={{ pt: 1 }}>
          <AutoNetworkFields
            unitName={unitName}
            skipNetworkCreation={false}
            allowSkip={false}
            locations={locations}
            unitMask={unitMask}
            disabled={submitting}
            onSkipNetworkCreationChange={() => {}}
            onLocationsChange={setLocations}
            onUnitMaskChange={setUnitMask}
          />
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Скасувати
        </Button>
        <Button
          onClick={submit}
          variant="contained"
          disabled={submitting || uniqueTrimmed(locations).length === 0}
          startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : null}
        >
          Створити
        </Button>
      </DialogActions>
    </Dialog>
  );
}
