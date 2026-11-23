import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { api } from "./lib/api";

vi.mock("./lib/api", () => ({
  api: Object.fromEntries([
    "refs", "tasks", "endpoints", "audit", "environments", "health", "approvals",
    "save", "reveal", "remove", "enableBiometrics", "unlock", "biometrics",
  ].map((name) => [name, vi.fn()])),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  vi.mocked(api.refs).mockResolvedValue([
    { reference: "test/key", issuer: "test", name: "key", present: true, used_by: [], biometric: false },
  ]);
  for (const method of [api.tasks, api.endpoints, api.audit, api.environments, api.approvals]) {
    vi.mocked(method).mockResolvedValue([]);
  }
  vi.mocked(api.health).mockResolvedValue({
    enforcement: "test", enforced: true, audit_intact: true, audit_entries: 0, missing_refs: [],
  });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("says why biometrics are unavailable and offers no unlock", async () => {
  vi.mocked(api.biometrics).mockResolvedValue({
    available: false, reason: "this build needs a signed, provisioned app bundle", vault_ready: false,
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /settings/i }));

  expect(await screen.findByText("this build needs a signed, provisioned app bundle")).toBeTruthy();
  expect((screen.getByRole("button", { name: "unlock" }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.unlock).not.toHaveBeenCalled();
  expect(api.reveal).not.toHaveBeenCalled();
});

it("unlocks the vault from settings once it exists", async () => {
  vi.mocked(api.biometrics).mockResolvedValue({ available: true, reason: null, vault_ready: true });
  vi.mocked(api.unlock).mockResolvedValue(true);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /settings/i }));

  const unlock = await screen.findByRole("button", { name: "unlock" });
  await waitFor(() => expect((unlock as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(unlock);

  await waitFor(() => expect(api.unlock).toHaveBeenCalledOnce());
  expect(await screen.findByRole("button", { name: "unlocked" })).toBeTruthy();
  expect(api.reveal).not.toHaveBeenCalled();
});
