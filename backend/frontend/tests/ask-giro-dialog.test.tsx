import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AskGiroDialog,
  askGiroDraft,
  askGiroSessionTitle,
  chatHandoffUrl,
  type AskGiroTarget,
} from "@/features/repositories/ask-giro-dialog";
import { repositoryExplorerItemKey } from "@/lib/repository-explorer";
import { session } from "./fixtures";

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  create: {
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null as unknown,
  },
  sessions: {
    data: { sessions: [] as Array<Record<string, unknown>> },
    isLoading: false,
    isError: false,
    error: null as unknown,
    refetch: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.routerPush }) }));
vi.mock("@/hooks/use-sessions", () => ({
  useCreateSession: () => mocks.create,
  useSessions: () => mocks.sessions,
}));

const item = {
  name: "server",
  path: "src/index.ts",
  kind: "entrypoint",
  category: "entrypoints",
  categoryLabel: "Entry points",
  key: repositoryExplorerItemKey("entrypoints", {
    name: "server",
    path: "src/index.ts",
    kind: "entrypoint",
  }),
};

const target: AskGiroTarget = {
  kind: "repository-item",
  item,
  location: { kind: "explorer", tab: "architecture" },
};

const matchingSession = {
  id: session.id,
  userId: session.userId,
  owner: "acme",
  repo: "platform",
  title: "Platform exploration",
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  messageCount: 2,
};

describe("Ask Giro session chooser", () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  });

  beforeEach(() => {
    mocks.routerPush.mockReset();
    mocks.create.mutateAsync.mockReset();
    mocks.create.isPending = false;
    mocks.create.isError = false;
    mocks.create.error = null;
    mocks.sessions.data = {
      sessions: [
        matchingSession,
        { ...matchingSession, id: "other-session", owner: "other", title: "Other repository" },
      ],
    };
    mocks.sessions.isLoading = false;
    mocks.sessions.isError = false;
    mocks.sessions.error = null;
  });

  it("shows only sessions for the selected repository and supports cancel", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>Open chooser</button>{open ? <AskGiroDialog open owner="acme" repo="platform" target={target} onClose={() => setOpen(false)} /> : null}</>;
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open chooser" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Ask Giro about this");
    expect(screen.getByRole("radio", { name: /Platform exploration/ })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Other repository/ })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /New session/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open chooser" }));
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a chosen existing session once without creating a session", () => {
    render(<AskGiroDialog open owner="acme" repo="platform" target={target} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: /Platform exploration/ }));
    const continueButton = screen.getByRole("button", { name: "Continue" });
    fireEvent.click(continueButton);
    fireEvent.click(continueButton);

    expect(mocks.create.mutateAsync).not.toHaveBeenCalled();
    expect(mocks.routerPush).toHaveBeenCalledTimes(1);
    expect(mocks.routerPush).toHaveBeenCalledWith(chatHandoffUrl(session.id, "acme", "platform", target));
  });

  it("creates one repository-scoped session and navigates once after success", async () => {
    let resolveCreate!: (value: typeof session) => void;
    mocks.create.mutateAsync.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve; }));
    render(<AskGiroDialog open owner="acme" repo="platform" target={target} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: /New session/ }));
    const continueButton = screen.getByRole("button", { name: "Continue" });
    fireEvent.click(continueButton);
    fireEvent.click(continueButton);

    expect(mocks.create.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.create.mutateAsync).toHaveBeenCalledWith({ owner: "acme", repo: "platform", title: "server" });
    expect(mocks.routerPush).not.toHaveBeenCalled();
    await act(async () => resolveCreate(session));
    expect(mocks.routerPush).toHaveBeenCalledTimes(1);
    expect(mocks.routerPush).toHaveBeenCalledWith(chatHandoffUrl(session.id, "acme", "platform", target));
  });

  it("keeps the dialog open and announces a session creation failure", async () => {
    mocks.create.mutateAsync.mockRejectedValueOnce(new Error("Creation failed"));
    const view = render(<AskGiroDialog open owner="acme" repo="platform" target={target} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: /New session/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(mocks.create.mutateAsync).toHaveBeenCalledTimes(1));

    mocks.create.isError = true;
    mocks.create.error = new Error("Creation failed");
    view.rerender(<AskGiroDialog open owner="acme" repo="platform" target={target} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Please try again.");
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("preserves indexed-evidence identity without embedding its content", () => {
    const evidenceTarget: AskGiroTarget = {
      kind: "indexed-evidence",
      query: "authentication",
      resultKey: "evidence:auth-chunk",
      result: {
        repository: "acme/platform",
        filePath: "src/auth.ts",
        language: "typescript",
        content: "sensitive excerpt",
        startLine: 1,
        endLine: 4,
        score: 0.8,
        source: "symbol",
        signals: { symbol: 0.8 },
        symbol: "authenticate",
      },
    };

    const url = chatHandoffUrl("session-2", "acme", "platform", evidenceTarget);
    expect(askGiroSessionTitle(evidenceTarget)).toBe("authenticate");
    expect(url).toContain("draft=Explain+how+authenticate+in+src%2Fauth.ts+works.");
    expect(url).toContain("from=%2Frepositories%2Facme%2Fplatform%2Fsearch%3Fq%3Dauthentication%26result%3Devidence%253Aauth-chunk");
    expect(url).not.toContain("sensitive");
  });

  it("generates drafts only from selected item fields", () => {
    expect(askGiroDraft(target)).toBe("Explain how execution begins at src/index.ts.");
    expect(askGiroDraft({
      kind: "indexed-evidence",
      query: "startup",
      resultKey: "evidence:start",
      result: {
        repository: "acme/platform",
        filePath: "src/start.ts",
        language: "typescript",
        content: "bootstrap();",
        startLine: 12,
        endLine: 18,
        score: 0.7,
        source: "semantic",
        signals: { semantic: 0.7 },
      },
    })).toBe("Explain the code in src/start.ts, lines 12-18.");
  });
});
