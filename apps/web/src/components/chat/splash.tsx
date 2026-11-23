/**
 * The splash — the room's real loading screen.
 *
 * It is not a timer: every step watches the actual work the room does on entry
 * (the gateway/session probe, the room list, the first message page, the
 * realtime channel) and the bar moves when that work settles. A fast visit
 * still gets a beat per step, so the screen never flashes; a slow server keeps
 * the true step on screen until it answers.
 */
import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@ai-room/design-system";

export interface SplashStage {
  /** Share of the bar this step is worth; the steps sum to 100. */
  weight: number;
  label: string;
  icon: IconName;
}

export const SPLASH_STAGES: readonly SplashStage[] = Object.freeze([
  { weight: 20, label: "세션 및 보안 상태 확인 중…", icon: "lock" },
  { weight: 25, label: "채팅방 목록과 참여자 불러오는 중…", icon: "rooms" },
  { weight: 35, label: "최근 메시지 동기화 중…", icon: "chat" },
  { weight: 15, label: "실시간 채널 연결 중…", icon: "wifi" },
] as const);

export const SPLASH_DONE_LABEL = "채팅방 준비 완료!";

/** Which steps have settled, one flag per stage in `SPLASH_STAGES` order. */
export interface SplashProgress {
  settled: boolean[];
  /** Every step answered: the bar closes and the room shows itself. */
  finished: boolean;
}

/**
 * Read the room's real bootstrap from the states the screen already holds.
 * A step is settled when its request answered — any answer counts, including
 * "로그인 필요": the splash reports loading, not permission.
 */
export function splashProgress(input: {
  demoMode: boolean;
  connectionState: string;
  roomsState: string;
  messagesState: string;
  streamState: string;
}): SplashProgress {
  const { demoMode, connectionState, roomsState, messagesState, streamState } = input;
  const notPending = (state: string): boolean =>
    demoMode || (state !== "idle" && state !== "loading" && state !== "checking");
  const connectionSettled = demoMode || (connectionState !== "checking" && connectionState !== "unconfigured");
  // The room is readable as soon as its page is drawn; the socket finishes its
  // handshake a moment later and the header reports that state honestly. Holding
  // the door for the handshake made the splash 500ms longer than the content.
  const streamSettled =
    demoMode ||
    connectionState === "unauthenticated" ||
    connectionState === "unconfigured" ||
    connectionState === "unreachable" ||
    streamState !== "idle";
  const settled = [connectionSettled, notPending(roomsState), notPending(messagesState), streamSettled];
  return { settled, finished: settled.every(Boolean) };
}

/** The bar's target: the leading run of settled steps, 100 once all answered. */
export function splashTarget(progress: SplashProgress): number {
  if (progress.finished) return 100;
  let sum = 0;
  for (let i = 0; i < SPLASH_STAGES.length; i += 1) {
    if (!progress.settled[i]) break;
    sum += SPLASH_STAGES[i]!.weight;
  }
  return sum;
}

/** The step on screen: the first one that has not settled yet. */
export function splashStageIndex(progress: SplashProgress): number {
  if (progress.finished) return SPLASH_STAGES.length;
  const index = progress.settled.indexOf(false);
  return index === -1 ? SPLASH_STAGES.length : index;
}

/**
 * The visible percent chases the target instead of jumping to it, so a fast
 * bootstrap still reads as motion and a slow step holds its number. Once every
 * step has answered the splash holds until it has been up long enough to read,
 * then reports `exiting` (the slide-out begins) and finally calls `onDone` —
 * the wait is the exit, not the work.
 */
export function useSplash(
  target: number,
  finished: boolean,
  onDone: () => void,
  minVisibleMs = 720,
): { percent: number; exiting: boolean } {
  const [displayed, setDisplayed] = useState(0);
  const [exiting, setExiting] = useState(false);
  const targetRef = useRef(target);
  targetRef.current = target;
  const finishedRef = useRef(finished);
  finishedRef.current = finished;
  const mountedAt = useRef(0);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    mountedAt.current = Date.now();
    let raf = 0;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      setDisplayed((prev) => {
        const goal = targetRef.current;
        // Once every step has answered the number closes briskly — a bar at 60%
        // under a "준비 완료" label would read as a lie.
        const next = prev + (goal - prev) * (finishedRef.current ? 0.45 : 0.16);
        return goal - next < 0.4 ? goal : next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    if (!finished) return;
    const remaining = Math.max(0, minVisibleMs - (Date.now() - mountedAt.current));
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    timers.push(
      setTimeout(() => {
        setDisplayed(100);
        setExiting(true);
        timers.push(setTimeout(() => doneRef.current(), 420));
      }, remaining),
    );
    return () => timers.forEach(clearTimeout);
  }, [finished, minVisibleMs]);

  return { percent: displayed, exiting };
}

export function SplashScreen({ percent, stageIndex, exiting }: { percent: number; stageIndex: number; exiting: boolean }) {
  const shown = Math.round(percent);
  const stage = SPLASH_STAGES[Math.min(stageIndex, SPLASH_STAGES.length - 1)]!;
  const done = stageIndex >= SPLASH_STAGES.length;
  const label = done ? SPLASH_DONE_LABEL : stage.label;
  const icon: IconName = done ? "check" : stage.icon;

  return (
    <div className="air-splash" data-state={exiting ? "exit" : "in"} role="status" aria-live="polite" aria-label={`로딩 ${shown}% · ${label}`}>
      <div className="air-splash-aurora" aria-hidden="true">
        <span /><span /><span />
      </div>
      <div className="air-splash-stars" aria-hidden="true">
        <span /><span /><span /><span /><span /><span /><span /><span />
      </div>
      <div className="air-splash-card">
        <div className="air-splash-emblem" aria-hidden="true">
          <span className="air-splash-emblem-compass" />
          <span className="air-splash-emblem-ring" />
          <span className="air-splash-emblem-ring air-splash-emblem-ring-delay" />
          <span className="air-splash-emblem-face">
            <Icon name={icon} size={26} />
          </span>
        </div>
        <div className="air-splash-brand">AI ROOM</div>
        <div className="air-splash-sub">PROJECT AI ROOM · cloud-only</div>

        <div className="air-splash-bar" aria-hidden="true">
          <div className="air-splash-bar-fill" style={{ width: `${shown}%` }} />
        </div>
        <div className="air-splash-row">
          <span className="air-splash-percent" data-done={done || undefined}>
            <span className="air-splash-percent-value">{shown}</span>
            <span className="air-splash-percent-unit">%</span>
          </span>
          <span className="air-splash-step" key={label} data-done={done || undefined}>
            <span className="air-splash-step-icon" aria-hidden="true">
              <Icon name={icon} size={13} />
            </span>
            {label}
          </span>
        </div>
      </div>
      <div className="air-splash-foot" aria-hidden="true">카카오톡 스타일 대화방 · 실시간 협업</div>
    </div>
  );
}
