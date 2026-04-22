import type { TagsLayoutVariant } from '../rer-duty-neo/utils';
import { SettingsTagsLayoutCard } from './SettingsTagsLayoutCard';

export type SettingsSharedTagsLayoutCardProps = {
  tagsLayout: TagsLayoutVariant;
  onTagsLayoutChange: (layout: TagsLayoutVariant) => void;
  loadInProgress: boolean;
};

export function SettingsSharedTagsLayoutCard({
  tagsLayout,
  onTagsLayoutChange,
  loadInProgress,
}: SettingsSharedTagsLayoutCardProps) {
  return (
    <SettingsTagsLayoutCard
      title="Вигляд тегів"
      description="Оберіть, скільки деталей показувати в картці повідомлення."
      note="Спільне налаштування для Оперативного та Аналізу."
      tagsLayout={tagsLayout}
      onTagsLayoutChange={onTagsLayoutChange}
      loadInProgress={loadInProgress}
    />
  );
}
