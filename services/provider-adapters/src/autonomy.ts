/**
 * Autonomy guards — spec 08.2, 08.3, 08.5, S19, S30, E2E-09.
 *
 * Three modes exist because "let the AIs talk" has three different risk
 * profiles. Every limit below is a server-side check: a prompt asking an AI to
 * behave cannot disable it.
 *
 *   FAST    — short replies, few turns, cheapest: for status pings.
 *   NATURAL — human-like pacing, the default for a working room.
 *   ECO     — the strictest: cost first, one long turn instead of many short ones.
 */
export type AutonomyMode = "FAST" | "NATURAL" | "ECO";

export interface AutonomyLimits {
  readonly mode: AutonomyMode;
  readonly max_messages_per_thread: number;
  readonly max_consecutive_agent_turns: number;
  readonly max_chain_depth: number;
  readonly duplicate_similarity_threshold: number;
  readonly agent_cooldown_ms: number;
  readonly max_parallel_tasks: number;
  readonly per_agent_daily_budget: number;
  readonly project_budget: number;
  readonly max_turn_tokens: number;
}

export const AUTONOMY_LIMITS: Readonly<Record<AutonomyMode, AutonomyLimits>> = {
  FAST: {
    mode: "FAST",
    max_messages_per_thread: 12,
    max_consecutive_agent_turns: 2,
    max_chain_depth: 2,
    duplicate_similarity_threshold: 0.9,
    agent_cooldown_ms: 1_500,
    max_parallel_tasks: 1,
    per_agent_daily_budget: 200,
    project_budget: 2_000,
    max_turn_tokens: 256,
  },
  NATURAL: {
    mode: "NATURAL",
    max_messages_per_thread: 60,
    max_consecutive_agent_turns: 4,
    max_chain_depth: 4,
    duplicate_similarity_threshold: 0.85,
    agent_cooldown_ms: 5_000,
    max_parallel_tasks: 2,
    per_agent_daily_budget: 400,
    project_budget: 4_000,
    max_turn_tokens: 700,
  },
  ECO: {
    mode: "ECO",
    max_messages_per_thread: 20,
    max_consecutive_agent_turns: 1,
    max_chain_depth: 1,
    duplicate_similarity_threshold: 0.7,
    agent_cooldown_ms: 20_000,
    max_parallel_tasks: 1,
    per_agent_daily_budget: 120,
    project_budget: 1_000,
    max_turn_tokens: 400,
  },
};

export type GuardReason =
  | "ALLOWED"
  | "HUMAN_TURN_RESET"
  | "THREAD_MESSAGE_LIMIT"
  | "CONSECUTIVE_TURN_LIMIT"
  | "CHAIN_DEPTH_LIMIT"
  | "DUPLICATE_MESSAGE"
  | "PING_PONG_LOOP"
  | "COOLDOWN"
  | "PARALLEL_TASK_LIMIT"
  | "AGENT_BUDGET_EXHAUSTED"
  | "PROJECT_BUDGET_EXHAUSTED"
  | "EMERGENCY_STOP";

export interface TurnRequest {
  readonly mode: AutonomyMode;
  /** Consecutive agent messages with no human message in between. */
  readonly consecutiveAgentTurns: number;
  /** Messages already in this thread. */
  readonly threadMessageCount: number;
  /** How many replies deep this message is (`reply_to` chain). */
  readonly chainDepth: number;
  readonly lastAgentMessageText: string | null;
  readonly proposedText: string;
  readonly msSinceAgentLastSpoke: number;
  readonly agentDailyUsed: number;
  readonly projectUsed: number;
  readonly agentParallelTasks: number;
  readonly recentAuthors: readonly string[];
  readonly nowMs?: number;
  readonly emergencyStop?: boolean;
}

export interface GuardVerdict {
  readonly allowed: boolean;
  readonly reason: GuardReason;
  readonly limits: AutonomyLimits;
}

/** Token-set Jaccard; cheap, deterministic, good enough to catch a repeat. */
export function similarity(a: string, b: string): number {
  const tokenize = (text: string): Set<string> => new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean));
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export class AutonomyGuard {
  readonly limits: AutonomyLimits;

  constructor(mode: AutonomyMode) {
    this.limits = AUTONOMY_LIMITS[mode];
  }

  check(request: TurnRequest): GuardVerdict {
    const limits = this.limits;
    const allow = (reason: GuardReason): GuardVerdict => ({ allowed: true, reason, limits });
    const deny = (reason: GuardReason): GuardVerdict => ({ allowed: false, reason, limits });

    if (request.emergencyStop === true) return deny("EMERGENCY_STOP");
    if (request.consecutiveAgentTurns === 0) return allow("HUMAN_TURN_RESET");
    if (request.threadMessageCount >= limits.max_messages_per_thread) return deny("THREAD_MESSAGE_LIMIT");
    if (request.consecutiveAgentTurns >= limits.max_consecutive_agent_turns) return deny("CONSECUTIVE_TURN_LIMIT");
    if (request.chainDepth > limits.max_chain_depth) return deny("CHAIN_DEPTH_LIMIT");
    if (request.agentDailyUsed >= limits.per_agent_daily_budget) return deny("AGENT_BUDGET_EXHAUSTED");
    if (request.projectUsed >= limits.project_budget) return deny("PROJECT_BUDGET_EXHAUSTED");
    if (request.agentParallelTasks >= limits.max_parallel_tasks) return deny("PARALLEL_TASK_LIMIT");
    if (request.msSinceAgentLastSpoke < limits.agent_cooldown_ms) return deny("COOLDOWN");
    if (request.lastAgentMessageText !== null) {
      const score = similarity(request.lastAgentMessageText, request.proposedText);
      if (score >= limits.duplicate_similarity_threshold) return deny("DUPLICATE_MESSAGE");
    }
    // A ping-pong is two authors alternating more than the chain limit permits.
    const distinctRecent = new Set(request.recentAuthors.slice(-6));
    if (request.chainDepth >= limits.max_chain_depth && distinctRecent.size <= 2) return deny("PING_PONG_LOOP");
    return allow("ALLOWED");
  }
}

/**
 * Loop detector over a message log: flags a pair of agents echoing each other
 * and a single agent repeating itself. Returns evidence, never a verdict.
 */
export function detectLoops(
  messages: readonly { author_id: string; body: string }[],
  threshold = 0.85,
): { repeated: boolean; pingPong: boolean; evidence: string[] } {
  const evidence: string[] = [];
  let repeated = false;
  for (let index = 1; index < messages.length; index += 1) {
    const previous = messages[index - 1];
    const current = messages[index];
    if (previous === undefined || current === undefined) continue;
    if (similarity(previous.body, current.body) >= threshold) {
      repeated = true;
      evidence.push(`similar@${index}`);
    }
  }
  const lastSix = messages.slice(-6);
  const authors = [...new Set(lastSix.map((message) => message.author_id))];
  const pingPong = lastSix.length === 6 && authors.length === 2 && lastSix.every((message, index) => index === 0 || message.author_id !== lastSix[index - 1]?.author_id);
  if (pingPong) evidence.push("alternating-two-authors");
  return { repeated, pingPong, evidence };
}
