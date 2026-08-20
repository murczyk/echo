import { Box } from '@mui/material';

import { MrtOverflowText } from '../../components/mui-customized/table/mrt-overflow';

type MessengerDescriptionCellProps = {
  description: string | null | undefined;
  endpoint: string | null | undefined;
  showEndpoint: boolean;
};

function trimCellValue(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

export function MessengerDescriptionCell({
  description,
  endpoint,
  showEndpoint,
}: MessengerDescriptionCellProps) {
  const descriptionValue = trimCellValue(description);
  const endpointValue = trimCellValue(endpoint);

  return (
    <Box sx={{ display: 'grid', gap: 0.25, minWidth: 0, maxWidth: '100%' }}>
      <MrtOverflowText displayValue={descriptionValue || '—'} fullValue={descriptionValue || '—'} />
      {showEndpoint && endpointValue ? (
        <Box sx={{ color: 'text.secondary', minWidth: 0, maxWidth: '100%' }}>
          <MrtOverflowText
            displayValue={`Endpoint: ${endpointValue}`}
            fullValue={`Endpoint: ${endpointValue}`}
          />
        </Box>
      ) : null}
    </Box>
  );
}
