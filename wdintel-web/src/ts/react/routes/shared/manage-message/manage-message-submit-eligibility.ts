export type ManageMessageSubmitEligibilityInput = {
  busy: boolean;
  parsing: boolean;
  schemaValid: boolean;
  unitSelectionValid?: boolean;
  isEditMode: boolean;
  groupOptional?: boolean;
  allowMissingGroup?: boolean;
  reportTextRequired?: boolean;
  groupsLoading: boolean;
  selectedGroupKey: string;
  accessibleGroupKeys: readonly string[];
  text: string;
  fullBody: string;
  newAttachmentCount: number;
  existingAttachmentIds: readonly string[];
  deletedAttachmentIds: readonly string[];
  replacedAttachmentIds: readonly string[];
  maxAttachmentCount: number;
};

export function isManageMessageSubmitEligible({
  busy,
  parsing,
  schemaValid,
  unitSelectionValid = true,
  isEditMode,
  groupOptional = false,
  allowMissingGroup = false,
  reportTextRequired = false,
  groupsLoading,
  selectedGroupKey,
  accessibleGroupKeys,
  text,
  fullBody,
  newAttachmentCount,
  existingAttachmentIds,
  deletedAttachmentIds,
  replacedAttachmentIds,
  maxAttachmentCount,
}: ManageMessageSubmitEligibilityInput): boolean {
  const deletedIds = new Set(deletedAttachmentIds);
  const replacedIds = new Set(replacedAttachmentIds);
  const retainedAttachmentCount = existingAttachmentIds.filter(
    (id) => !deletedIds.has(id) && !replacedIds.has(id),
  ).length;
  const attachmentCount = retainedAttachmentCount + newAttachmentCount;
  const hasContent = reportTextRequired
    ? Boolean(fullBody.trim())
    : Boolean(text.trim() || fullBody.trim() || attachmentCount > 0);
  const hasAccessibleGroup = groupOptional
    ? selectedGroupKey === '' ||
      (!groupsLoading && accessibleGroupKeys.some((key) => key === selectedGroupKey))
    : isEditMode ||
      (allowMissingGroup && selectedGroupKey === '') ||
      (!groupsLoading && accessibleGroupKeys.some((key) => key === selectedGroupKey));

  return (
    !busy &&
    !parsing &&
    schemaValid &&
    unitSelectionValid &&
    hasAccessibleGroup &&
    hasContent &&
    attachmentCount <= maxAttachmentCount
  );
}
