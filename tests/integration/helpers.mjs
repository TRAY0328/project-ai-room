/**
 * Shared integration harness: a real SQLite database with the real migration, the
 * real gateway worker, a fake R2 and a fake GitHub App client.
 *
 * The fakes are only transports. Every decision (ACL, approval, SHA binding,
 * hash verification) still runs in the worker; the fake records calls so a test
 * can assert *what* was asked of the outside world.
 */
import { createTestDb, createCaller, createFakeR2, seedBase, T0 } from "../../packages/testing/index.mjs";
import gateway from "../../services/gateway-worker/dist/index.js";

export const SIGNING_KEY = "test-session-signing-key-0123456789abcdef";
export const WS_KEY = "test-ws-ticket-key-0123456789abcdef";
export const INVITE_SECRET = "test-agent-invite-secret-0123456789";
export const BOOTSTRAP_SECRET = "test-owner-bootstrap-secret-0123456789";
export const WEBHOOK_SECRET = "test-github-webhook-secret-0123456789";
export const OWNER_PASSWORD = "correct-horse-battery-staple";

export function createFakeGitHub(options = {}) {
  const state = {
    branches: new Map([["main", options.baseSha ?? "a".repeat(40)]]),
    pulls: new Map(),
    reviews: [],
    merges: [],
    dispatches: [],
    cancels: [],
    commits: [],
    runs: new Map(),
    logs: options.logs ?? "line 1\ntoken=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nline 3",
    nextPr: 1,
  };
  return {
    state,
    provider: "fake-github",
    async listBranches() {
      return [...state.branches.entries()].map(([name, sha]) => ({ name, sha }));
    },
    async createBranch({ branch, fromSha }) {
      state.branches.set(branch, fromSha);
      return { ref: `refs/heads/${branch}`, sha: fromSha };
    },
    async openPullRequest({ head, base, title }) {
      const number = state.nextPr++;
      const headSha = state.branches.get(head) ?? "b".repeat(40);
      const baseSha = state.branches.get(base) ?? "a".repeat(40);
      state.pulls.set(number, { number, head, base, title, head_sha: headSha, url: `https://github.test/pull/${number}` });
      return { number, url: `https://github.test/pull/${number}`, head_sha: headSha, base_sha: baseSha };
    },
    async submitReview({ number, commitSha, verdict }) {
      state.reviews.push({ number, commitSha, verdict });
      return { review_id: `fake-review-${state.reviews.length}`, state: verdict === "APPROVE" ? "APPROVED" : "COMMENTED" };
    },
    async mergePullRequest({ number, expectedHeadSha, method }) {
      const pr = state.pulls.get(number);
      if (pr === undefined) return { merged: false, merge_sha: null, message: "missing" };
      if (pr.head_sha !== expectedHeadSha) return { merged: false, merge_sha: null, message: "head moved" };
      state.merges.push({ number, expectedHeadSha, method });
      state.branches.set(pr.base, "c".repeat(40));
      return { merged: true, merge_sha: "c".repeat(40), message: "merged" };
    },
    async dispatchWorkflow({ workflowFile, ref }) {
      state.dispatches.push({ workflowFile, ref });
      const runId = 700 + state.dispatches.length;
      state.runs.set(runId, { id: runId, name: workflowFile, head_sha: state.branches.get(ref) ?? "", status: "queued", conclusion: null, created_at: T0 });
      return { dispatched: true, run_id: runId };
    },
    async cancelRun({ runId }) {
      state.cancels.push({ runId });
      return { cancelled: true };
    },
    async getRun({ runId }) {
      return state.runs.get(runId) ?? null;
    },
    async getRunLogs() {
      return { log: state.logs };
    },
    async createCommit({ branch, path, content, message, baseSha }) {
      const sha = String(state.commits.length + 1).padStart(40, "d");
      state.commits.push({ branch, path, content, message, baseSha, sha });
      state.branches.set(branch, sha);
      return { commit_sha: sha, blob_sha: sha.slice(0, 40) };
    },
  };
}

export async function setup(options = {}) {
  const { db, raw, close } = await createTestDb();
  const r2 = options.r2 === false ? undefined : createFakeR2();
  const github = options.github === false ? undefined : (options.github ?? createFakeGitHub(options.githubOptions ?? {}));
  const env = {
    APP_ENV: "test",
    DB: db,
    ...(r2 === undefined ? {} : { R2: r2 }),
    ...(github === undefined ? {} : { GITHUB: github }),
    SESSION_SIGNING_KEY: SIGNING_KEY,
    WS_TICKET_SIGNING_KEY: WS_KEY,
    AGENT_INVITE_SECRET: INVITE_SECRET,
    OWNER_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET,
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    NOW_MS: Date.parse("2026-11-21T03:00:00.000Z"),
  };
  const call = createCaller(gateway, env);

  const bootstrap = await call("POST", "/api/v1/owner/bootstrap", {
    idempotencyKey: "bootstrap-0000001",
    body: {
      display_name: "천예준",
      email: "owner@example.test",
      password: OWNER_PASSWORD,
      bootstrap_secret: BOOTSTRAP_SECRET,
    },
  });
  if (bootstrap.status !== 201) throw new Error(`bootstrap failed: ${bootstrap.text}`);
  env.OWNER_PASSWORD_VERIFIER = bootstrap.json.data.password_verifier;
  const invite = bootstrap.json.data.invite;

  const login = await call("POST", "/api/v1/auth/login", { body: { email: "owner@example.test", password: OWNER_PASSWORD } });
  if (login.status !== 200) throw new Error(`login failed: ${login.text}`);
  const ownerToken = login.json.data.session.access_token;
  const roomId = bootstrap.json.data.default_room_id;

  let registerCount = 0;
  async function registerAgent(name, extra = {}) {
    registerCount += 1;
    const response = await call("POST", "/api/v1/agents/register", {
      idempotencyKey: `register-agent-${String(registerCount).padStart(4, "0")}`,
      body: {
        invite_secret: INVITE_SECRET,
        display_name: name,
        avatar_asset_id: "art_A1B2C3D4E5F6G7H8JKMNPQRSTV",
        claimed_provider: name.toLowerCase(),
        description: `${name} 테스트 에이전트`,
        ...extra,
      },
    });
    if (response.status !== 201) throw new Error(`register failed: ${response.text}`);
    return {
      agentId: response.json.data.agent.agent_id,
      key: response.json.data.credential.agent_key,
      token: response.json.data.session.access_token,
    };
  }

  async function createProject(name = "PROJECT AI ROOM", agentIds = []) {
    const response = await call("POST", "/api/v1/projects", { token: ownerToken, body: { name, description: "통합 테스트", room_ids: [roomId] } });
    if (response.status !== 201) throw new Error(`project failed: ${response.text}`);
    const projectId = response.json.data.project_id;
    for (const agentId of agentIds) {
      const grant = await call("POST", `/api/v1/projects/${projectId}/members`, { token: ownerToken, body: { actor_kind: "agent", actor_id: agentId, role: "contributor" } });
      if (grant.status !== 201) throw new Error(`member grant failed: ${grant.text}`);
    }
    return projectId;
  }

  return { db, raw, close, env, call, ownerToken, roomId, invite, registerAgent, createProject, r2, github };
}

/** Seeds the owner row only (used by tests that assert bootstrap behaviour). */
export function seedOwnerOnly(raw) {
  seedBase(raw);
}
