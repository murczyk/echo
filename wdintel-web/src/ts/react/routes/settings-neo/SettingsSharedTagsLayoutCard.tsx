import { Box, List, ListItem, ListItemIcon, Stack, Typography } from '@mui/material';

import type { TagsLayoutVariant } from '../rer-duty-neo/utils';
import type { MessageTextPreviewLineLimit } from '../../services/api/user-settings';
import { SettingsTagsLayoutCard } from './SettingsTagsLayoutCard';

export type SettingsSharedTagsLayoutCardProps = {
  tagsLayout: TagsLayoutVariant;
  onTagsLayoutChange: (layout: TagsLayoutVariant) => void;
  messageTextPreviewLines: MessageTextPreviewLineLimit;
  onMessageTextPreviewLinesChange: (value: MessageTextPreviewLineLimit) => void;
  loadInProgress: boolean;
};

export function SettingsSharedTagsLayoutCard({
  tagsLayout,
  onTagsLayoutChange,
  messageTextPreviewLines,
  onMessageTextPreviewLinesChange,
  loadInProgress,
}: SettingsSharedTagsLayoutCardProps) {
  return (
    <SettingsTagsLayoutCard
      title="Картка повідомлення"
      description={
        <Stack spacing={0.75}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Вигляд картки повідомлення:
          </Typography>
          <List disablePadding dense sx={{ color: 'text.secondary', pl: 0.75 }}>
            <ListItem disableGutters disablePadding sx={{ alignItems: 'center', py: 0.25 }}>
              <ListItemIcon sx={{ minWidth: 10, mr: 0.5 }}>
                <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'text.secondary' }} />
              </ListItemIcon>
              <Typography variant="body2" component="span" sx={{ lineHeight: 1.4 }}>
                <strong>Повний</strong> показує всі деталі
              </Typography>
            </ListItem>
            <ListItem disableGutters disablePadding sx={{ alignItems: 'center', py: 0.25 }}>
              <ListItemIcon sx={{ minWidth: 10, mr: 0.5 }}>
                <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'text.secondary' }} />
              </ListItemIcon>
              <Typography variant="body2" component="span" sx={{ lineHeight: 1.4 }}>
                <strong>Щільний</strong> робить картку коротшою і компактнішою
              </Typography>
            </ListItem>
            <ListItem disableGutters disablePadding sx={{ alignItems: 'center', py: 0.25 }}>
              <ListItemIcon sx={{ minWidth: 10, mr: 0.5 }}>
                <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'text.secondary' }} />
              </ListItemIcon>
              <Typography variant="body2" component="span" sx={{ lineHeight: 1.4 }}>
                <strong>Без тегів</strong> ховає теги
              </Typography>
            </ListItem>
          </List>
        </Stack>
      }
      note="Спільні налаштування для Оперативного та Аналізу."
      tagsLayout={tagsLayout}
      onTagsLayoutChange={onTagsLayoutChange}
      messageTextPreviewLines={messageTextPreviewLines}
      onMessageTextPreviewLinesChange={onMessageTextPreviewLinesChange}
      loadInProgress={loadInProgress}
    />
  );
}
