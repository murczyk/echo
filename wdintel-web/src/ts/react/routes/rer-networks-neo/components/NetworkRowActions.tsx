import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import SummarizeOutlinedIcon from '@mui/icons-material/SummarizeOutlined';
import { Box } from '@mui/material';

import { MrtRowActionButton, MrtRowActions } from '../../../components/MrtRowActionButton';
import type { NetworkRowView } from '../helpers';

type Props = {
  network: NetworkRowView;
  canEdit: boolean;
  canExport: boolean;
  canDelete: boolean;
  onOpenReportDialog: (network: NetworkRowView['network']) => void;
  onOpenEditDialog: (network: NetworkRowView['network']) => void;
  onOpenDeleteDialog: (network: NetworkRowView['network']) => void;
};

function buildDirectionFindingHref(networkId: number): string {
  return `/rer-networks/${networkId}?tab=direction-finding`;
}

export function NetworkRowActions({
  network,
  canEdit,
  canExport,
  canDelete,
  onOpenReportDialog,
  onOpenEditDialog,
  onOpenDeleteDialog,
}: Props) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center' }}>
      <MrtRowActions>
        <MrtRowActionButton
          label="Еталонний опис"
          onClick={() => onOpenReportDialog(network.network)}
          disabled={!canExport}
          icon={<SummarizeOutlinedIcon fontSize="small" />}
          opensModal
        />
        <MrtRowActionButton
          label="Пеленгація"
          onClick={() => window.open(buildDirectionFindingHref(network.id), '_blank', 'noreferrer')}
          icon={<MapOutlinedIcon fontSize="small" />}
        />
        <MrtRowActionButton
          label="Редагувати"
          onClick={() => onOpenEditDialog(network.network)}
          disabled={!canEdit}
          icon={<EditIcon fontSize="small" />}
          opensModal
        />
        <MrtRowActionButton
          label="Видалити"
          onClick={() => onOpenDeleteDialog(network.network)}
          disabled={!canDelete}
          icon={<DeleteIcon fontSize="small" />}
          tone="danger"
          opensModal
        />
      </MrtRowActions>
    </Box>
  );
}
