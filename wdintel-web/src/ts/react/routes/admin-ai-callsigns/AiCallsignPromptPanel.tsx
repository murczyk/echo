import { Box, Stack, Typography } from '@mui/material';

import type { AiCallsignEngineItem } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { AiCallsignControls, type AiCallsignAction } from './AiCallsignControls';

export function AiCallsignPromptPanel({
  action,
  canRun,
  engines,
  prompt,
  selectedEngineIds,
  onPromptChange,
  onRecalculate,
  onSave,
  onSelectionChange,
  onTest,
}: {
  action: AiCallsignAction | null;
  canRun: boolean;
  engines: AiCallsignEngineItem[];
  prompt: string;
  selectedEngineIds: string[];
  onPromptChange: (prompt: string) => void;
  onRecalculate: () => void;
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
