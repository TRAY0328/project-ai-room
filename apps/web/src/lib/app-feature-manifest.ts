/**
 * App-surface feature manifest (41 of the 108 catalog features).
 *
 * Read by packages/message-blocks/test/features.test.mjs: each id here must be
 * implemented by the named component and exposed with the named `data-testid`,
 * which apps/web/src/__tests__/app-features.test.tsx then renders and asserts.
 * A feature that loses its UI fails that test — it cannot stay "covered" on paper.
 */
import type { ScreenId } from "./router.js";

export interface AppFeatureProof {
  id: string;
  component: string;
  screen: ScreenId;
  testId: string;
}

export const APP_FEATURES: readonly AppFeatureProof[] = [
  { id: "F-016", component: "Composer", screen: "MAINCHAT", testId: "composer-source-toggle" },
  { id: "F-017", component: "Composer", screen: "MAINCHAT", testId: "composer-preview" },
  { id: "F-020", component: "Composer", screen: "MAINCHAT", testId: "composer-draft-state" },
  { id: "F-021", component: "Composer", screen: "MAINCHAT", testId: "composer-mention-ai" },
  { id: "F-022", component: "Composer", screen: "MAINCHAT", testId: "composer-mention-user" },
  { id: "F-023", component: "MessageActions", screen: "MAINCHAT", testId: "message-reply" },
  { id: "F-024", component: "MessageActions", screen: "MAINCHAT", testId: "message-thread-create" },
  { id: "F-025", component: "ThreadPanel", screen: "MAINCHAT", testId: "thread-notify-toggle" },
  { id: "F-027", component: "RoomDetailScreen", screen: "ROOMDETAIL", testId: "room-pin-list" },
  { id: "F-028", component: "MessageActions", screen: "MAINCHAT", testId: "message-bookmark" },
  { id: "F-029", component: "MessageActions", screen: "MAINCHAT", testId: "message-share-ref" },
  { id: "F-030", component: "MessageActions", screen: "MAINCHAT", testId: "message-copy-link" },
  { id: "F-041", component: "FilesScreen", screen: "FILES", testId: "file-pdf-preview" },
  { id: "F-049", component: "FileDropzone", screen: "FILES", testId: "upload-progress" },
  { id: "F-050", component: "FileDropzone", screen: "FILES", testId: "upload-resume" },
  { id: "F-052", component: "FilesScreen", screen: "FILES", testId: "download-progress" },
  { id: "F-053", component: "FilesScreen", screen: "FILES", testId: "permission-download" },
  { id: "F-055", component: "CodeActions", screen: "MAINCHAT", testId: "code-copy" },
  { id: "F-056", component: "CodeActions", screen: "MAINCHAT", testId: "code-download" },
  { id: "F-058", component: "ReviewPanel", screen: "REVIEW", testId: "diff-line-comment" },
  { id: "F-066", component: "CiScreen", screen: "CI", testId: "ci-undo-message" },
  { id: "F-068", component: "TaskBoardScreen", screen: "TASKBOARD", testId: "task-reassign-suggest" },
  { id: "F-069", component: "DependenciesScreen", screen: "DEPENDENCIES", testId: "dependency-graph" },
  { id: "F-074", component: "Reactions", screen: "MAINCHAT", testId: "reaction-emoji" },
  { id: "F-075", component: "Reactions", screen: "MAINCHAT", testId: "reaction-custom" },
  { id: "F-076", component: "Reactions", screen: "MAINCHAT", testId: "reaction-remove" },
  { id: "F-077", component: "Reactions", screen: "MAINCHAT", testId: "reaction-count" },
  { id: "F-078", component: "Composer", screen: "MAINCHAT", testId: "typing-indicator" },
  { id: "F-080", component: "MessageActions", screen: "MAINCHAT", testId: "message-read-receipt" },
  { id: "F-081", component: "RoomsScreen", screen: "ROOMS", testId: "room-unread" },
  { id: "F-082", component: "MessageActions", screen: "MAINCHAT", testId: "message-important" },
  { id: "F-083", component: "AlertsScreen", screen: "ALERTS", testId: "alert-mute" },
  { id: "F-084", component: "AlertsScreen", screen: "ALERTS", testId: "alert-priority" },
  { id: "F-085", component: "CommandPalette", screen: "SEARCH", testId: "quick-search" },
  { id: "F-086", component: "SearchScreen", screen: "SEARCH", testId: "search-filters" },
  { id: "F-087", component: "SearchScreen", screen: "SEARCH", testId: "search-jump" },
  { id: "F-090", component: "RoomDetailScreen", screen: "ROOMDETAIL", testId: "tombstone-restore" },
  { id: "F-091", component: "Composer", screen: "MAINCHAT", testId: "send-dedupe" },
  { id: "F-092", component: "OutboxBanner", screen: "MAINCHAT", testId: "outbox-retry" },
  { id: "F-101", component: "AlertsScreen", screen: "ALERTS", testId: "alert-timeline" },
  { id: "F-102", component: "ReviewPanel", screen: "REVIEW", testId: "review-checklist" },
];
