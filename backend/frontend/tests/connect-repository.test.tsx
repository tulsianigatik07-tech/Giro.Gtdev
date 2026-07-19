import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectRepositoryForm, validateGitHubUrl } from "@/features/repositories/connect-repository-form";
import ConnectRepositoryPage from "@/app/(workspace)/repositories/connect/page";

const push = vi.fn();
const mutateAsync = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/hooks/use-repositories", () => ({ useConnectRepository: () => ({ mutateAsync, isPending: false, error: null }) }));

describe("repository connection", () => {
  beforeEach(() => { push.mockReset(); mutateAsync.mockReset(); });

  it("validates only full GitHub repository URLs", () => {
    expect(validateGitHubUrl("https://github.com/acme/platform")).toBeNull();
    expect(validateGitHubUrl("git@github.com:acme/platform.git")).toMatch(/full GitHub URL/);
    expect(validateGitHubUrl("https://example.com/acme/platform")).toMatch(/full GitHub URL/);
  });

  it("shows validation without issuing an API request", () => {
    render(<ConnectRepositoryForm />);
    fireEvent.change(screen.getByLabelText("HTTPS GitHub repository URL"), { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect and index" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a full GitHub URL");
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("connects and redirects to live indexing progress", async () => {
    mutateAsync.mockResolvedValue({ repositoryId: "acme/platform", jobId: "job-1", status: "queued" });
    render(<ConnectRepositoryForm />);
    fireEvent.change(screen.getByLabelText("HTTPS GitHub repository URL"), { target: { value: "https://github.com/acme/platform" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect and index" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/repositories/acme/platform/indexing?jobId=job-1"));
  });

  it("opens an already indexed healthy repository without an indexing redirect", async () => {
    mutateAsync.mockResolvedValue({ repositoryId: "acme/platform", status: "already_indexed" });
    render(<ConnectRepositoryForm />);
    fireEvent.change(screen.getByLabelText("HTTPS GitHub repository URL"), { target: { value: "https://github.com/acme/platform" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect and index" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/repositories/acme/platform"));
  });

  it("prevents duplicate connection submissions while the first is pending", async () => {
    let finish!: (value: unknown) => void;
    mutateAsync.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<ConnectRepositoryForm />);
    fireEvent.change(screen.getByLabelText("HTTPS GitHub repository URL"), { target: { value: "https://github.com/acme/platform" } });
    const form = screen.getByRole("button", { name: "Connect and index" }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    fireEvent.submit(form as HTMLFormElement);
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    finish({ repositoryId: "acme/platform", jobId: "job-1", status: "queued" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/repositories/acme/platform/indexing?jobId=job-1"));
  });

  it("explains URL format, backend access, asynchronous indexing, and recovery", () => {
    render(<ConnectRepositoryPage />);
    expect(screen.getByText("https://github.com/owner/repository")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What happens after submission" })).toBeInTheDocument();
    expect(screen.getByText(/does not grant or change GitHub permissions/)).toBeInTheDocument();
    expect(screen.getByText(/Leaving the progress screen does not cancel/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("HTTPS GitHub repository URL"), { target: { value: "invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect and index" }));
    expect(screen.getByText(/Correct the URL or resolve the reported backend access issue/)).toBeInTheDocument();
  });
});
