/**
 * Chat surface helpers.
 *
 * A messenger reader needs a clock, not a relative timestamp: "오전 8:43" is the
 * time of the message, "3일 전" is a debug reading. Day separators group a
 * history the same way every messenger does, so the conversation reads as days
 * and not as one endless scroll.
 */
import type { MessageDto } from "../api/types.js";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

function asDate(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 24h → the Korean 12h spelling a chat bubble uses. */
export function chatTime(iso: string): string {
  const date = asDate(iso);
  if (date === null) return "";
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const period = hours < 12 ? "오전" : "오후";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${period} ${hour12}:${minutes}`;
}

/** "오늘" / "어제" / "11월 20일 목요일" — the label a day break carries. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const date = asDate(iso);
  if (date === null) return "";
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (dayDiff === 0) return "오늘";
  if (dayDiff === 1) return "어제";
  const label = `${date.getMonth() + 1}월 ${date.getDate()}일 ${WEEKDAYS[date.getDay()] ?? ""}요일`;
  return date.getFullYear() === now.getFullYear() ? label : `${date.getFullYear()}년 ${label}`;
}

/**
 * "2026년 11월 23일 월요일" — the capsule a KakaoTalk room puts between days.
 *
 * Unlike `dayLabel` it never says "오늘": in a messenger the date capsule is the
 * calendar itself, so a reader can tell the day without knowing when they opened
 * the room.
 */
export function kakaoDayLabel(iso: string): string {
  const date = asDate(iso);
  if (date === null) return "";
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일 ${WEEKDAYS[date.getDay()] ?? ""}요일`;
}

/** True when the two instants are on the same local day. */
export function sameDay(a: string, b: string): boolean {
  const left = asDate(a);
  const right = asDate(b);
  if (left === null || right === null) return false;
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

/** The readable body of a message, used by "복사" — never the block JSON. */
export function plainTextOf(message: MessageDto): string {
  const parts: string[] = [];
  for (const block of message.blocks) {
    const payload = block.payload;
    const text =
      typeof payload["markdown"] === "string"
        ? payload["markdown"]
        : typeof payload["text"] === "string"
          ? payload["text"]
          : typeof payload["code"] === "string"
            ? String(payload["code"])
            : null;
    if (text !== null && text.trim().length > 0) parts.push(text.trim());
  }
  return parts.join("\n\n");
}

/** Two characters at most, the way a chat avatar is drawn. */
export function initialsOf(name: string): string {
  const chars = Array.from(name.trim());
  if (chars.length === 0) return "?";
  return chars.slice(0, 2).join("");
}

/** A short single-line preview for a quoted reply. */
export function excerptOf(message: MessageDto, max = 90): string {
  const text = plainTextOf(message).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
