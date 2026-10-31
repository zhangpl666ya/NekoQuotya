import type { CollectorRequest } from '../shared/ipc.ts';
import { loadPacks } from '../shared/packs/registry.ts';
import { claudeLocalSource } from './claudeLocal.ts';
import { Scheduler } from './scheduler.ts';
import { TokscaleRunner, resolveTokscaleBinary } from './tokscaleRunner.ts';

// Entry point of the collector utility process (Electron utilityProcess.fork).
// Runs the same Scheduler as the developer CLI and forwards its output to the
// main process; scanning and file I/O never block the windows.
//
//   main → here:  CollectorRequest ('start' | 'refreshNow' | 'resync' | 'stop')
//   here → main:  CollectorMessage (below)

export type CollectorMessage =
  | { type: 'update'; snapshot: import('../shared/types.ts').PackSnapshot; reason: import('./scheduler.ts').UpdateReason }
  | { type: 'event'; event: import('./scheduler.ts').SchedulerEvent }
  | { type: 'started' }
  | { type: 'refreshed' }
  | { type: 'stopped' }
  | { type: 'fatal'; detail: string };

const port = process.parentPort;
let scheduler: Scheduler | null = null;

const send = (message: CollectorMessage) => port.postMessage(message);

port.on('message', (e) => void handle(e.data as CollectorRequest));

async function handle(request: CollectorRequest): Promise<void> {
  try {
    switch (request.type) {
      case 'start': {
        if (scheduler) return;
        const { packs } = await loadPacks(request.packsRoot);
        scheduler = new Scheduler({
          packs,
          runner: new TokscaleRunner(resolveTokscaleBinary()),
          localQuota: { Claude: claudeLocalSource() },
          onUpdate: (snapshot, reason) => send({ type: 'update', snapshot, reason }),
          onEvent: (event) => send({ type: 'event', event }),
        });
        await scheduler.start();
        send({ type: 'started' });
        return;
      }
      case 'refreshNow':
        await scheduler?.refreshNow();
        send({ type: 'refreshed' });
        return;
      case 'resync':
        await scheduler?.resyncAll();
        send({ type: 'refreshed' });
        return;
      case 'stop':
        await scheduler?.stop();
        send({ type: 'stopped' });
        process.exit(0);
    }
  } catch (err) {
    send({ type: 'fatal', detail: err instanceof Error ? err.stack ?? err.message : String(err) });
  }
}
