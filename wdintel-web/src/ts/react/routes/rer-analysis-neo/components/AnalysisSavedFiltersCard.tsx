import type { SavedFilter } from '../../../../../Bindings';
import { SavedFiltersControl } from '../../../components/SavedFiltersControl';

type Props = {
  isDirty: boolean;
  loadedSavedFilter: SavedFilter | null;
  canSaveAsNew: boolean;
  saveInFlight: boolean;
  savedFilterName: string;
  savedFilters: SavedFilter[];
  onApplySavedFilter: (savedFilter: SavedFilter | null) => void;
  onDeleteLoadedSavedFilter: () => void;
  onRenameExisting: (name: string) => boolean | Promise<boolean> | void;
  onSaveAsNew: (name: string) => boolean | Promise<boolean> | void;
  onSavedFilterNameChange: (name: string) => void;
  onUpdateExisting: () => void | Promise<void>;
};

export function AnalysisSavedFiltersCard({
  isDirty,
  loadedSavedFilter,
  canSaveAsNew,
  saveInFlight,
  savedFilterName,
  savedFilters,
  onApplySavedFilter,
  onDeleteLoadedSavedFilter,
  onRenameExisting,
  onSaveAsNew,
  onSavedFilterNameChange,
  onUpdateExisting,
}: Props) {
  return (
    <SavedFiltersControl
      savedFilters={savedFilters}
      selectedSavedFilter={loadedSavedFilter}
      savedFilterName={savedFilterName}
      isDirty={isDirty}
      canSaveAsNew={canSaveAsNew}
      saveInFlight={saveInFlight}
      onApplySavedFilter={onApplySavedFilter}
      onSavedFilterNameChange={onSavedFilterNameChange}
      onUpdateExisting={onUpdateExisting}
      onSaveAsNew={onSaveAsNew}
      onRenameExisting={onRenameExisting}
      onDeleteExisting={onDeleteLoadedSavedFilter}
    />
  );
}
