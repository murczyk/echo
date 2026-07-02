import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Divider,
  IconButton,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';

import type { Network, NetworkDescrType } from '../../../../../Bindings';
import { ELLIPSIS } from '../../../utils/misc';
import { NetworkDetailsEmptyState } from './NetworkDetailsEmptyState';

type NetworkDescription = Network['descriptions'][number];

function formatCollapsedDescriptionText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function getCollapsedDescriptionTopic(description: NetworkDescription): string {
  const topic = description.topic?.trim();
  if (topic) return formatCollapsedDescriptionText(topic);

  return '';
}

function getCollapsedDescriptionFallbackLines(description: NetworkDescription): string[] {
  return description.description
    .split(/\r?\n/)
    .map(formatCollapsedDescriptionText)
    .filter((line) => line !== '')
    .slice(0, 3);
}

function hasCollapsedDescriptionOverflow(description: NetworkDescription): boolean {
  const nonEmptyLines = description.description
    .split(/\r?\n/)
    .map(formatCollapsedDescriptionText)
    .filter((line) => line !== '');

  return nonEmptyLines.length > 3;
}

function getDescriptionTypeLabel(descrType: NetworkDescrType): string {
  return descrType === 'Sign' ? 'розвідувальні ознаки' : 'обґрунтування';
}

function getDescriptionSectionTitle(descrType: NetworkDescrType): string {
  return descrType === 'Sign' ? 'Розвідувальні ознаки' : 'Обґрунтування';
}

function getDescriptionEmptyText(descrType: NetworkDescrType): string {
  return descrType === 'Sign' ? 'Немає розвідувальних ознак' : "Немає обґрунтувань прив'язки";
}

const collapsedFallbackTextSx = {
  fontWeight: 400,
  fontSize: '1rem',
  lineHeight: 1.35,
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 1,
  overflow: 'hidden',
  userSelect: 'text',
} as const;

function DescriptionsSkeleton() {
  return (
    <Stack spacing={1.5} sx={{ minHeight: 0, height: '100%' }}>
      <Stack spacing={1.5} sx={{ flex: 1, minHeight: 0 }}>
        <Skeleton variant="rounded" height={84} />
        <Skeleton variant="rounded" height={84} />
        <Skeleton variant="rounded" height={84} />
        <Skeleton variant="rounded" height={84} />
        <Skeleton variant="rounded" height={84} />
        <Box sx={{ flex: 1, minHeight: 24 }} />
      </Stack>
    </Stack>
  );
}

function DescriptionItem({
  description,
  frequencyLabel,
  expanded,
  canManage,
  onToggle,
  onEdit,
  onDelete,
}: {
  description: NetworkDescription;
  frequencyLabel: string | null;
  expanded: boolean;
  canManage: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const descriptionTypeLabel = getDescriptionTypeLabel(description.descrType);
  const collapsedTopic = getCollapsedDescriptionTopic(description);
  const collapsedFallbackLines =
    collapsedTopic === '' ? getCollapsedDescriptionFallbackLines(description) : [];
  const collapsedFallbackOverflow =
    collapsedTopic === '' && hasCollapsedDescriptionOverflow(description);

  return (
    <Accordion
      expanded={expanded}
      onChange={(_, _expanded) => onToggle()}
      disableGutters
      elevation={0}
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        overflow: 'hidden',
        '&:before': {
          display: 'none',
        },
      }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreIcon />}
        sx={{
          px: 2,
          py: 1,
          minHeight: 80,
          '& .MuiAccordionSummary-content': {
            margin: 0,
            minWidth: 0,
          },
        }}
      >
        <Stack
          direction="row"
          spacing={2}
          alignItems="flex-start"
          sx={{ width: '100%', minWidth: 0 }}
        >
          <Box sx={{ minWidth: 0, flex: 1, pr: 2.5 }}>
            {collapsedTopic !== '' ? (
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 600,
                  fontSize: '1rem',
                  lineHeight: 1.35,
                  overflow: 'hidden',
                  display: 'block',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  userSelect: 'text',
                }}
              >
                {collapsedTopic}
              </Typography>
            ) : collapsedFallbackLines.length > 0 ? (
              <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                {collapsedFallbackLines.map((line, index) => (
                  <Typography key={`${index}:${line}`} variant="body2" sx={collapsedFallbackTextSx}>
                    {line}
                  </Typography>
                ))}
                {collapsedFallbackOverflow ? (
                  <Typography variant="body2" sx={collapsedFallbackTextSx}>
                    {ELLIPSIS}
                  </Typography>
                ) : null}
              </Stack>
            ) : (
              <Typography variant="body2" sx={collapsedFallbackTextSx}>
                Без теми
              </Typography>
            )}
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ flexWrap: 'wrap', mt: 0.75, alignItems: 'center', minWidth: 0 }}
            >
              <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                {description.login}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                •
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                {new Date(description.createdAt).toLocaleDateString('uk-UA', {
                  day: '2-digit',
                  month: '2-digit',
                  year: '2-digit',
                })}
              </Typography>
              {frequencyLabel ? (
                <>
                  <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                    •
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{
                      flexShrink: 0,
                      fontWeight: 700,
                      color: 'warning.main',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {frequencyLabel}
                  </Typography>
                </>
              ) : null}
            </Stack>
          </Box>
        </Stack>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 2, pb: 2, pt: 0 }}>
        {expanded ? (
          <Stack spacing={1.5}>
            <Divider
              sx={(theme) => ({
                borderColor: alpha(
                  theme.palette.text.primary,
                  theme.palette.mode === 'dark' ? 0.08 : 0.06,
                ),
                borderBottomWidth: 1,
                opacity: 1,
              })}
            />
            <Typography variant="body2" sx={{ whiteSpace: 'pre-line', lineHeight: 1.6 }}>
              {description.description}
            </Typography>
            {canManage ? (
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.5 }}>
                <Tooltip title="Редагувати" arrow>
                  <IconButton
                    aria-label={`Редагувати ${descriptionTypeLabel}`}
                    onClick={onEdit}
                    size="small"
                  >
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Видалити" arrow>
                  <IconButton
                    aria-label={`Видалити ${descriptionTypeLabel}`}
                    onClick={onDelete}
                    size="small"
                    color="error"
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            ) : null}
          </Stack>
        ) : null}
      </AccordionDetails>
    </Accordion>
  );
}

function DescriptionsList({
  network,
  loading,
  descriptions,
  canManage,
  expandedDescriptionIds,
  descrType,
  onToggleExpanded,
  onEdit,
  onDelete,
}: {
  network: { freqs: Array<{ id: number; freq: string }> } | null;
  loading: boolean;
  descriptions: NetworkDescription[];
  canManage: boolean;
  expandedDescriptionIds: number[];
  descrType: NetworkDescrType;
  onToggleExpanded: (descriptionId: number) => void;
  onEdit: (description: NetworkDescription) => void;
  onDelete: (description: NetworkDescription) => void;
}) {
  if (loading && !network) {
    return (
      <Box sx={{ minHeight: 0, height: '100%' }}>
        <DescriptionsSkeleton />
      </Box>
    );
  }

  return (
    <Stack spacing={1.5} sx={{ minHeight: 0, pb: 1.5 }}>
      {descriptions.length === 0 ? (
        <NetworkDetailsEmptyState
          icon={<DescriptionOutlinedIcon />}
          title={getDescriptionEmptyText(descrType)}
          minHeight={220}
        />
      ) : (
        <Stack spacing={1.5} sx={{ pb: 0.5 }}>
          {descriptions.map((description) => {
            const frequencyLabel =
              description.networkFrequencyId === null
                ? null
                : (network?.freqs.find((freq) => freq.id === description.networkFrequencyId)
                    ?.freq ?? `#${description.networkFrequencyId}`);

            return (
              <DescriptionItem
                key={description.id}
                description={description}
                frequencyLabel={frequencyLabel}
                expanded={expandedDescriptionIds.includes(description.id)}
                canManage={canManage}
                onToggle={() => onToggleExpanded(description.id)}
                onEdit={() => onEdit(description)}
                onDelete={() => onDelete(description)}
              />
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}

type Props = {
  network: Network | null;
  loading: boolean;
  confirmationDescriptions: NetworkDescription[];
  signDescriptions: NetworkDescription[];
  canManageDescriptions: boolean;
  expandedDescriptionIds: number[];
  onToggleExpanded: (descriptionId: number) => void;
  onEdit: (description: NetworkDescription) => void;
  onDelete: (description: NetworkDescription) => void;
  onCreate: (descrType: NetworkDescrType) => void;
  descrType: NetworkDescrType;
};

export function NetworkDetailsDescriptionsPanel({
  network,
  loading,
  confirmationDescriptions,
  signDescriptions,
  canManageDescriptions,
  expandedDescriptionIds,
  onToggleExpanded,
  onEdit,
  onDelete,
  onCreate,
  descrType,
}: Props) {
  const sectionTitle = getDescriptionSectionTitle(descrType);
  const descriptions = descrType === 'Sign' ? signDescriptions : confirmationDescriptions;

  return (
    <Box sx={{ minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto', flex: 1 }}>
      <Box sx={{ p: 2, minHeight: 0 }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
            mb: 2,
          }}
        >
          <Typography variant="h6">{sectionTitle}</Typography>
          {canManageDescriptions ? (
            loading ? (
              <Skeleton variant="rounded" width={104} height={36} />
            ) : (
              <Button variant="contained" onClick={() => onCreate(descrType)}>
                Додати
              </Button>
            )
          ) : null}
        </Box>
        <DescriptionsList
          network={network ? { freqs: network.freqs } : null}
          loading={loading}
          descriptions={descriptions}
          canManage={canManageDescriptions}
          expandedDescriptionIds={expandedDescriptionIds}
          descrType={descrType}
          onToggleExpanded={onToggleExpanded}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </Box>
    </Box>
  );
}
