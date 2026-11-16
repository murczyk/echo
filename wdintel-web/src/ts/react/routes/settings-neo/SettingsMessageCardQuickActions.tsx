import { MenuItem, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';

import {
  MESSAGE_CARD_QUICK_ACTION_COUNTS,
  MESSAGE_CARD_QUICK_ACTION_OPTIONS,
  normalizeMessageCardQuickAction,
  type MessageCardQuickAction,
  type MessageCardQuickActionCount,
  type MessageCardQuickActionSettings,
} from '../../services/api/user-settings';
import { MESSAGE_CARD_QUICK_ACTION_ICONS } from '../shared/message-card/MessageCardQuickAction';

type QuickActionSlot = 'messageCardQuickAction' | 'messageCardSecondQuickAction';

const OTHER_SLOT: Record<QuickActionSlot, QuickActionSlot> = {
  messageCardQuickAction: 'messageCardSecondQuickAction',
  messageCardSecondQuickAction: 'messageCardQuickAction',
};

export type SettingsMessageCardQuickActionsProps = {
  value: MessageCardQuickActionSettings;
  onChange: (patch: Partial<MessageCardQuickActionSettings>) => void;
};

/** Picking the other slot's action swaps the two, so the slots never repeat. */
function slotChange(
  value: MessageCardQuickActionSettings,
  slot: QuickActionSlot,
  action: MessageCardQuickAction,
): Partial<MessageCardQuickActionSettings> {
  const otherSlot = OTHER_SLOT[slot];
  return action === value[otherSlot]
    ? { [slot]: action, [otherSlot]: value[slot] }
    : { [slot]: action };
}

function QuickActionSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: MessageCardQuickAction;
  disabled: boolean;
  onChange: (value: MessageCardQuickAction) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-echo-sm">
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {label}:
      </Typography>
      <TextField
        select
        SelectProps={{ inputProps: { 'aria-label': label } }}
        value={value}
        onChange={(event) => {
          const next = normalizeMessageCardQuickAction(event.target.value);
          if (next !== value) onChange(next);
        }}
        disabled={disabled}
        size="small"
        sx={{ width: 360, maxWidth: '100%', alignSelf: 'flex-start' }}
      >
        {MESSAGE_CARD_QUICK_ACTION_OPTIONS.map((option) => {
          const Icon = MESSAGE_CARD_QUICK_ACTION_ICONS[option.value];
          return (
            <MenuItem key={option.value} value={option.value}>
              <span className="inline-flex max-w-full items-center gap-echo-sm align-middle">
                <Icon fontSize="small" className="shrink-0" />
                <span className="truncate">{option.label}</span>
              </span>
            </MenuItem>
          );
        })}
      </TextField>
    </div>
  );
}

export function SettingsMessageCardQuickActions({
  value,
  onChange,
  loadInProgress,
}: SettingsMessageCardQuickActionsProps & { loadInProgress: boolean }) {
  const count = value.messageCardQuickActionCount;
  const slots: Array<{ slot: QuickActionSlot; label: string }> =
    count === 1
      ? [{ slot: 'messageCardQuickAction', label: 'Швидка дія' }]
      : [
          { slot: 'messageCardQuickAction', label: 'Швидка дія 1' },
          { slot: 'messageCardSecondQuickAction', label: 'Швидка дія 2' },
        ];
  return (
    <div className="flex min-w-0 flex-col gap-echo-md">
      <div className="flex flex-col gap-echo-sm">
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Кількість швидких дій:
        </Typography>
        <ToggleButtonGroup
          aria-label="Кількість швидких дій"
          value={count}
          exclusive
          color="primary"
          size="small"
          disabled={loadInProgress}
          onChange={(_, next: MessageCardQuickActionCount | null) => {
            if (next != null && next !== count) onChange({ messageCardQuickActionCount: next });
          }}
          sx={{
            alignSelf: 'flex-start',
            '& .MuiToggleButton-root': { fontSize: 14, px: 2, py: 1, minWidth: 48 },
          }}
        >
          {MESSAGE_CARD_QUICK_ACTION_COUNTS.map((option) => (
            <ToggleButton key={option} value={option}>
              {option}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </div>
      {slots.map(({ slot, label }) => (
        <QuickActionSelect
          key={slot}
          label={label}
          value={value[slot]}
          disabled={loadInProgress}
          onChange={(action) => onChange(slotChange(value, slot, action))}
        />
      ))}
      <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
        Обрані дії показуються у вузькій картці поруч із меню без дублювання. Якщо дія недоступна,
        кнопка приховується.
      </Typography>
    </div>
  );
}
