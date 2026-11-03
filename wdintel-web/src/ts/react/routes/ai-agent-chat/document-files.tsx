import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import { createContext, useContext } from 'react';
import type { AiAgentDocumentArtifact } from '../../../../Bindings';
import { EchoChip } from '../../components/EchoChip';
import './documents.css';

/** What the document workspace shows: a generated document (optionally an
 * older revision) or an uploaded file of the conversation. */
export type DocumentFileSelection =
  | { kind: 'document'; documentId: string; revision?: number | null }
  | { kind: 'upload'; uploadId: string };

/** Documents announced in the conversation, for resolving `echo-document:` links. */
export const ConversationDocumentsContext = createContext<AiAgentDocumentArtifact[]>([]);

export const DocumentSelectionContext = createContext<
  ((selection: DocumentFileSelection, opener: HTMLElement) => void) | null
>(null);

export function documentHref(documentId: string): string {
  return `echo-document:${documentId}`;
}

/** Latest revision per document, in order of first appearance. */
export function latestDocuments(documents: AiAgentDocumentArtifact[]): AiAgentDocumentArtifact[] {
  const latest = new Map<string, AiAgentDocumentArtifact>();
  for (const document of documents) {
    const known = latest.get(document.documentId);
    if (!known || known.revision < document.revision) latest.set(document.documentId, document);
  }
  return [...latest.values()];
}

export function DocumentChip({
  document,
  inert = false,
}: {
  document: AiAgentDocumentArtifact;
  inert?: boolean;
}) {
  const select = useContext(DocumentSelectionContext);
  const label = (
    <>
      <DescriptionOutlinedIcon fontSize="inherit" className="ai-document-chip-icon" />
      <span className="ai-document-chip-title">{document.title}</span>
      <span className="ai-document-chip-version">v{document.revision}</span>
    </>
  );
  if (inert || !select)
    return (
      <EchoChip
        label={<span className="inline-flex items-center gap-echo-xs">{label}</span>}
        title="Документ доступний лише автору розмови"
      />
    );
  return (
    <button
      type="button"
      className="ai-document-chip"
      aria-label={`Відкрити документ «${document.title}», версія ${document.revision}`}
      title={document.fileName}
      onClick={(event) =>
        select(
          { kind: 'document', documentId: document.documentId, revision: document.revision },
          event.currentTarget,
        )
      }
    >
      {label}
    </button>
  );
}
