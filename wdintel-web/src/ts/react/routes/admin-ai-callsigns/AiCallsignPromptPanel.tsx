import RestoreIcon from '@mui/icons-material/Restore';
import { Box, CircularProgress, Stack, Typography } from '@mui/material';

import type { AiCallsignEngineItem } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { AiCallsignControls, type AiCallsignAction } from './AiCallsignControls';

export function AiCallsignPromptPanel({
  action,
  canRun,
  engines,
  prompt,
  promptOverridden,
  selectedEngineIds,
  onPromptChange,
  onRecalculate,
  onReset,
  onSave,
  onSelectionChange,
  onTest,
}: {
  action: AiCallsignAction | null;
  canRun: boolean;
  engines: AiCallsignEngineItem[];
  prompt: string;
  promptOverridden: boolean;
  selectedEngineIds: string[];
  onPromptChange: (prompt: string) => void;
  onRecalculate: () => void;
  onReset: () => void;
  onSave: () => void;
  onSelectionChange: (ids: string[]) => void;
  onTest: () => void;
}) {
  return (
    <Box
      component="aside"
      aria-label="Панель промпту"
      sx={{
        width: 400,
        flexShrink: 0,
        alignSelf: 'stretch',
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        p: 2,
      }}
    >
      <Stack spacing={2}>
        <Typography component="h2" variant="h6">
          Промпт парсингу
        </Typography>
        <Stack spacing={1} alignItems="flex-start">
          <Typography variant="body2" color="text.secondary">
            {promptOverridden
              ? 'Активне тимчасове перевизначення.'
              : 'Використовується вбудований стандартний промпт.'}
          </Typography>
          <PowerButton
            type="button"
            variant="outlined"
            disabled={action !== null || !promptOverridden}
            onClick={onReset}
            startIcon={action === 'reset' ? <CircularProgress size={18} /> : <RestoreIcon />}
          >
            Скинути до стандартного
          </PowerButton>
        </Stack>
        {engines.length === 0 ? (
          <PowerAlert severity="warning">
            Немає увімкнених ШІ движків. Увімкніть хоча б один у налаштуваннях системи.
          </PowerAlert>
        ) : null}
        <AiCallsignControls
          action={action}
          canRun={canRun}
          engines={engines}
          prompt={prompt}
          selectedEngineIds={selectedEngineIds}
          onPromptChange={onPromptChange}
          onRecalculate={onRecalculate}
          onSave={onSave}
          onSelectionChange={onSelectionChange}
          onTest={onTest}
        />
      </Stack>
    </Box>
  );
}
