import { expect, test } from "bun:test";
import { createNoopRelayLogger, createRelayLogger } from "../../../../packages/relay/src/logging";

function collector() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, writeOut: (l: string) => out.push(l), writeErr: (l: string) => err.push(l) };
}
const at = () => new Date("2026-07-06T00:00:00.000Z");

test("routes info/debug to stdout and error to stderr", () => {
  const c = collector();
  const log = createRelayLogger({ level: "debug", writeOut: c.writeOut, writeErr: c.writeErr, now: at });
  log.info("relay.start", "listening", { httpPort: 8787 });
  log.debug("relay.web.connected", "ws open");
  log.error("relay.event.persist_failed", "db write failed", { instanceId: "i1" });
  expect(c.out).toHaveLength(2);
  expect(c.err).toHaveLength(1);
  expect(c.out[0]).toBe('2026-07-06T00:00:00.000Z INFO relay.start message="listening" httpPort=8787\n');
  expect(c.err[0]).toBe('2026-07-06T00:00:00.000Z ERROR relay.event.persist_failed message="db write failed" instanceId="i1"\n');
});

test("level filter suppresses below-threshold lines", () => {
  const c = collector();
  const log = createRelayLogger({ level: "error", writeOut: c.writeOut, writeErr: c.writeErr, now: at });
  log.info("relay.start", "listening");
  log.debug("relay.web.connected", "ws open");
  log.error("relay.boom", "bad");
  expect(c.out).toHaveLength(0);
  expect(c.err).toHaveLength(1);
});

test("defaults to info level", () => {
  const c = collector();
  const log = createRelayLogger({ writeOut: c.writeOut, writeErr: c.writeErr, now: at });
  log.debug("relay.x", "hidden");
  log.info("relay.y", "shown");
  expect(c.out).toHaveLength(1);
});

test("noop logger writes nothing", () => {
  const log = createNoopRelayLogger();
  expect(() => log.info("relay.x", "y", { a: 1 })).not.toThrow();
});
