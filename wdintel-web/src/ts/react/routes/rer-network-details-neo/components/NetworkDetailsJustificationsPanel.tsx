import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Accordion, AccordionDetails, AccordionSummary, Box, Button, Divider, IconButton, Paper, Skeleton, Stack, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { Network } from '../../../../../Bindings';

type NetworkDescription = Network['descriptions'][number];

function formatCollapsedDescriptionText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function JustificationsSkeleton() {
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

function JustificationItem({
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
        <Stack direction="row" spacing={2} alignItems="flex-start" sx={{ width: '100%', minWidth: 0 }}>
          <Box sx={{ minWidth: 0, flex: 1, pr: 2.5 }}>
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
              }}
            >
              {formatCollapsedDescriptionText(description.description)}
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.75, alignItems: 'center', minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                {description.login}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                •
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                {new Date(description.createdAt).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: '2-digit' })}
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
                borderColor: alpha(theme.palette.text.primary, theme.palette.mode === 'dark' ? 0.08 : 0.06),
                borderBottomWidth: 1,
                opacity: 1,
              })}
            />
            <Typography
              variant="overline"
              sx={{
                display: 'block',
                fontSize: '0.95rem',
                lineHeight: 1.2,
                fontWeight: 700,
                letterSpacing: '0.04em',
                color: 'text.secondary',
              }}
            >
              Матеріали радіоперехоплення
            </Typography>
            <Typography variant="body2" sx={{ whiteSpace: 'pre-line', lineHeight: 1.6 }}>
              {description.description}
            </Typography>
            {canManage ? (
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.5 }}>
                <Tooltip title="Редагувати" arrow>
                  <IconButton aria-label="Редагувати обґрунтування" onClick={onEdit} size="small">
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Видалити" arrow>
                  <IconButton aria-label="Видалити обґрунтування" onClick={onDelete} size="small" color="error">
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

function JustificationsTab({
  network,
  loading,
  descriptions,
  canManage,
  expandedDescriptionIds,
  onToggleExpanded,
  onEdit,
  onDelete,
}: {
  network: { freqs: Array<{ id: number; freq: string }> } | null;
  loading: boolean;
  descriptions: NetworkDescription[];
  canManage: boolean;
  expandedDescriptionIds: number[];
  onToggleExpanded: (descriptionId: number) => void;
  onEdit: (description: NetworkDescription) => void;
  onDelete: (description: NetworkDescription) => void;
}) {
  if (loading && !network) {
    return (
      <Box sx={{ minHeight: 0, height: '100%' }}>
        <JustificationsSkeleton />
      </Box>
    );
  }

  return (
    <Stack spacing={1.5} sx={{ minHeight: 0, pb: 1.5 }}>
      {descriptions.length === 0 ? (
        <Box
          sx={{
            minHeight: 180,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 2,
            border: '1px dashed',
            borderColor: 'divider',
            bgcolor: 'background.default',
          }}
        >
          <Typography variant="body2" color="text.secondary">
            Немає обґрунтувань прив'язки
          </Typography>
        </Box>
      ) : (
        <Stack spacing={1.5} sx={{ pb: 0.5 }}>
          {descriptions.map((description) => {
            const frequencyLabel =
              description.networkFrequencyId === null
                ? null
                : network?.freqs.find((freq) => freq.id === description.networkFrequencyId)?.freq ?? `#${description.networkFrequencyId}`;

            return (
              <JustificationItem
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
  descriptions: NetworkDescription[];
  canManage: boolean;
  expandedDescriptionIds: number[];
  onToggleExpanded: (descriptionId: number) => void;
  onEdit: (description: NetworkDescription) => void;
  onDelete: (description: NetworkDescription) => void;
  onCreate: () => void;
};

export function NetworkDetailsJustificationsPanel({
  network,
  loading,
  descriptions,
  canManage,
  expandedDescriptionIds,
  onToggleExpanded,
  onEdit,
  onDelete,
  onCreate,
}: Props) {
  return (
    <Paper
      variant="outlined"
      sx={{
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          px: 2,
          pt: 0.5,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Tabs
          value="justifications"
          variant="standard"
          sx={{
            minHeight: 42,
            '& .MuiTabs-indicator': {
              height: 2,
            },
          }}
        >
          <Tab value="justifications" label="Обґрунтування" />
        </Tabs>
      </Box>
      <Box sx={{ px: 2, pt: 2, pb: 3, minHeight: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, mb: 2 }}>
          <Typography variant="h6">Обґрунтування</Typography>
          {canManage ? (
            loading ? (
              <Skeleton variant="rounded" width={104} height={36} />
            ) : (
              <Button variant="contained" onClick={onCreate}>
                Додати
              </Button>
            )
          ) : null}
        </Box>
        <JustificationsTab
          network={network ? { freqs: network.freqs } : null}
          loading={loading}
          descriptions={descriptions}
          canManage={canManage}
          expandedDescriptionIds={expandedDescriptionIds}
          onToggleExpanded={onToggleExpanded}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </Box>
    </Paper>
  );
}
