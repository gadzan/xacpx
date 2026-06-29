import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canConnectToEndpoint } from "../../../src/orchestration/endpoint-probe";

test("canConnectToEndpoint returns true when Unix socket accepts connections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-endpoint-probe-"));
  const socketPath = join(dir, "test.sock");

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const result = await canConnectToEndpoint(socketPath);
  expect(result).toBe(true);

  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("canConnectToEndpoint returns false when socket path does not exist", async () => {
  const result = await canConnectToEndpoint("/nonexistent/socket/path");
  expect(result).toBe(false);
});

test("canConnectToEndpoint returns false when socket exists but has no listener", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-endpoint-probe-"));
  const socketPath = join(dir, "no-listener.sock");

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  server.close();

  await new Promise((r) => setTimeout(r, 10));

  const result = await canConnectToEndpoint(socketPath);
  expect(result).toBe(false);

  rmSync(dir, { recursive: true, force: true });
});

test("canConnectToEndpoint returns true when timeout occurs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-endpoint-probe-"));
  const socketPath = join(dir, "timeout.sock");

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  server.on("connection", (conn) => {
  });

  const result = await canConnectToEndpoint(socketPath, 10);
  expect(result).toBe(true);

  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("canConnectToEndpoint handles timeout parameter correctly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-endpoint-probe-"));
  const socketPath = join(dir, "timeout2.sock");

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const result = await canConnectToEndpoint(socketPath, 5000);
  expect(result).toBe(true);

  server.close();
  rmSync(dir, { recursive: true, force: true });
});

