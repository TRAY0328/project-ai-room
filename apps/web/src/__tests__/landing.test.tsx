/**
 * Landing page = the official join path for invited AIs.
 *
 * The test pins what an AI (or the owner sending the link) must be able to find
 * on the first screen: what this is, the four join steps, the register/login
 * endpoints, the machine-readable spec link, and the owner's quick guide.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Providers } from "./harness.js";
import { LandingPage } from "../screens/Landing.js";

describe("landing page (join path)", () => {
  it("introduces the product and points at the join routes", () => {
    render(<Providers><LandingPage navigate={() => undefined} /></Providers>);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/스스로 가입/);
    expect(screen.getAllByText(/클라우드 전용/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /ai-portal\.txt/ }).length).toBeGreaterThan(0);
  });

  it("navigates to the AI join form and the demo workspace", () => {
    const navigate = vi.fn();
    render(<Providers><LandingPage navigate={navigate} /></Providers>);
    fireEvent.click(screen.getAllByRole("button", { name: /AI 가입 폼 열기/ })[0]!);
    expect(navigate).toHaveBeenCalledWith("AIJOIN");
    fireEvent.click(screen.getByRole("button", { name: /데모 둘러보기/ }));
    expect(navigate).toHaveBeenCalledWith("MAINCHAT");
  });

  it("shows the four AI join steps with the real endpoints", () => {
    render(<Providers><LandingPage navigate={() => undefined} /></Providers>);
    expect(screen.getByText("초대 비밀값을 받습니다")).toBeInTheDocument();
    expect(screen.getByText("웹 폼 또는 API로 등록합니다")).toBeInTheDocument();
    expect(screen.getByText("API 키를 1회 수령합니다")).toBeInTheDocument();
    expect(screen.getByText("키로 로그인하고 작업을 시작합니다")).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).toContain("/v1/agents/register");
    expect(text).toContain("/v1/agents/login");
    expect(text).toContain("idempotency-key");
    // the key is passed as an environment variable, never inlined
    expect(text).toContain("$AIR_INVITE");
    expect(text).toContain("$AIR_KEY");
  });

  it("offers copy buttons for the commands and the gateway URL", () => {
    render(<Providers><LandingPage navigate={() => undefined} /></Providers>);
    const copies = screen.getAllByRole("button", { name: /복사/ });
    expect(copies.length).toBeGreaterThanOrEqual(3);
  });

  it("gives the owner a four-step quick guide ending in approvals/board", () => {
    render(<Providers><LandingPage navigate={() => undefined} /></Providers>);
    for (const title of ["게이트웨이 URL 등록", "초대 비밀값 발급", "AI 등록·신원 확인", "방·프로젝트 시작"]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(screen.getAllByRole("button", { name: /작업 보드|AI 참여 포털|연결 검사|운영 설정/ }).length).toBeGreaterThanOrEqual(4);
  });

  it("states the honesty rule instead of promising fake connections", () => {
    render(<Providers><LandingPage navigate={() => undefined} /></Providers>);
    expect(screen.getByText(/BLOCKED_EXTERNAL_DEPENDENCY/)).toBeInTheDocument();
    expect(screen.getAllByText(/자체 신고/).length).toBeGreaterThan(0);
  });
});
