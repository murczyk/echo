export const UNIT_CATALOG_CHANGED_EVENT = 'echo-unit-catalog-changed';

let revision = 0;

export function unitCatalogRevision(): number {
  return revision;
}

export function invalidateUnitCatalog(options?: { refreshMessages?: boolean }): void {
  revision += 1;
  window.dispatchEvent(new CustomEvent(UNIT_CATALOG_CHANGED_EVENT, { detail: options }));
}
