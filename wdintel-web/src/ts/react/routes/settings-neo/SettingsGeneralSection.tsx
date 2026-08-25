import { PowerAlert } from '../../components/PowerAlert';
import type { TagsLayoutVariant } from '../rer-duty-neo/utils';
import { SettingsMediaSummaryCard } from './SettingsMediaSummaryCard';
import { SettingsTagsLayoutCard } from './SettingsTagsLayoutCard';

export type SettingsGeneralSectionProps = {
  loadInProgress: boolean;
  prefsLoadError: string | null;
  saveError: string | null;
  tagsLayout: TagsLayoutVariant;
  onTagsLayoutChange: (layout: TagsLayoutVariant) => void;
  mediaSummaryEnabled: boolean;
  onMediaSummaryEnabledChange: (value: boolean) => void;
};

export function SettingsGeneralSection({
  loadInProgress,
  prefsLoadError,
  saveError,
  tagsLayout,
  onTagsLayoutChange,
  mediaSummaryEnabled,
  onMediaSummaryEnabledChange,
}: SettingsGeneralSectionProps) {
  return (
    <div
      id="settings-neo-panel-general"
      role="tabpanel"
      aria-labelledby="settings-neo-tab-general"
      className="p-6"
    >
      <div className="flex max-w-240 flex-col gap-6">
        <h2 className="text-xl font-bold leading-tight text-text-primary">Загальні</h2>

        {prefsLoadError ? <PowerAlert severity="warning">{prefsLoadError}</PowerAlert> : null}
        {saveError ? <PowerAlert severity="error">{saveError}</PowerAlert> : null}

        <div className="flex min-w-0 flex-col gap-6">
          <SettingsTagsLayoutCard
            tagsLayout={tagsLayout}
            onTagsLayoutChange={onTagsLayoutChange}
            loadInProgress={loadInProgress}
          />

          <SettingsMediaSummaryCard
            mediaSummaryEnabled={mediaSummaryEnabled}
            onMediaSummaryEnabledChange={onMediaSummaryEnabledChange}
            loadInProgress={loadInProgress}
          />
        </div>
      </div>
    </div>
  );
}
