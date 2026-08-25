import { Alert } from '@mui/material';

import { PowerButton } from '../../../components/PowerButton';

export function ImageEditorDiscardAlert({
  onContinue,
  onDiscard,
}: {
  onContinue: () => void;
  onDiscard: () => void;
}) {
  return (
    <Alert
      severity="warning"
      className="m-2"
      action={
        <span className="flex gap-1">
          <PowerButton type="button" color="inherit" size="small" onClick={onContinue}>
            Продовжити
          </PowerButton>
          <PowerButton type="button" color="inherit" size="small" onClick={onDiscard}>
            Відкинути
          </PowerButton>
        </span>
      }
    >
      Є незастосовані зміни.
    </Alert>
  );
}
