import { useEffect, useMemo, useState } from 'react';
import AddIcon from '@mui/icons-material/Add';
import { CircularProgress, IconButton, Stack, TextField, Tooltip } from '@mui/material';

import type { CallsignInfoRes, InboxMessage } from '../../../../../Bindings';
import { PowerChip } from '../../../components/PowerChip';
import type { AnalysisCallsignActions } from './message-card.types';

function normalizeCallsign(value: string): string {
  return value.trim().toUpperCase();
}

function uniqueNormalizedCallsigns(values: string[]): string[] {
  return values.reduce<string[]>((acc, value) => {
    const normalized = normalizeCallsign(value);
    if (normalized === '' || acc.includes(normalized)) return acc;
    acc.push(normalized);
    return acc;
  }, []);
}

export function MessageCardCallsignsSection({
  msg,
  actions,
  callsignInfoMap,
  showAddForm,
}: {
  msg: InboxMessage;
  actions: AnalysisCallsignActions;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  showAddForm: boolean;
}) {
  const [callsignDraft, setCallsignDraft] = useState('');
  const [addingCallsign, setAddingCallsign] = useState(false);
  const currentCallsigns = useMemo(
    () => uniqueNormalizedCallsigns(msg.callsigns ?? []),
    [msg.callsigns],
  );
  const analysisVisibleCallsigns = useMemo(
    () => (callsignInfoMap ? currentCallsigns : currentCallsigns),
    [callsignInfoMap, currentCallsigns],
  );
  const messageResetKey = msg.messageUid ?? `${msg.timestamp ?? ''}-${msg.text ?? ''}`;

  useEffect(() => {
    setCallsignDraft('');
  }, [messageResetKey]);

  const addCallsign = async () => {
    if (addingCallsign) return;
    const callsign = normalizeCallsign(callsignDraft);
    if (callsign === '') return;
    if (currentCallsigns.includes(callsign)) {
      setCallsignDraft('');
      return;
    }
    setAddingCallsign(true);
    try {
      const saved = await actions.onAddCallsign(callsign);
      if (saved) setCallsignDraft('');
    } finally {
      setAddingCallsign(false);
    }
  };

  return (
    <Stack spacing={0.75} sx={{ minWidth: 0 }}>
      <Stack
        direction="row"
        spacing={0.75}
        useFlexGap
        flexWrap="wrap"
        alignItems="center"
        sx={{ minWidth: 0 }}
      >
        {analysisVisibleCallsigns.length > 0
          ? analysisVisibleCallsigns.map((callsign) => (
              <PowerChip
                key={callsign}
                label={callsign}
                onDelete={() => void actions.onRemoveCallsign(callsign)}
                color="primary"
                size="small"
                sx={{
                  height: 28,
                  '& .MuiChip-label': { px: 1, py: 0 },
                  '& .MuiChip-deleteIcon': { fontSize: 18, ml: 0.25, mr: 0.5 },
                }}
              />
            ))
          : null}
        {showAddForm ? (
          <>
            <TextField
              size="small"
              value={callsignDraft}
              placeholder="Позивний"
              autoComplete="off"
              onChange={(event) => setCallsignDraft(event.target.value.toUpperCase())}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void addCallsign();
                }
              }}
              inputProps={{ autoComplete: 'off', spellCheck: false, maxLength: 12 }}
              sx={{
                width: { xs: '100%', sm: 132 },
                minWidth: 108,
                flex: '0 1 132px',
                '& .MuiInputBase-root': { height: 30, borderRadius: 1, fontSize: 12 },
                '& .MuiInputBase-input': { py: 0, px: 1, lineHeight: '30px' },
              }}
            />
            <Tooltip title="Додати позивний" enterDelay={300}>
              <span>
                <IconButton
                  aria-label="Додати позивний"
                  onClick={() => void addCallsign()}
                  disabled={normalizeCallsign(callsignDraft) === '' || addingCallsign}
                  size="small"
                  sx={{ width: 30, height: 30, flexShrink: 0, ml: 0.25 }}
                >
                  {addingCallsign ? (
                    <CircularProgress size={16} thickness={5} color="inherit" />
                  ) : (
                    <AddIcon fontSize="small" />
                  )}
                </IconButton>
              </span>
            </Tooltip>
          </>
        ) : null}
      </Stack>
    </Stack>
  );
}
