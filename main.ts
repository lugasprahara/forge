// main.ts -- the trial entrypoint: the handshake around the forge, nothing of
// the forge itself (that is app.ts and the modules behind it).
//
// The suite starts beside this process and waits for it. The contract:
//   1. bring the forge up on a port the kernel chooses (never 8080: the
//      suite's own),
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register,
//   3. poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true},
//   4. exit 0.
// A process that never registers, or that leaves before the suite is done,
// scores nothing -- so registration retries inside a budget, and only an
// explicit done:true ends the poll.

import type { Server } from 'node:http';
import { createApp } from './app.ts';

/** How often the completion endpoint is polled. */
const POLL_MS = 500;
/** How long registration is retried before the failure is fatal. */
const REGISTER_BUDGET_MS = 20_000;

function suiteBase(): string {
  const base = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (base === '') throw new Error('MAKEFUN_ENV_URL is not set; there is nowhere to register');
  return base;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Hand the suite our port. The suite may not be accepting connections in the
 * first instants, so a failed attempt retries on a doubling delay until the
 * registration budget runs out.
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
      await reply.text(); // drain, so the connection finishes cleanly
      if (reply.ok) return;
      throw new Error(`HTTP ${reply.status}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (Date.now() >= deadline) {
        throw new Error(`registration never landed after ${attempt} attempts (last: ${reason})`);
      }
      process.stderr.write(`[main] registration attempt ${attempt} failed (${reason}); retrying\n`);
      await pause(wait);
      wait = Math.min(wait * 2, 2_000);
    }
  }
}

/**
 * One poll of the completion endpoint. Any trouble at all -- a refused
 * connection, a bad status, an unparseable body -- reads as "not done": the
 * trial ends only on an explicit {"done": true}.
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

  const leave = (): void => {
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', leave);
  process.on('SIGINT', leave);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const port = chosenPort(server);
  process.stdout.write(`[main] forge is listening on port ${port}\n`);

  await registerWithSuite(base, port);
  process.stdout.write(`[main] registered with the suite at ${base}\n`);

  while (!(await suiteHasFinished(base))) {
    await pause(POLL_MS);
  }

  process.stdout.write('[main] the suite is done; exiting\n');
  server.close();
  process.exit(0);
}

run().catch((err: unknown) => {
  process.stderr.write(`[main] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
