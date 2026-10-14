import { runDefaultRouterCli } from "./default-router";

// The built-in default Conversation Router entry. The daemon spawns this file
// as an external process — `--capabilities` before a decision process exists,
// then `--decide` per routing call — exactly like an operator-supplied router
// command, so the default earns its `ready` status through the same proof.

/** The daemon bounds a serialized `RoutingInput` far below this; the cap only
 *  stops an unbounded pipe from exhausting memory before the decision is
 *  built, and failing on it is the honest outcome. */
const STDIN_LIMIT_BYTES = 2 * 1024 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > STDIN_LIMIT_BYTES) {
      throw new Error(`routing input exceeded ${STDIN_LIMIT_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The write callback carries both the flush and the failure, so a stream the
 *  peer already closed (EPIPE) surfaces as a rejection instead of a hang. */
function writeStream(stream: NodeJS.WritableStream, text: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  stream.write(text, (error) => (error ? reject(error) : resolve()));
  return promise;
}

try {
  process.exitCode = await runDefaultRouterCli({
    argv: process.argv.slice(2),
    readStdin,
    writeStdout: (text) => writeStream(process.stdout, text),
    writeStderr: (text) => writeStream(process.stderr, text),
    env: process.env,
  });
} catch (error) {
  // A write failure must never read as a clean exit: the daemon treats a
  // non-zero exit as a failed probe or decision and fails the Run closed.
  process.exitCode = 1;
  process.stderr.write(
    `[xacpx-default-router] ${error instanceof Error ? error.message : String(error)}\n`,
  );
}
