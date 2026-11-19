import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUuid } from "../lib/random-id";

const originalCrypto = globalThis.crypto;

afterEach(() => {
  vi.stubGlobal("crypto", originalCrypto);
});

describe("randomUuid", () => {
  it("uses the platform UUID when randomUUID exists", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "11111111-2222-4333-8444-555555555555",
    });
    expect(randomUuid()).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("formats a v4 UUID from getRandomValues when randomUUID is unavailable", () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
    vi.stubGlobal("crypto", {
      getRandomValues: (target: Uint8Array) => {
        target.set(bytes);
        return target;
      },
    });
    expect(randomUuid()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("still returns a UUID when neither crypto API exists", () => {
    vi.stubGlobal("crypto", undefined);
    expect(randomUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
