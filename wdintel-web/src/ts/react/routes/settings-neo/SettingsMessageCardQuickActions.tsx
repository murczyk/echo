import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import { IconButton, MenuItem, TextField, Tooltip, Typography } from '@mui/material';
import { useEffect, useRef, type ReactNode, type Ref } from 'react';

import {
  MESSAGE_CARD_QUICK_ACTION_OPTIONS,
  normalizeMessageCardQuickAction,
  type MessageCardQuickAction,
  type MessageCardQuickActionSettings,
} from '../../services/api/user-settings';
import { MESSAGE_CARD_QUICK_ACTION_ICONS } from '../shared/message-card/MessageCardQuickAction';

type QuickActionSlot = 'messageCardQuickAction' | 'messageCardSecondQuickAction';

const OTHER_SLOT: Record<QuickActionSlot, QuickActionSlot> = {
  messageCardQuickAction: 'messageCardSecondQuickAction',
  messageCardSecondQuickAction: 'messageCardQuickAction',
};

const ADD_SECOND_LABEL = 'Додати другу швидку дію';
const REMOVE_SECOND_LABEL = 'Прибрати другу швидку дію';

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

function SlotButton({
  label,
  icon,
  disabled,
  buttonRef,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  disabled: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  onClick: () => void;
}) {
  return (
    <Tooltip title={label}>
      <span className="inline-flex shrink-0">
        <IconButton ref={buttonRef} aria-label={label} disabled={disabled} onClick={onClick}>
          {icon}
        </IconButton>
      </span>
    </Tooltip>
  );
}

function QuickActionSelect({
  label,
  value,
  disabled,
  selectRef,
  onChange,
  slotButton,
}: {
  label: string;
  value: MessageCardQuickAction;
  disabled: boolean;
  selectRef?: Ref<{ focus: () => void }>;
  onChange: (value: MessageCardQuickAction) => void;
  /** Adds or removes the second slot, to the right of the select. */
  slotButton?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-echo-xs">
      <TextField
        select
        inputRef={selectRef}
        SelectProps={{ inputProps: { 'aria-label': label } }}
        value={value}
        onChange={(event) => {
          const next = normalizeMessageCardQuickAction(event.target.value);
          if (next !== value) onChange(next);
        }}
        disabled={disabled}
        size="small"
        sx={{ width: 360 }}
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
      {slotButton}
    </div>
  );
}

export function SettingsMessageCardQuickActions({
  value,
  onChange,
  loadInProgress,
}: SettingsMessageCardQuickActionsProps & { loadInProgress: boolean }) {
  const twoSlots = value.messageCardQuickActionCount === 2;
  const secondSelectRef = useRef<{ focus: () => void } | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  // Keeps keyboard focus on the control that replaces the clicked button.
  const focusAfterCountChange = useRef<'second' | 'add' | null>(null);
  useEffect(() => {
    const target = focusAfterCountChange.current;
    focusAfterCountChange.current = null;
    if (target === 'second') secondSelectRef.current?.focus();
    else if (target === 'add') addButtonRef.current?.focus();
  }, [twoSlots]);

  const changeSlot = (slot: QuickActionSlot) => (action: MessageCardQuickAction) =>
    onChange(slotChange(value, slot, action));
  return (
    <div className="flex min-w-0 flex-col gap-echo-sm">
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        Швидкі дії:
      </Typography>
      <QuickActionSelect
        label={twoSlots ? 'Швидка дія 1' : 'Швидка дія'}
        value={value.messageCardQuickAction}
        disabled={loadInProgress}
        onChange={changeSlot('messageCardQuickAction')}
        slotButton={
          twoSlots ? null : (
            <SlotButton
              label={ADD_SECOND_LABEL}
              icon={<AddIcon />}
              disabled={loadInProgress}
              buttonRef={addButtonRef}
              onClick={() => {
                focusAfterCountChange.current = 'second';
                onChange({ messageCardQuickActionCount: 2 });
              }}
            />
          )
        }
      />
      {twoSlots ? (
        <QuickActionSelect
          label="Швидка дія 2"
          value={value.messageCardSecondQuickAction}
          disabled={loadInProgress}
          selectRef={secondSelectRef}
          onChange={changeSlot('messageCardSecondQuickAction')}
          slotButton={
            <SlotButton
              label={REMOVE_SECOND_LABEL}
              icon={<RemoveIcon />}
              disabled={loadInProgress}
              onClick={() => {
                focusAfterCountChange.current = 'add';
                onChange({ messageCardQuickActionCount: 1 });
              }}
            />
          }
        />
      ) : null}
      <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
        Обрані дії показуються у вузькій картці поруч із меню без дублювання. Якщо дія недоступна,
        кнопка приховується.
      </Typography>
    </div>
  );
}
