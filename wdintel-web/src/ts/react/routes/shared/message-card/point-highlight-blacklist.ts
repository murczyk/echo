import type { ContentNode, CnPoint, InboxMessage } from '../../../../../Bindings';

export type AddPointHighlightBlacklistRequest = {
  messageId: number;
  etalon: string;
  palitraId: number;
};

export type PointBlacklistRequestSource = {
  messageId: number;
  etalon: string;
  palitraIds: number[];
};

export type PointBlacklistActionResult =
  { kind: 'success'; message: string } | { kind: 'error'; message: string };

export function pointBlacklistLabelKey(value: string): string {
  return value.trim().toLowerCase();
}

function matchesPoint(point: CnPoint, request: AddPointHighlightBlacklistRequest): boolean {
  return (
    pointBlacklistLabelKey(point.etalon) === pointBlacklistLabelKey(request.etalon) &&
    point.palitraIds.includes(request.palitraId)
  );
}

function patchMarkedPointNode(
  node: ContentNode,
  request: AddPointHighlightBlacklistRequest,
): { node: ContentNode; changed: boolean } {
  if (typeof node === 'string' || !('CNPointC' in node) || !matchesPoint(node.CNPointC, request)) {
    return { node, changed: false };
  }

  const remainingPalitraIds = node.CNPointC.palitraIds.filter((id) => id !== request.palitraId);
  if (remainingPalitraIds.length === 0) {
    return { node: { CNTextC: { text: node.CNPointC.text } }, changed: true };
  }

  return {
    node: { CNPointC: { ...node.CNPointC, palitraIds: remainingPalitraIds } },
    changed: true,
  };
}

function patchMarkedText(
  textMarked: ContentNode[] | null,
  request: AddPointHighlightBlacklistRequest,
): { value: ContentNode[] | null; changed: boolean } {
  if (textMarked == null) return { value: textMarked, changed: false };

  let changed = false;
  const value = textMarked.map((node) => {
    const patched = patchMarkedPointNode(node, request);
    changed ||= patched.changed;
    return patched.node;
  });
  return { value: changed ? value : textMarked, changed };
}

function patchPointTokens(
  pointTokens: CnPoint[] | null,
  request: AddPointHighlightBlacklistRequest,
): { value: CnPoint[] | null; changed: boolean } {
  if (pointTokens == null) return { value: pointTokens, changed: false };

  let changed = false;
  const value = pointTokens.flatMap((point) => {
    if (!matchesPoint(point, request)) return [point];
    changed = true;
    const remainingPalitraIds = point.palitraIds.filter((id) => id !== request.palitraId);
    return remainingPalitraIds.length > 0 ? [{ ...point, palitraIds: remainingPalitraIds }] : [];
  });
  return { value: changed ? value : pointTokens, changed };
}

export function removePointHighlightSourceFromMessage(
  message: InboxMessage,
  request: AddPointHighlightBlacklistRequest,
): InboxMessage {
  const markedText = patchMarkedText(message.textMarked, request);
  const pointTokens = patchPointTokens(message.pointTokens, request);
  if (!markedText.changed && !pointTokens.changed) return message;

  return {
    ...message,
    textMarked: markedText.value,
    pointTokens: pointTokens.value,
  };
}
