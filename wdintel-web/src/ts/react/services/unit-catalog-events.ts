export const UNIT_CATALOG_CHANGED_EVENT = 'echo-unit-catalog-changed';

let revision = 0;
let serverRevision: string | null = null;

export function reconcileUnitCatalog(nextRevision: string | null, changed: boolean): void {
  const missedChange =
    nextRevision != null && serverRevision != null && nextRevision !== serverRevision;
  const unversionedChange = changed && (nextRevision == null || serverRevision == null);
  if (nextRevision != null) serverRevision = nextRevision;
  if (unversionedChange || missedChange) invalidateUnitCatalog();
}

export function unitCatalogRevision(): number {
  return revision;
}

export function invalidateUnitCatalog(options?: { refreshMessages?: boolean }): void {
  revision += 1;
  window.dispatchEvent(new CustomEvent(UNIT_CATALOG_CHANGED_EVENT, { detail: options }));
}
