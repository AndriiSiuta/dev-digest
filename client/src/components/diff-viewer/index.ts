/* diff-viewer — unified-diff viewer with optional inline GitHub comments.
   Public surface: the DiffViewer component + the DiffCommentApi contract.
   FileCard is also exported directly — SmartDiffViewer renders FileCards in
   its own grouped order rather than going through DiffViewer's plain list. */
export { DiffViewer } from "./DiffViewer";
export { FileCard } from "./FileCard";
export type { DiffCommentApi } from "./comments";
