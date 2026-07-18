import CloseIcon from '@mui/icons-material/Close';
import { Box, Button, Drawer, IconButton, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

import type {
  SignalGroupEntry,
  SignalProfileEntry,
  Unit,
  Network,
  Tag,
  CallsignInfoRes,
} from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { DutyMessageCard } from '../shared/message-card/MessageCard';
import { buildMessageCardDisplayLabels } from '../shared/message-card/message-card-labels';
import type { CreatedMessageResultState } from './useCreatedMessageResult';

type Props = {
  authUserName: string | null;
  open: boolean;
  result: CreatedMessageResultState;
  onClose: () => void;
  groupInfos: Record<string, SignalGroupEntry>;
  profiles: Record<string, SignalProfileEntry | null>;
  networkDisplayMap: Record<number, string>;
  networkMap: Record<number, Network>;
  unitsMap: Record<number, Unit>;
  callsignInfoMap: Record<string, CallsignInfoRes>;
  tagsMap: Record<number, Tag>;
  tagsOrder: number[];
  featureStrictNetworks: boolean;
};

export function CreatedMessagePreviewDrawer({
  authUserName,
  open,
  result,
  onClose,
  groupInfos,
  profiles,
  networkDisplayMap,
  networkMap,
  unitsMap,
  callsignInfoMap,
  tagsMap,
  tagsOrder,
  featureStrictNetworks,
}: Props) {
  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      disableRestoreFocus
      slotProps={{
        paper: {
          sx: {
            width: { xs: '100%', sm: 720 },
            maxWidth: '100vw',
            backgroundColor: 'background.default',
            backgroundImage: 'none',
          },
        },
      }}
    >
      {result.kind === 'message' ? (
        <CreatedMessageDrawerMessage
          authUserName={authUserName}
          messageId={result.messageId}
          message={result.message}
          onClose={onClose}
          groupInfos={groupInfos}
          profiles={profiles}
          networkDisplayMap={networkDisplayMap}
          networkMap={networkMap}
          unitsMap={unitsMap}
          callsignInfoMap={callsignInfoMap}
          tagsMap={tagsMap}
          tagsOrder={tagsOrder}
          featureStrictNetworks={featureStrictNetworks}
        />
      ) : result.kind === 'receipt' ? (
        <CreatedMessageDrawerReceipt
          messageId={result.messageId}
          warning={result.warning}
          onClose={onClose}
        />
      ) : null}
    </Drawer>
  );
}

function CreatedMessageDrawerMessage({
  authUserName,
  messageId,
  message,
  onClose,
  groupInfos,
  profiles,
  networkDisplayMap,
  networkMap,
  unitsMap,
  callsignInfoMap,
  tagsMap,
  tagsOrder,
  featureStrictNetworks,
}: {
  authUserName: string | null;
  messageId: number;
  message: import('../../../../Bindings').InboxMessage;
  onClose: () => void;
  groupInfos: Record<string, SignalGroupEntry>;
  profiles: Record<string, SignalProfileEntry | null>;
  networkDisplayMap: Record<number, string>;
  networkMap: Record<number, Network>;
  unitsMap: Record<number, Unit>;
  callsignInfoMap: Record<string, CallsignInfoRes>;
  tagsMap: Record<number, Tag>;
  tagsOrder: number[];
  featureStrictNetworks: boolean;
}) {
  const labels = buildMessageCardDisplayLabels(message, { groupInfos, profiles });

  return (
    <CreatedMessageDrawerShell messageId={messageId} onClose={onClose}>
      <Stack spacing={2}>
        <DutyMessageCard
          id={messageId}
          msg={message}
          readOnly
          referenceTimeMs={Date.now()}
          authUserName={authUserName}
          groupName={labels.groupName}
          senderName={labels.senderName}
          copiedFeedbackId={null}
          networkDisplayMap={networkDisplayMap}
          networkMap={networkMap}
          unitsMap={unitsMap}
          callsignInfoMap={callsignInfoMap}
          tagsMap={tagsMap}
          tagsOrder={tagsOrder}
          featureStrictNetworks={featureStrictNetworks}
        />
      </Stack>
    </CreatedMessageDrawerShell>
  );
}

function CreatedMessageDrawerReceipt({
  messageId,
  warning,
  onClose,
}: {
  messageId: number;
  warning: string;
  onClose: () => void;
}) {
  return (
    <CreatedMessageDrawerShell messageId={messageId} onClose={onClose}>
      <Stack spacing={2}>
        <PowerAlert severity="success">Повідомлення створено.</PowerAlert>
        <Box sx={{ display: 'grid', gap: 1 }}>
          <Typography variant="body1">ID повідомлення: {messageId}</Typography>
          <Typography variant="body2" color="text.secondary">
            {warning}
          </Typography>
        </Box>
      </Stack>
    </CreatedMessageDrawerShell>
  );
}

function CreatedMessageDrawerShell({
  messageId,
  onClose,
  children,
}: {
  messageId: number;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Box
        component="header"
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 2,
          py: 1.5,
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Box>
          <Typography variant="h6">Додане повідомлення</Typography>
          <Typography variant="body2" color="text.secondary">
            {messageId}
          </Typography>
        </Box>
        <IconButton aria-label="Закрити" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </Box>
      <Box component="main" sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 2 }}>
        {children}
      </Box>
      <Box
        component="footer"
        sx={{
          p: 2.5,
          borderTop: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 2,
          flexShrink: 0,
        }}
      >
        <Button onClick={onClose}>Закрити</Button>
      </Box>
    </Box>
  );
}
