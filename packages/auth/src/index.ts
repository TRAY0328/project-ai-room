/**
 * @ai-room/auth — identity, credentials, sessions, WS tickets, attempt budgets.
 *
 * The single place that decides "who is this caller" for HTTP, WebSocket,
 * signed downloads and internal service calls. Authorization is separate
 * (packages/permissions) so the same authentication result feeds every surface.
 */
export * from "./db.js";
export * from "./crypto.js";
export * from "./tokens.js";
export * from "./rate-limit.js";
export * from "./service.js";
