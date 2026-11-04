// A throwaway plim-server for the screenshot scripts.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * This process's environment without Plim's own settings, `PLIM_*` and their old names `TIRO_*`:
 * what a server, the CLI or a shell under test starts from, so the settings of whoever runs the
 * checks (their passphrase, their server) never reach it.
 */
export const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PLIM|TIRO)_/.test(k)));

/** A port nothing listens on right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Every server started, stopped when this process ends however it ends (#263): a crash or a
// timeout used to leave them running on the test ports, and the next run talked to them.
const running = new Set();
let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  process.on('exit', () => running.forEach((s) => s.proc?.kill()));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      running.forEach((s) => s.proc?.kill());
      process.exit(130);
    });
  }
}

export class TestServer {
  /** dataDir holds tiro.db; root is the repo (for web/ and admin/); env adds or overrides settings. */
  constructor({ root, dataDir, port, adminPort, env = {}, connectorUrl = 'http://connector.test', bin = process.env.PLIM_BIN ?? join(root, 'target/release/plim-server') }) {
    if (!existsSync(bin)) throw new Error(`No server binary at ${bin}; run: cargo build --release -p plim-server`);
    Object.assign(this, { root, dataDir, port, adminPort, env, connectorUrl, bin, proc: null });
    this.db = join(dataDir, 'tiro.db');
    this.url = `http://localhost:${port}`;
  }

  async start() {
    // Something already answers there: a server left behind. Never run against it by mistake.
    if (await this.answers()) throw new Error(`port ${this.port} already answers: a plim-server left behind? Stop it first (ss -ltnp | grep ${this.port}).`);
    hook();
    this.proc = spawn(this.bin, [], {
      env: {
        ...cleanEnv(),
        PLIM_DB: this.db,
        PLIM_POW_BITS: '8',
        PLIM_ADDR: `127.0.0.1:${this.port}`,
        ...(this.adminPort ? { PLIM_ADMIN_ADDR: `127.0.0.1:${this.adminPort}` } : {}),
        PLIM_WEB: join(this.root, 'web'),
        PLIM_CONNECTOR_URL: this.connectorUrl, // (#369: a TestConnector, or a stand-in nothing answers at)
        PLIM_ADMIN_WEB: join(this.root, 'admin'),
        ...this.env,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    running.add(this);
    let stderr = '';
    this.proc.stderr.on('data', (d) => (stderr += d));
    for (let i = 0; i < 100; i++) {
      if (this.proc.exitCode !== null) throw new Error(`plim-server exited at once (code ${this.proc.exitCode}): ${stderr.trim()}`);
      if (await this.answers()) return;
      await wait(100);
    }
    throw new Error(`plim-server didn't start (${this.bin}): ${stderr.trim()}`);
  }

  async answers() {
    try {
      return (await fetch(`http://127.0.0.1:${this.port}/healthz`)).ok;
    } catch {
      return false;
    }
  }

  async stop() {
    const p = this.proc;
    running.delete(this);
    if (!p || p.exitCode !== null || p.signalCode !== null) return; // (gone already: by a signal, exitCode stays null)
    const exited = new Promise((r) => p.once('exit', r));
    p.kill();
    await exited;
  }
}

/** The connector (#369), `plim mcp --http`, for a TestServer made with its url as `connectorUrl`. */
export class TestConnector {
  constructor({ root, dataDir, port, serverUrl, bin = process.env.PLIM_CLI_BIN ?? join(root, 'target/release/plim') }) {
    if (!existsSync(bin)) throw new Error(`No plim binary at ${bin}; run: cargo build --release -p plim-cli`);
    Object.assign(this, { root, dataDir, port, serverUrl, bin, proc: null });
    this.url = `http://localhost:${port}`;
  }

  async start() {
    if (await this.answers()) throw new Error(`port ${this.port} already answers: a connector left behind?`);
    hook();
    const args = ['mcp', '--http', `127.0.0.1:${this.port}`, '--server', this.serverUrl, '--public-url', this.url, '--secret-file', join(this.dataDir, 'connector.key')];
    this.proc = spawn(this.bin, args, { env: { ...cleanEnv(), PLIM_HOME: join(this.dataDir, 'connector-home') }, stdio: ['ignore', 'ignore', 'pipe'] });
    running.add(this);
    let stderr = '';
    this.proc.stderr.on('data', (d) => (stderr += d));
    for (let i = 0; i < 100; i++) {
      if (this.proc.exitCode !== null) throw new Error(`plim mcp --http exited at once (code ${this.proc.exitCode}): ${stderr.trim()}`);
      if (await this.answers()) return;
      await wait(100);
    }
    throw new Error(`the connector didn't start (${this.bin}): ${stderr.trim()}`);
  }

  async answers() {
    try {
      return (await fetch(`http://127.0.0.1:${this.port}/healthz`)).ok;
    } catch {
      return false;
    }
  }

  stop() {
    return TestServer.prototype.stop.call(this);
  }
}
