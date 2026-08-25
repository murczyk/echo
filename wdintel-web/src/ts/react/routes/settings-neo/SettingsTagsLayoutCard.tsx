import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Collapse, ToggleButton, ToggleButtonGroup } from '@mui/material';
import { isPresent } from '../../utils/misc';

import type { TagsLayoutVariant } from '../rer-duty-neo/utils';

function MessageCardTagsPreviewMock({ tagsLayout }: { tagsLayout: TagsLayoutVariant }) {
  return (
    <div
      data-message-card-tags-mock="true"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className="flex max-w-105 cursor-default flex-col gap-2 rounded-xl border border-echo-divider bg-black/2 p-3 dark:bg-white/2"
    >
      {/* Header skeleton */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <div className="h-2.25 w-20 rounded-sm bg-echo-text-muted/40" />
          <div className="h-2.25 w-10 rounded-sm bg-echo-text-muted/25" />
        </div>
        <div className="h-2.25 w-6.5 rounded-sm bg-echo-text-muted/25" />
      </div>

      {/* Message body skeleton */}
      <div className="flex flex-col gap-1 pt-0.5">
        <div className="h-1.75 w-[85%] rounded-sm bg-echo-text-muted/30" />
        <div className="h-1.75 w-[50%] rounded-sm bg-echo-text-muted/25" />
      </div>

      {/* Tags skeleton with animated layout changes */}
      <Collapse in={tagsLayout !== 'hidden'} timeout={250} unmountOnExit={false}>
        <div data-tags-mock="true" className="pt-0.5">
          <div className="flex flex-col gap-1.5">
            {/* Row 1 - fills the full line */}
            <div className="flex w-full items-center gap-1.5">
              <div className="h-3.5 flex-1 rounded-sm bg-echo-primary/35" />
              <div className="h-3.5 flex-[1.25] rounded-sm bg-echo-primary/35" />
              <div className="h-3.5 flex-[0.95] rounded-sm bg-echo-primary/35" />
              {tagsLayout === 'full' ? (
                <div className="h-3.5 flex-[1.15] rounded-sm bg-echo-primary/35" />
              ) : (
                <div className="flex h-3.5 flex-[1.15] items-center justify-center gap-1 rounded-sm border border-echo-primary/30 bg-echo-primary/10">
                  <div className="h-1.5 w-9.5 rounded-sm bg-echo-primary/60" />
                  <ExpandMoreIcon sx={{ fontSize: 10 }} className="text-echo-primary/80" />
                </div>
              )}
            </div>

            {/* Row 2 (animated collapse for full mode - exactly 1 tag) */}
            <Collapse in={tagsLayout === 'full'} timeout={250} unmountOnExit={false}>
              <div className="flex gap-1.5">
                <div className="h-3.5 w-[26%] rounded-sm bg-echo-primary/35" />
              </div>
            </Collapse>
          </div>
        </div>
      </Collapse>
    </div>
  );
}

export type SettingsTagsLayoutCardProps = {
  tagsLayout: TagsLayoutVariant;
  onTagsLayoutChange: (layout: TagsLayoutVariant) => void;
  loadInProgress: boolean;
};

export function SettingsTagsLayoutCard({
  tagsLayout,
  onTagsLayoutChange,
  loadInProgress,
}: SettingsTagsLayoutCardProps) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-divider bg-background-paper p-4 sm:p-5">
      <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
        Картка повідомлення
      </span>
      <div>
        <ToggleButtonGroup
          value={tagsLayout}
          exclusive
          color="primary"
          onChange={(_, v: TagsLayoutVariant | null) => {
            if (isPresent(v)) onTagsLayoutChange(v);
          }}
          size="small"
          disabled={loadInProgress}
          sx={{
            flexWrap: 'wrap',
            '& .MuiToggleButton-root': {
              textTransform: 'none',
              fontSize: 14,
              px: 2,
              py: 1,
              whiteSpace: 'nowrap',
            },
          }}
        >
          <ToggleButton value="full">повний</ToggleButton>
          <ToggleButton value="compact">щільний</ToggleButton>
          <ToggleButton value="hidden">без тегів</ToggleButton>
        </ToggleButtonGroup>
      </div>
      <MessageCardTagsPreviewMock tagsLayout={tagsLayout} />
    </div>
  );
}
