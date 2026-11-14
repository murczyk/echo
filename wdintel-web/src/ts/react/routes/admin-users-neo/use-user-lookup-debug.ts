import { useEffect } from 'react';
import { DEBUG_USERS_NEO, debugLog } from './user-display';
import type { UserLookups } from './user-types';
export function useUserLookupDebug(
  kind: string,
  open: boolean,
  lookups: UserLookups,
  form: { sigintZoneId: number | null; organismId: number | null } | null,
) {
  useEffect(() => {
    if (!open || !DEBUG_USERS_NEO || !form) return;
    debugLog(`${kind}:options`, {
      zonesStatus: lookups.zonesStatus,
      zonesCount: lookups.zones.length,
      zoneIds: lookups.zones.slice(0, 5).map(([zoneId]) => zoneId),
      sigintZoneId: form.sigintZoneId,
      organismsStatus: lookups.organismsStatus,
      organismsCount: lookups.organisms.length,
      organismIds: lookups.organisms.slice(0, 5).map((organism) => organism.id),
      organismId: form.organismId,
    });
  }, [
    kind,
    open,
    form?.sigintZoneId,
    form?.organismId,
    lookups.zonesStatus,
    lookups.zones,
    lookups.organismsStatus,
    lookups.organisms,
  ]);
}
