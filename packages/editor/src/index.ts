/**
 * @ai-room/editor — web IDE building blocks.
 *
 * Monaco+Yjs collaborative editing, accessible file tree, git diff, PR review
 * with SHA-bound approvals, and CI/terminal panels that state what they cannot
 * do instead of simulating it.
 */
// Monaco + Yjs binding is exported from the separate `./editor` entry so that
// importing diff/review/CI panels does not pull the whole editor bundle.
export { MonacoYjsEditor } from "./MonacoYjsEditor.js";
export type { MonacoYjsEditorProps } from "./MonacoYjsEditor.js";
export { FileTree } from "./FileTree.js";
export type { TreeNode } from "./FileTree.js";
export { DiffViewer } from "./DiffViewer.js";
export type { DiffViewerProps, DiffAnchor } from "./DiffViewer.js";
export { ReviewPanel } from "./ReviewPanel.js";
export type { ReviewPanelProps, ReviewState, ReviewComment, ReviewApproval, ChecklistItem } from "./ReviewPanel.js";
export { CIPanel } from "./CIPanel.js";
export type { CIPanelProps, CiRun, CiJob, CiArtifact } from "./CIPanel.js";
export { TerminalPanel } from "./TerminalPanel.js";
export type { TerminalPanelProps, TerminalSession } from "./TerminalPanel.js";
export { CollabProvider, listPeers } from "./collab.js";
export type { CollabStatus, PeerPresence } from "./collab.js";
export { setupMonacoEnvironment, defineEditorThemes, applyEditorTheme, languageForPath, LANGUAGE_BY_EXTENSION, monaco } from "./monacoSetup.js";
