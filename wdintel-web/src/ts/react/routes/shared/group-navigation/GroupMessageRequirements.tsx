import { Checkbox, FormControlLabel } from '@mui/material';
import type { SignalGroupEntry } from '../../../../../Bindings';

type Requirements = Pick<SignalGroupEntry, 'isSigintUnitMandatory' | 'isDeviceMandatory'>;

export function GroupMessageRequirements({
  isSigintUnitMandatory,
  isDeviceMandatory,
  disabled,
  onChange,
}: Requirements & { disabled?: boolean; onChange: (requirements: Requirements) => void }) {
  return (
    <>
      <FormControlLabel
        label="Обов’язковий підрозділ"
        control={
          <Checkbox
            checked={isSigintUnitMandatory}
            disabled={disabled}
            onChange={(_, checked) =>
              onChange({ isSigintUnitMandatory: checked, isDeviceMandatory })
            }
          />
        }
      />
      <FormControlLabel
        label="Обов’язкова назва пристрою"
        control={
          <Checkbox
            checked={isDeviceMandatory}
            disabled={disabled}
            onChange={(_, checked) =>
              onChange({ isSigintUnitMandatory, isDeviceMandatory: checked })
            }
          />
        }
      />
    </>
  );
}
