import type { Callsign } from '../../../../../Bindings';
import { ConfirmDangerDialog } from '../../../components/ConfirmDangerDialog';

type Props = {
  target: Callsign | null;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteCallsignDialog({ target, submitting, onCancel, onConfirm }: Props) {
  return (
    <ConfirmDangerDialog
      open={target !== null}
      onClose={onCancel}
      onConfirm={onConfirm}
      disableRestoreFocus
      maxWidth="xs"
      description={target ? `Видалити позивний "${target.callsign}"?` : ''}
      submitting={submitting}
      disabled={!target}
    />
  );
}
