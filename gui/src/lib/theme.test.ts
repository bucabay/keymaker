import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadTheme, saveTheme } from "./theme";

let store: Record<string, string> = {};

beforeEach(() => {
  store = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

it("opens dark when nothing was chosen", () => {
  expect(loadTheme()).toBe("dark");
});

it("remembers a light choice", () => {
  saveTheme("light");
  expect(loadTheme()).toBe("light");
});

it("falls back to dark when storage is unavailable", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("storage is disabled");
    },
    setItem: () => {
      throw new Error("storage is disabled");
    },
  });
  expect(loadTheme()).toBe("dark");
  expect(() => saveTheme("light")).not.toThrow();
});
