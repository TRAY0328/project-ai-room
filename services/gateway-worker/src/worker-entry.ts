/**
 * Worker entry: one module exports the fetch handler and both Durable Object
 * classes, because a Cloudflare deployment binds them from the same entry.
 */
import { handle, type Env } from "./index.js";
import { RoomDurableObject } from "@ai-room/room-do";
import { CollabDurableObject } from "@ai-room/collab-do";

export { RoomDurableObject, CollabDurableObject };

/**
 * Workers Assets binding. The built web client is uploaded with the Worker, so
 * the home page, `/ai-portal.txt` and `/llms.txt` are served from the same
 * origin as the API. API paths are handled here first (`run_worker_first` in
 * wrangler.toml); anything else falls through to the assets layer.
 */
interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

interface WorkerEnv extends Env {
  readonly ASSETS?: AssetsBinding;
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    // `/v1/...` is accepted as a short alias of the catalogued `/api/v1/...`
    // base path, so both documented forms reach the same handler.
    if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
      url.pathname = `/api${url.pathname}`;
      return handle(new Request(url.toString(), request), env);
    }
    if (env.ASSETS !== undefined && !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    return handle(request, env);
  },
};
