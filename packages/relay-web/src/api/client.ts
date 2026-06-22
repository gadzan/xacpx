export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = method === "GET" ? {} : { "content-type": "application/json" };
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError((data as { error?: string })?.error ?? "request-failed", res.status);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
  /** Proxy a control RPC to an instance via the relay. */
  rpc: <T>(instanceId: string, type: string, payload: unknown = {}) =>
    request<{ result: T }>("POST", `/api/instances/${instanceId}/rpc`, { type, payload }).then((r) => r.result),
  /** Upload a file to the instance daemon; returns its absolute on-host path. */
  upload: (instanceId: string, payload: { filename: string; content: string; mimeType: string }) =>
    request<{ result: import("@ganglion/xacpx-relay-protocol").UploadResult }>(
      "POST",
      `/api/instances/${instanceId}/rpc`,
      { type: "control.upload", payload },
    ).then((r) => r.result),
};
