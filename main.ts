// main.ts -- the trial entrypoint: everything around the forge, none of it.
//
// The suite in the pod starts first and waits for this process. The whole
// job here is the handshake around the real work (which lives in app.ts):
//
//   1. start the forge on a port the kernel picks,
//   2. tell the suite where it went:  POST {"port": N}  ->  /register,
//   3. ask the suite, on a steady beat, whether it has finished:
//      GET /done answers {"done": false} until it has, then true,
//   4. on that answer, leave with status 0.
//
// The forge's own surfaces are never touched from here; this file only
// keeps the process alive for exactly as long as the suite wants it.

import type { Server } from 'node:http';
import { createApp } from './app.ts';

/** How often to ask the suite whether the trial is over. */
const DONE_POLL_MS = 500;

/** How long to keep trying to register before giving up. */
const REGISTER_BUDGET_MS = 20_000;

/** The suite's base URL, from the environment, with no trailing slash. */
function suiteBase(): string {
  const base = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (base === '') {
    throw new Error('MAKEFUN_ENV_URL is not set; there is nowhere to register');
  }
  return base;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Hand the suite our port, exactly as the wire contract names it.
 *
 * The suite starts beside us and may not be accepting connections in the
 * first instants, and a program that never registers scores nothing -- so
 * a refused or failed attempt is retried on a growing delay until the
 * registration budget runs out. Only then is the failure fatal.
 */
async function registerWithSuite(base: string, port: number): Promise<void> {
  const deadline = Date.now() + REGISTER_BUDGET_MS;
  let wait = 200;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const reply = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      // Drain the body so the connection finishes cleanly.
      await reply.text();
      if (reply.ok) return;
      throw new Error(`HTTP ${reply.status}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (Date.now() >= deadline) {
        throw new Error(
          `registration never landed after ${attempt} attempts (last: ${reason})`,
        );
      }
      process.stderr.write(
        `[main] registration attempt ${attempt} failed (${reason}); retrying\n`,
      );
      await pause(wait);
      wait = Math.min(wait * 2, 2_000);
    }
  }
}

/**
 * One poll of the completion endpoint. Any trouble talking to the suite --
 * a refused connection, a bad status, an unparseable body -- reads as
 * "not done": the trial only ends on an explicit {"done": true}, and a
 * process that leaves early scores nothing.
 */
async function suiteHasFinished(base: string): Promise<boolean> {
  try {
    const reply = await fetch(`${base}/done`);
    if (!reply.ok) return false;
    const payload: unknown = await reply.json();
    return (
      typeof payload === 'object' &&
      payload !== null &&
      (payload as { done?: unknown }).done === true
    );
  } catch {
    return false;
  }
}

/** The port a listening server actually landed on. */
function chosenPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the forge did not bind a TCP port');
  }
  return address.port;
}

async function run(): Promise<void> {
  const base = suiteBase();
  const server = createApp();

  // When the pod stops us, close up and leave cleanly rather than being
  // cut off mid-request.
  const leave = (): void => {
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', leave);
  process.on('SIGINT', leave);

  // Port 0: the kernel chooses. (8080 belongs to the suite; never bind it.)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const port = chosenPort(server);
  process.stdout.write(`[main] forge is listening on port ${port}\n`);

  await registerWithSuite(base, port);
  process.stdout.write(`[main] registered with the suite at ${base}\n`);

  while (!(await suiteHasFinished(base))) {
    await pause(DONE_POLL_MS);
  }

  process.stdout.write('[main] the suite is done; exiting\n');
  server.close();
  process.exit(0);
}

run().catch((err: unknown) => {
  process.stderr.write(
    `[main] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
