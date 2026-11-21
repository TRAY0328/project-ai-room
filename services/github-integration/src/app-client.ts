/**
 * GitHub App REST client — spec 14.1, 24, 13.3.
 *
 * This is the only place that talks to github.com. It implements the narrow
 * `GitHubClient` surface the gateway needs, with:
 *  - a token provider (installation token minted elsewhere, never bundled);
 *  - an explicit User-Agent, API version and timeout;
 *  - errors mapped to typed failures so a 403 is not mistaken for a success;
 *  - no retry of non-idempotent writes except where GitHub accepts the same
 *    request idempotently (merge uses expected head SHA).
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubClientOptions {
  readonly fetch?: FetchLike;
  readonly tokenProvider: () => Promise<string>;
  readonly apiBase?: string;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(`GitHub API ${status}: ${detail}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.detail = detail;
  }
}

export interface GitHubRunSummary {
  readonly id: number;
  readonly name: string;
  readonly head_sha: string;
  readonly status: "queued" | "in_progress" | "completed" | "requested" | "waiting" | "unknown";
  readonly conclusion: "success" | "failure" | "cancelled" | "timed_out" | "startup_failure" | "action_required" | "neutral" | "skipped" | "stale" | null;
  readonly created_at: string;
}

export class GitHubAppClient {
  private readonly options: GitHubClientOptions;

  constructor(options: GitHubClientOptions) {
    this.options = options;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const doFetch = this.options.fetch ?? ((input, init) => fetch(input, init));
    const token = await this.options.tokenProvider();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    try {
      const response = await doFetch(`${this.options.apiBase ?? "https://api.github.com"}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
          "user-agent": this.options.userAgent ?? "ai-room-worker",
        },
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (!response.ok) throw new GitHubApiError(response.status, text.slice(0, 500));
      return (text.length === 0 ? {} : JSON.parse(text)) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async listBranches(input: { owner: string; repo: string }): Promise<{ name: string; sha: string }[]> {
    const data = await this.request<{ name: string; commit: { sha: string } }[]>("GET", `/repos/${input.owner}/${input.repo}/branches?per_page=100`);
    return data.map((branch) => ({ name: branch.name, sha: branch.commit.sha }));
  }

  async createBranch(input: { owner: string; repo: string; branch: string; fromSha: string }): Promise<{ ref: string; sha: string }> {
    const data = await this.request<{ ref: string; object: { sha: string } }>("POST", `/repos/${input.owner}/${input.repo}/git/refs`, {
      ref: `refs/heads/${input.branch}`,
      sha: input.fromSha,
    });
    return { ref: data.ref, sha: data.object.sha };
  }

  async openPullRequest(input: { owner: string; repo: string; head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string; head_sha: string; base_sha: string }> {
    const data = await this.request<{ number: number; html_url: string; head: { sha: string }; base: { sha: string } }>(
      "POST",
      `/repos/${input.owner}/${input.repo}/pulls`,
      { head: input.head, base: input.base, title: input.title, body: input.body },
    );
    return { number: data.number, url: data.html_url, head_sha: data.head.sha, base_sha: data.base.sha };
  }

  async submitReview(input: { owner: string; repo: string; number: number; commitSha: string; verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string }): Promise<{ review_id: string; state: string }> {
    const data = await this.request<{ id: number; state: string }>("POST", `/repos/${input.owner}/${input.repo}/pulls/${input.number}/reviews`, {
      commit_id: input.commitSha,
      event: input.verdict,
      body: input.body,
    });
    return { review_id: String(data.id), state: data.state };
  }

  /** Merge is conditional on the exact head SHA GitHub reports. */
  async mergePullRequest(input: { owner: string; repo: string; number: number; expectedHeadSha: string; method: "squash" | "merge" | "rebase" }): Promise<{ merged: boolean; merge_sha: string | null; message: string }> {
    try {
      const data = await this.request<{ merged: boolean; sha: string; message: string }>("PUT", `/repos/${input.owner}/${input.repo}/pulls/${input.number}/merge`, {
        sha: input.expectedHeadSha,
        merge_method: input.method,
      });
      return { merged: data.merged, merge_sha: data.merged ? data.sha : null, message: data.message };
    } catch (error) {
      if (error instanceof GitHubApiError && (error.status === 405 || error.status === 409)) {
        return { merged: false, merge_sha: null, message: `provider refused (${error.status})` };
      }
      throw error;
    }
  }

  async dispatchWorkflow(input: { owner: string; repo: string; workflowFile: string; ref: string; inputs: Record<string, string> }): Promise<{ dispatched: boolean; run_id: number | null }> {
    await this.request("POST", `/repos/${input.owner}/${input.repo}/actions/workflows/${encodeURIComponent(input.workflowFile)}/dispatches`, {
      ref: input.ref,
      inputs: input.inputs,
    });
    // A 204 means accepted; the run id appears later in workflow_run webhooks.
    return { dispatched: true, run_id: null };
  }

  async cancelRun(input: { owner: string; repo: string; runId: number }): Promise<{ cancelled: boolean }> {
    try {
      await this.request("POST", `/repos/${input.owner}/${input.repo}/actions/runs/${input.runId}/cancel`);
      return { cancelled: true };
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 409) return { cancelled: false };
      throw error;
    }
  }

  async getRun(input: { owner: string; repo: string; runId: number }): Promise<GitHubRunSummary | null> {
    try {
      return await this.request<GitHubRunSummary>("GET", `/repos/${input.owner}/${input.repo}/actions/runs/${input.runId}`);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  async getRunLogs(input: { owner: string; repo: string; runId: number }): Promise<{ log: string }> {
    const doFetch = this.options.fetch ?? ((input2, init) => fetch(input2, init));
    const token = await this.options.tokenProvider();
    const response = await doFetch(`${this.options.apiBase ?? "https://api.github.com"}/repos/${input.owner}/${input.repo}/actions/runs/${input.runId}/logs`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": this.options.userAgent ?? "ai-room-worker",
      },
    });
    if (!response.ok) throw new GitHubApiError(response.status, "logs unavailable");
    return { log: await response.text() };
  }

  /** Content API commit: one file, explicit base blob, explicit message. */
  async createCommit(input: { owner: string; repo: string; branch: string; path: string; content: string; message: string; baseSha: string }): Promise<{ commit_sha: string; blob_sha: string }> {
    const existing = await this.request<{ sha: string } | null>("GET", `/repos/${input.owner}/${input.repo}/contents/${encodeURIComponent(input.path)}?ref=${encodeURIComponent(input.baseSha)}`).catch(() => null);
    const data = await this.request<{ commit: { sha: string }; content: { sha: string } }>("PUT", `/repos/${input.owner}/${input.repo}/contents/${encodeURIComponent(input.path)}`, {
      message: input.message,
      content: btoa(unescape(encodeURIComponent(input.content))),
      branch: input.branch,
      ...(existing?.sha === undefined ? {} : { sha: existing.sha }),
    });
    return { commit_sha: data.commit.sha, blob_sha: data.content.sha };
  }
}
