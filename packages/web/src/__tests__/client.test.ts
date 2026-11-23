import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";

describe("api client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends application/json content-type on a bodyless POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.post("/api/instances/pairing-token");
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.credentials).toBe("include");
  });

  it("does not force a content-type on GET", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.get("/api/me");
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers["content-type"]).toBeUndefined();
  });
});
