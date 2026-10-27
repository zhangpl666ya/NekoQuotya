import { utilityProcess, type UtilityProcess } from 'electron';
import type { CollectorMessage } from '../collector/host.ts';
import type { CollectorRequest } from '../shared/ipc.ts';

// Runs the collector (src/collector/host.ts) in an Electron utility process and
// relays its messages. Scanning and file I/O stay out of the main process.

const STOP_TIMEOUT_MS = 8_000;

export class CollectorClient {
  private readonly entry: string;
  private readonly onMessage: (message: CollectorMessage) => void;
  private child: UtilityProcess | null = null;
  private refreshWaiters: Array<() => void> = [];

  constructor(entry: string, onMessage: (message: CollectorMessage) => void) {
    this.entry = entry;
    this.onMessage = onMessage;
  }

  start(packsRoot: string): void {
    const child = utilityProcess.fork(this.entry, [], { serviceName: 'NekoQuotya collector', stdio: 'inherit' });
    child.on('message', (message: CollectorMessage) => {
      if (message.type === 'refreshed') {
        const waiters = this.refreshWaiters;
        this.refreshWaiters = [];
        waiters.forEach((resolve) => resolve());
      }
      this.onMessage(message);
    });
    child.once('exit', () => {
      if (this.child === child) this.child = null;
      const waiters = this.refreshWaiters;
      this.refreshWaiters = [];
      waiters.forEach((resolve) => resolve());
    });
    this.child = child;
    this.send({ type: 'start', packsRoot });
  }

  /** Resolves once today, history catch-up and quota have all been refreshed */
  refreshNow(): Promise<void> {
    if (!this.child) return Promise.resolve();
    return new Promise((resolve) => {
      this.refreshWaiters.push(resolve);
      this.send({ type: 'refreshNow' });
    });
  }

  /** Ask the collector to stop cleanly (releases its data-folder locks); kill it if it does not exit in time */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    this.send({ type: 'stop' });
    const timer = setTimeout(() => child.kill(), STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  }

  private send(request: CollectorRequest): void {
    this.child?.postMessage(request);
  }
}
