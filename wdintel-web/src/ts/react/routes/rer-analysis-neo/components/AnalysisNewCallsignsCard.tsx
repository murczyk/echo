import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Box, Collapse, IconButton, Paper, Skeleton, Stack } from '@mui/material';
import { useId, useState } from 'react';

import type { NewCallsignsRes } from '../../../../../Bindings';
import { CompactLinkText, CompactText, CompactTitle } from '../../../components/CompactTypography';

type Props = {
  loading?: boolean;
  newCallsigns: NewCallsignsRes;
};

function CallsignPeriod({ callsigns, label }: { callsigns: string[]; label: string }) {
  const contentId = useId().replace(/:/g, '-');
  const [expanded, setExpanded] = useState(false);

  return (
    <Stack component="li" spacing={0.5} sx={{ listStyle: 'none' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <CompactText component="div" color="text.secondary">
          {`${label}: ${callsigns.length}`}
        </CompactText>
        <IconButton
          aria-controls={contentId}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Згорнути' : 'Розгорнути'} позивні за ${label.toLowerCase()}`}
          disabled={callsigns.length === 0}
          size="small"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
      </Box>
      <Collapse in={expanded} unmountOnExit>
        <Stack id={contentId} direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
          {callsigns.map((callsign) => (
            <CompactLinkText
              key={callsign}
              component="a"
              href={`/rer-callsigns-neo?callsign=${encodeURIComponent(callsign)}&developing=All`}
              color="primary"
            >
              {callsign.toUpperCase()}
            </CompactLinkText>
          ))}
        </Stack>
      </Collapse>
    </Stack>
  );
}

export function AnalysisNewCallsignsCard({ loading = false, newCallsigns }: Props) {
  const headingId = useId().replace(/:/g, '-');

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <CompactTitle id={headingId} component="h2" sx={{ mb: 1.5 }}>
        Нові позивні
      </CompactTitle>
      <Stack component="ul" spacing={1} sx={{ p: 0, m: 0, listStyle: 'none' }}>
        {loading ? (
          <>
            <Skeleton component="li" variant="text" width="75%" />
            <Skeleton component="li" variant="text" width="68%" />
            <Skeleton component="li" variant="text" width="72%" />
          </>
        ) : (
          <>
            <CallsignPeriod callsigns={newCallsigns.notSeen24h} label="24 години" />
            <CallsignPeriod callsigns={newCallsigns.notSeen7days} label="7 днів" />
            <CallsignPeriod callsigns={newCallsigns.notSeen30days} label="30 днів" />
          </>
        )}
      </Stack>
    </Paper>
  );
}
