export type SearchableOptionSelection = {
  id: number;
  value: string;
};

export type SearchableOption = {
  id: number;
};

/** Build controlled selection from a stored option id (callsigns, network drawers). */
export function selectionFromId<T extends SearchableOption>(
  options: readonly T[],
  id: number | null | undefined,
  getStoredValue: (option: T) => string,
): SearchableOptionSelection | null {
  if (id == null) return null;
  const option = options.find((item) => item.id === id);
  return option ? { id: option.id, value: getStoredValue(option) } : null;
}
