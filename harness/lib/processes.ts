// Starts and stops the local chains for one acceptance run. Children are
// tracked by PID and stopped by PID; the hnsd container by its unique name.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { height } from './hsd.ts';

const children: ChildProcess[] = [];
const containers: string[] = [];
const FOUNDRY_BIN = `${process.env.HOME}/.foundry/bin`;
const HSD_BIN = new URL('../node_modules/.bin/hsd', import.meta.url).pathname;
const ROOT_HSD_BIN = new URL('../../node_modules/.bin/hsd', import.meta.url).pathname;

export const ANVIL_URL = 'http://127.0.0.1:18545';
export const HNSD_IMAGE = 'pirate-registry-hnsd:v2.0.0-regtest';
export const HNSD_NS = { host: '127.0.0.1', port: 26349 };

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

export async function assertPortsFree(ports: number[]): Promise<void> {
  for (const port of ports) {
    if (await portOpen(port)) throw new Error(`port ${port} is already in use; stop the other process first`);
  }
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function startAnvil(): Promise<void> {
  // One slot per epoch: `safe` trails by one block and `finalized` by two,
  // so the resolver keeps its safe-block semantics on a local chain.
  const child = spawn(`${FOUNDRY_BIN}/anvil`, ['--port', '18545', '--slots-in-an-epoch', '1', '--silent'], {
    stdio: 'ignore',
  });
  children.push(child);
  await waitFor(() => portOpen(18545), 'anvil');
}

export async function startHsd(prefix: string): Promise<void> {
  const bin = (await import('node:fs')).existsSync(HSD_BIN) ? HSD_BIN : ROOT_HSD_BIN;
  const child = spawn(
    bin,
    ['--network=regtest', '--memory=true', `--prefix=${prefix}`, '--listen=true', '--host=127.0.0.1', '--log-level=warning'],
    { stdio: 'ignore' },
  );
  children.push(child);
  await waitFor(async () => (await height()) >= 0, 'hsd regtest');
}

/** (Re)starts hnsd with an empty cache and waits until it reaches hsd's tip. */
export async function restartHnsd(): Promise<void> {
  const name = 'pirate-registry-hnsd-acceptance';
  try {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  } catch {}
  execFileSync('docker', [
    'run', '-d', '-t', '--rm', '--name', name, '--network', 'host', HNSD_IMAGE,
    '-s', '127.0.0.1:14038', '-n', `${HNSD_NS.host}:${HNSD_NS.port}`, '-r', '127.0.0.1:26350', '-p', '1',
  ]);
  if (!containers.includes(name)) containers.push(name);
  const target = await height();
  await waitFor(async () => {
    const logs = execFileSync('docker', ['logs', name], { encoding: 'utf8' });
    return logs.includes(`new height: ${target}\r`) || logs.includes(`new height: ${target}\n`);
  }, `hnsd to sync to height ${target}`);
}

export async function stopAll(): Promise<void> {
  for (const name of containers) {
    try {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    } catch {}
  }
  for (const child of children) {
    if (child.pid && child.exitCode === null) child.kill('SIGTERM');
  }
}
