import React from 'react';
import { FormProvider, Controller, useFormContext } from 'react-hook-form';
import {
  Drawer,
  Typography,
  TextField,
  Button,
  IconButton,
  CircularProgress,
  Box,
  Stack,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';

import type { User, InboxMessage } from '../../../../../Bindings';
import { ConfirmDangerDialog } from '../../../components/ConfirmDangerDialog';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerForm } from '../../../components/PowerForm';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import { deleteMessage } from '../../../services/api/inbox-message-actions';
import { formatDirectSubmitError } from '../../../services/api/direct-submit';

import { useManageMessageDrawer } from './useManageMessageDrawer';
import { FormSectionWrapper } from './drawer-sections/FormSectionWrapper';
import { AttachmentsSection } from './drawer-sections/AttachmentsSection';
import { SystemSection } from './drawer-sections/SystemSection';
import { MetadataSection } from './drawer-sections/MetadataSection';
import { NetworkSection } from './drawer-sections/NetworkSection';
import { DmrSection } from './drawer-sections/DmrSection';
import { LocationsSection } from './drawer-sections/LocationsSection';
import { AdvancedFieldsSection } from './drawer-sections/AdvancedFieldsSection';
import type { MessageFormData } from './manage-message-drawer.schema';
import type { QuickIntelReportSuggestionState } from './useManageMessageDrawer';

export type Props = {
  open: boolean;
  cyberEchoEnabled: boolean;
  currentUser: User | null;
  onClose: () => void;
  onCreated?: (
    result: import('../../../services/api/direct-submit').DirectSubmitResponse,
  ) => void | Promise<void>;
  onEditSuccess?: (
    result: import('../../../services/api/direct-submit').DirectSubmitResponse,
  ) => void | Promise<void>;
  onDeleteSuccess?: (messageId: number) => void | Promise<void>;
  editTarget?: { id: number; message: InboxMessage } | null;
  reportSource?: { id: number; message: InboxMessage } | null;
  editSaveInFlight?: boolean;
  onSubmitEdit?: (id: number, message: InboxMessage) => void | Promise<void>;
};

function ReportTextRow({
  originalText,
  busy,
  quickSuggestion,
  onApplyQuickSuggestion,
  onSelectAdjacentQuickSuggestion,
  onRetryQuickSuggestion,
}: {
  originalText: string;
  busy: boolean;
  quickSuggestion: QuickIntelReportSuggestionState;
  onApplyQuickSuggestion: () => void;
  onSelectAdjacentQuickSuggestion: (offset: number) => void;
  onRetryQuickSuggestion: () => void;
}) {
  const { control } = useFormContext<MessageFormData>();
  const reportTextRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  React.useEffect(() => {
    if (busy) return;
    const frameId = window.requestAnimationFrame(() => reportTextRef.current?.focus());
    return () => window.cancelAnimationFrame(frameId);
  }, [busy]);

  return (
    <Box
      data-testid="report-text-row"
      sx={{
        gridColumn: '1 / -1',
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 1fr)' },
        gap: 3,
        minWidth: 0,
      }}
    >
      <FormSectionWrapper title="Оригінальний текст">
        <TextField
          label="Текст оригінального повідомлення"
          value={originalText}
          fullWidth
          multiline
          rows={6}
          slotProps={{ input: { readOnly: true } }}
        />
      </FormSectionWrapper>
      <FormSectionWrapper title="Розвіддонесення">
        <Controller
          name="full_body"
          control={control}
          render={({ field }) => (
            <TextField
              {...field}
              label="Текст розвіддонесення"
              fullWidth
              multiline
              rows={6}
              required
              autoFocus
              inputRef={reportTextRef}
              disabled={busy}
            />
          )}
        />
        {quickSuggestion.status !== 'idle' ? (
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, mt: 1.5 }}>
            <Stack alignItems="center" spacing={0.5} sx={{ color: 'text.secondary', minWidth: 28 }}>
              <SmartToyOutlinedIcon
                aria-label="ШІ пропозиція"
                aria-busy={quickSuggestion.status === 'loading' || undefined}
                data-testid={
                  quickSuggestion.status === 'loading' ? 'quick-suggestion-loading' : undefined
                }
                fontSize="small"
                sx={
                  quickSuggestion.status === 'loading'
                    ? {
                        animation: 'quick-suggestion-pulse 1.2s ease-in-out infinite',
                        '@keyframes quick-suggestion-pulse': {
                          '0%, 100%': { opacity: 0.35, transform: 'scale(0.9)' },
                          '50%': { opacity: 1, transform: 'scale(1.1)' },
                        },
                      }
                    : undefined
                }
              />
            </Stack>
            {quickSuggestion.status === 'loading' ? (
              <Typography role="status" aria-live="polite" variant="body2" color="text.secondary">
                Формуємо ШІ пропозицію…
              </Typography>
            ) : null}
            {quickSuggestion.status === 'available' ? (
              <Box sx={{ minWidth: 0, flex: 1, position: 'relative' }}>
                <Typography
                  component="button"
                  type="button"
                  variant="body2"
                  title="Застосувати ШІ пропозицію"
                  onClick={onApplyQuickSuggestion}
                  sx={{
                    minWidth: 0,
                    p: 0,
                    pr: quickSuggestion.suggestions.length > 1 ? 10 : 0,
                    border: 0,
                    background: 'none',
                    color: 'text.primary',
                    font: 'inherit',
                    textAlign: 'left',
                    whiteSpace: 'pre-wrap',
                    cursor: 'pointer',
                    '&:hover': { color: 'primary.main' },
                  }}
                >
                  {quickSuggestion.suggestions[quickSuggestion.selectedIndex]}
                </Typography>
                {quickSuggestion.suggestions.length > 1 ? (
                  <Stack
                    direction="row"
                    alignItems="center"
                    spacing={0.25}
                    sx={{ position: 'absolute', top: -4, right: 0 }}
                  >
                    <IconButton
                      size="small"
                      aria-label="Попередня ШІ пропозиція"
                      onClick={() => onSelectAdjacentQuickSuggestion(-1)}
                      sx={{ width: 24, height: 24 }}
                    >
                      <ChevronLeftIcon fontSize="small" />
                    </IconButton>
                    <Typography variant="caption" color="text.disabled">
                      {quickSuggestion.selectedIndex + 1}/{quickSuggestion.suggestions.length}
                    </Typography>
                    <IconButton
                      size="small"
                      aria-label="Наступна ШІ пропозиція"
                      onClick={() => onSelectAdjacentQuickSuggestion(1)}
                      sx={{ width: 24, height: 24 }}
                    >
                      <ChevronRightIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                ) : null}
              </Box>
            ) : null}
            {quickSuggestion.status === 'error' ? (
              <Stack
                direction="row"
                alignItems="center"
                spacing={0.5}
                sx={{ minWidth: 0, flex: 1 }}
              >
                <Typography variant="caption" color="text.disabled">
                  {quickSuggestion.message}
                </Typography>
                <IconButton
                  size="small"
                  aria-label="Повторити формування ШІ пропозиції"
                  onClick={onRetryQuickSuggestion}
                  sx={{ width: 18, height: 18, p: 0, opacity: 0.35, fontSize: '0.75rem' }}
                >
                  ↻
                </IconButton>
              </Stack>
            ) : null}
            {quickSuggestion.status === 'applied' ? (
              <Typography variant="caption" color="text.secondary">
                ШІ пропозицію застосовано
              </Typography>
            ) : null}
          </Box>
        ) : null}
      </FormSectionWrapper>
    </Box>
  );
}

export function ManageMessageDrawer(props: Props) {
  const drawerState = useManageMessageDrawer(props);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false);
  const [deleteInFlight, setDeleteInFlight] = React.useState(false);

  const {
    isEditMode,
    isReportMode,
    isReportCreateMode,
    originalReportText,
    quickSuggestion,
    applyQuickSuggestion,
    selectAdjacentQuickSuggestion,
    retryQuickSuggestion,
    existingMedia,
    showAdvanced,
    setShowAdvanced,
    signalGroups,
    groupsLoading,
    busy: drawerBusy,
    parsing,
    errorMsg,
    setErrorMsg,
    tagOptions,
    deviceNameOptions,
    deviceNamesLoading,
    setDeviceNameInput,
    uppy,
    uppyFiles,
    fileInputRef,
    handleFileSelect,
    handleDrop,
    handleDropzoneKeyDown,
    methods,
    canSubmit,
    handleParse,
    handleDrawerClose,
    onSubmit,
    recentValues,
  } = drawerState;
  const busy = drawerBusy || deleteInFlight;
  const reportDeleteId = isEditMode && isReportMode ? (props.editTarget?.id ?? null) : null;

  const handleDeleteConfirm = async () => {
    if (reportDeleteId == null || deleteInFlight) return;
    setDeleteInFlight(true);
    setErrorMsg(null);
    try {
      await deleteMessage({ id: reportDeleteId });
    } catch (error) {
      setDeleteInFlight(false);
      setDeleteConfirmOpen(false);
      setErrorMsg(formatDirectSubmitError(error, 'delete'));
      return;
    }

    setDeleteInFlight(false);
    setDeleteConfirmOpen(false);
    handleDrawerClose();
    try {
      await props.onDeleteSuccess?.(reportDeleteId);
    } catch (error) {
      console.error('Error handling report deletion', error);
    }
  };

  return (
    <>
      <Drawer
        anchor="right"
        open={props.open}
        onClose={busy ? undefined : handleDrawerClose}
        sx={{ zIndex: 1200 }}
        ModalProps={{
          closeAfterTransition: true,
          BackdropProps: {
            sx: (theme) => pageDrawerBackdropSx(theme),
          },
        }}
        slotProps={{
          paper: {
            sx: {
              width: isReportMode ? '100vw' : { xs: '100%', sm: 720, md: 1040 },
              maxWidth: '100vw',
              display: 'flex',
              backgroundColor: 'background.default',
              backgroundImage: 'none',
            },
          },
        }}
      >
        <div className="flex flex-col h-full flex-1 min-h-0">
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              p: 2.5,
              borderBottom: '1px solid',
              borderColor: 'divider',
            }}
          >
            <Typography variant="h6">
              {isReportMode
                ? isEditMode
                  ? 'Редагувати розвіддонесення'
                  : 'Створити розвіддонесення'
                : isEditMode
                  ? 'Редагувати повідомлення'
                  : 'Створити повідомлення'}
            </Typography>
            <IconButton onClick={handleDrawerClose} disabled={busy}>
              <CloseIcon />
            </IconButton>
          </Box>

          <Box sx={{ flex: 1, p: 2.5, overflowY: 'auto' }}>
            {errorMsg && (
              <PowerAlert severity="error" onClose={() => setErrorMsg(null)} sx={{ mb: 2 }}>
                {errorMsg}
              </PowerAlert>
            )}

            <FormProvider {...methods}>
              <PowerForm
                id="create-message-form"
                noValidate
                onSubmit={methods.handleSubmit(onSubmit)}
                canSubmit={canSubmit && !deleteInFlight}
                globalSubmitShortcut
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 1fr)' },
                  gap: 3,
                  alignItems: 'start',
                }}
              >
                {isReportMode ? (
                  <ReportTextRow
                    originalText={originalReportText}
                    busy={busy}
                    quickSuggestion={quickSuggestion}
                    onApplyQuickSuggestion={applyQuickSuggestion}
                    onSelectAdjacentQuickSuggestion={selectAdjacentQuickSuggestion}
                    onRetryQuickSuggestion={retryQuickSuggestion}
                  />
                ) : null}

                {/* LEFT COLUMN */}
                <Box component="fieldset" sx={{ minWidth: 0, border: 0, p: 0, m: 0 }}>
                  {!isReportMode ? (
                    <>
                      <Typography component="legend" variant="subtitle2" sx={{ mb: 1 }}>
                        Вміст повідомлення <span aria-hidden="true">*</span>
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                        Додайте текст повідомлення або принаймні одне вкладення.
                      </Typography>
                    </>
                  ) : null}
                  <Stack spacing={2.5}>
                    {!isReportMode ? (
                      <FormSectionWrapper
                        title="Джерело"
                        action={
                          !isEditMode ? (
                            <Button
                              onClick={handleParse}
                              variant="outlined"
                              size="small"
                              startIcon={
                                parsing ? (
                                  <CircularProgress size={16} color="inherit" />
                                ) : (
                                  <AutoFixHighIcon />
                                )
                              }
                              disabled={busy || parsing}
                            >
                              Розпарсити
                            </Button>
                          ) : null
                        }
                      >
                        <Controller
                          name="full_body"
                          control={methods.control}
                          render={({ field }) => (
                            <TextField
                              {...field}
                              label="Текст повідомлення"
                              fullWidth
                              multiline
                              rows={12}
                              disabled={busy}
                            />
                          )}
                        />
                      </FormSectionWrapper>
                    ) : null}

                    <AttachmentsSection
                      uppy={uppy}
                      uppyFiles={uppyFiles}
                      fileInputRef={fileInputRef}
                      handleFileSelect={handleFileSelect}
                      handleDrop={handleDrop}
                      handleDropzoneKeyDown={handleDropzoneKeyDown}
                      busy={busy}
                      existingMedia={existingMedia}
                      errorMsg={drawerState.attachmentErrorMsg}
                    />
                  </Stack>
                </Box>

                {/* RIGHT COLUMN */}
                <Stack spacing={2.5}>
                  <SystemSection
                    signalGroups={signalGroups}
                    groupsLoading={groupsLoading}
                    busy={busy}
                    isEditMode={isEditMode}
                    groupOptional={isReportMode}
                    groupEditable={isReportMode}
                    cyberEchoEnabled={props.cyberEchoEnabled}
                    deviceNameOptions={deviceNameOptions}
                    deviceNamesLoading={deviceNamesLoading}
                    setDeviceNameInput={setDeviceNameInput}
                    recentValues={recentValues}
                  />

                  <MetadataSection
                    showAdvanced={showAdvanced}
                    busy={busy}
                    recentValues={recentValues}
                    tagOptions={tagOptions}
                    postOptions={drawerState.postOptions}
                    postLoading={drawerState.postLoading}
                    setPostInput={drawerState.setPostInput}
                    unitOptions={drawerState.unitOptions}
                    unitLoading={drawerState.unitLoading}
                    setUnitInput={drawerState.setUnitInput}
                    unitLocked={drawerState.unitLocked}
                    callsignOptions={drawerState.callsignOptions}
                    callsignLoading={drawerState.callsignLoading}
                    callsignInput={drawerState.callsignInput}
                    setCallsignInput={drawerState.setCallsignInput}
                  />

                  <NetworkSection
                    isEditMode={isEditMode}
                    busy={busy}
                    recentValues={recentValues}
                    networkNameOptions={drawerState.networkNameOptions}
                    networkNameLoading={drawerState.networkNameLoading}
                    setNetworkNameInput={drawerState.setNetworkNameInput}
                    networkUnitNamesById={drawerState.networkUnitNamesById}
                    selectedNetwork={drawerState.selectedNetwork}
                    setSelectedNetwork={drawerState.setSelectedNetwork}
                    freqOptions={drawerState.freqOptions}
                    freqLoading={drawerState.freqLoading}
                    setFreqInput={drawerState.setFreqInput}
                    unitLocked={drawerState.unitLocked}
                    setUnitLocked={drawerState.setUnitLocked}
                  />

                  <LocationsSection
                    busy={busy}
                    recentValues={recentValues}
                    open={props.open}
                    onError={setErrorMsg}
                  />

                  {!isReportMode ? (
                    <>
                      <DmrSection
                        showAdvanced={showAdvanced}
                        busy={busy}
                        recentValues={recentValues}
                      />

                      <AdvancedFieldsSection
                        showAdvanced={showAdvanced}
                        busy={busy}
                        recentValues={recentValues}
                        signalNameOptions={drawerState.signalNameOptions}
                        signalNameLoading={drawerState.signalNameLoading}
                        setSignalNameInput={drawerState.setSignalNameInput}
                      />
                    </>
                  ) : null}
                </Stack>
              </PowerForm>
            </FormProvider>

            {reportDeleteId != null ? (
              <Box sx={{ display: { xs: 'flex', md: 'none' }, mt: 3, pt: 1 }}>
                <Button
                  onClick={() => setDeleteConfirmOpen(true)}
                  disabled={busy}
                  color="error"
                  variant="outlined"
                  startIcon={<DeleteOutlineIcon />}
                  fullWidth
                >
                  Видалити
                </Button>
              </Box>
            ) : !isReportMode ? (
              <Box sx={{ display: { xs: 'flex', md: 'none' }, mt: 3, pt: 1 }}>
                <Button
                  onClick={() => setShowAdvanced((prev) => !prev)}
                  disabled={busy}
                  color="inherit"
                  variant="outlined"
                  fullWidth
                >
                  {showAdvanced ? 'Приховати розширені поля' : 'Розширені поля'}
                </Button>
              </Box>
            ) : null}
          </Box>

          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 2,
              p: 2.5,
              borderTop: '1px solid',
              borderColor: 'divider',
            }}
          >
            <Box sx={{ display: { xs: 'none', md: 'flex' } }}>
              {reportDeleteId != null ? (
                <Button
                  onClick={() => setDeleteConfirmOpen(true)}
                  disabled={busy}
                  color="error"
                  startIcon={<DeleteOutlineIcon />}
                >
                  Видалити
                </Button>
              ) : !isReportMode ? (
                <Button
                  onClick={() => setShowAdvanced((prev) => !prev)}
                  disabled={busy}
                  color="inherit"
                >
                  {showAdvanced ? 'Приховати розширені поля' : 'Розширені поля'}
                </Button>
              ) : null}
            </Box>
            <Box sx={{ display: 'flex', gap: 2, ml: 'auto' }}>
              <Button onClick={handleDrawerClose} disabled={busy}>
                Скасувати
              </Button>
              <Button
                type="submit"
                form="create-message-form"
                variant="contained"
                color="primary"
                disabled={!canSubmit || deleteInFlight}
                startIcon={busy && <CircularProgress size={20} color="inherit" />}
              >
                {busy ? 'Збереження...' : isEditMode ? 'Зберегти' : 'Створити'}
              </Button>
            </Box>
          </Box>
        </div>
      </Drawer>
      <ConfirmDangerDialog
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={() => void handleDeleteConfirm()}
        title="Видалити розвіддонесення?"
        description="Цю дію неможливо скасувати."
        submitting={deleteInFlight}
        disabled={drawerBusy}
      />
    </>
  );
}
