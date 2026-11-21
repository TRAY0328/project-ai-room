/**
 * @ai-room/contracts — the single shared contract surface for PROJECT AI ROOM.
 *
 * Consumers: gateway-worker (HTTP), room-do / collab-do (WebSocket),
 * provider-adapters (AI connections), github-integration, job-orchestrator,
 * web client. Change here first, then let TypeScript point at every caller.
 */
export * from "./ids.js";
export * from "./time.js";
export * from "./errors.js";
export * from "./permissions.js";
export * from "./lifecycle.js";
export * from "./events.js";
export * from "./provider.js";
export * from "./api.js";
export { API_CATALOG, API_CATALOG_COUNT } from "./api-catalog.generated.js";

import { API_CATALOG, API_CATALOG_COUNT } from "./api-catalog.generated.js";
import { ERROR_CODES } from "./errors.js";
import { EVENT_TYPES } from "./events.js";
import { VERIFIED_CAPABILITIES } from "./provider.js";
import { PERMISSION_ACTIONS } from "./permissions.js";
import { TASK_STATES } from "./lifecycle.js";

/** Machine-readable summary of the contract surface; used by verify scripts. */
export const CONTRACT_MANIFEST = {
  contract_version: "2026-11-21.1",
  api_endpoints: API_CATALOG_COUNT,
  api_groups: [...new Set(API_CATALOG.map((endpoint) => endpoint.group))],
  error_codes: ERROR_CODES.length,
  event_types: EVENT_TYPES.length,
  permission_actions: PERMISSION_ACTIONS.length,
  provider_capabilities: VERIFIED_CAPABILITIES.length,
  task_states: TASK_STATES.length,
} as const;
