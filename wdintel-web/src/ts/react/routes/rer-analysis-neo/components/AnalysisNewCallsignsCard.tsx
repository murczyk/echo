import { Paper, Skeleton, Stack } from '@mui/material';
import { useCallback, useId } from 'react';

import type { NewCallsignsRes } from '../../../../../Bindings';
import { CompactLinkText, CompactText, CompactTitle } from '../../../components/CompactTypography';

type Props = {
  loading?: boolean;
  newCallsigns: NewCallsignsRes;
};

export function AnalysisNewCallsignsCard({ loading = false, newCallsigns }: Props) {
  const headingId = useId().replace(/:/g, '-');
  const renderList = useCallback((items: string[] | null | undefined) => {
    const callsigns = items ?? [];
    if (callsigns.length === 0) {
      return <CompactText component="span">немає</CompactText>;
    }

    return (
      <Stack component="span" direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
        {callsigns.map((callsign) => (
          <CompactLinkText
            key={callsign}
            component="a"
            href={`/rer-callsigns-neo?callsign=${encodeURIComponent(callsign)}`}
            color="primary"
          >
            {callsign}
          </CompactLinkText>
        ))}
      </Stack>
    );
  }, []);

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <CompactTitle id={headingId} component="h2" sx={{ mb: 1.5 }}>
        Нові позивні
      </CompactTitle>
      <Stack component="ul" spacing={2} sx={{ pl: 0, pt: 2, m: 0, listStyle: 'none' }}>
        {loading ? (
          <>
            <Skeleton component="li" variant="text" width="75%" />
            <Skeleton component="li" variant="text" width="68%" />
            <Skeleton component="li" variant="text" width="72%" />
          </>
        ) : (
          <>
            <Stack component="li" spacing={1} sx={{ listStyle: 'none' }}>
              <CompactText component="div" color="text.secondary">
                24 години:
              </CompactText>
              <CompactText component="div" color="text.secondary">
                {renderList(newCallsigns.notSeen24h)}
              </CompactText>
            </Stack>
            <Stack component="li" spacing={1} sx={{ listStyle: 'none' }}>
              <CompactText component="div" color="text.secondary">
                7 днів:
              </CompactText>
              <CompactText component="div" color="text.secondary">
                {renderList(newCallsigns.notSeen7days)}
              </CompactText>
            </Stack>
            <Stack component="li" spacing={1} sx={{ listStyle: 'none' }}>
              <CompactText component="div" color="text.secondary">
                30 днів:
              </CompactText>
              <CompactText component="div" color="text.secondary">
                {renderList(newCallsigns.notSeen30days)}
              </CompactText>
            </Stack>
          </>
        )}
      </Stack>
    </Paper>
  );
}
