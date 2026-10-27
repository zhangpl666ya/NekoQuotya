import type { ActionId, ActivityId, LineKey, PetIntent } from '../../shared/pet.ts';
import type { PackSnapshot, QuotaKind } from '../../shared/types.ts';
import { localDate } from '../../shared/usage.ts';
import { computePressure, initialMoodLevel, moodOf, moodWindows, stepMood, type BrainRules, type Pressure } from './mood.ts';

// PetBrain: one per pack. Pure logic driven by three inputs —
//   observe(snapshot)  new data from the collector
//   interact(kind)     the user poked or dragged the pet
//   tick()             time passing (the host calls it about once a second)
// — each returning the current PetIntent. No timers, no I/O, no randomness except
// the injected `random`, so every rule can be tested with a fake clock.
//
// Rules (docs/architecture.md §4):
//   mood      pressure → five levels with hysteresis; frozen while the quota is stale
//   activity  working (usage in the last workingMinutes) / idle / sleeping (no usage or
//             interaction for idleSleepMinutes); new usage or a poke wakes her up
//   actions   one at a time; higher priority interrupts lower; a lower one is dropped,
//             except quota alerts, which wait for the current action to finish
//   bubbles   every action and mood change speaks; idle chatter every chatterMinutes
//             while awake; nothing is said while asleep

type Interaction = 'poke' | 'dragStart' | 'dragEnd';

/** Higher wins. User interaction > quota alert > celebrate / wake > eat > new day */
const PRIORITY: Record<ActionId, number> = {
  poked: 5,
  dragged: 5,
  landed: 5,
  alert: 4,
  celebrate: 3,
  wake: 3,
  eat: 2,
  newDay: 1,
};

/** How long each action plays; null = until ended explicitly (dragging) */
export const ACTION_MS: Record<ActionId, number | null> = {
  poked: 1_500,
  dragged: null,
  landed: 800,
  eat: 2_000,
  alert: 3_000,
  celebrate: 3_000,
  wake: 2_000,
  newDay: 3_000,
};

/** A quota drop of more than this many points means the window was reset */
const RESET_DROP = 5;
/** Pokes within this window that count towards the annoyed reaction */
const POKE_WINDOW_MS = 10_000;
const ANNOYED_POKES = 5;

interface ActionRequest {
  id: ActionId;
  line: LineKey | null;
  params?: Record<string, string | number>;
}

interface QuotaMemory {
  lastUsed: number;
  /** Highest alert threshold already announced in the current window cycle */
  alerted: number;
}

export class PetBrain {
  private rules: BrainRules;
  private readonly random: () => number;
  private readonly startedAt: number;

  private level = 0;
  private pressure: Pressure = { basis: 'budget', pressure: 0, todayTokens: 0, stale: false };
  private hasPressure = false;
  private activity: ActivityId = 'idle';
  private action: (ActionRequest & { startedAt: number; until: number | null }) | null = null;
  private pendingAlert: ActionRequest | null = null;
  private bubble: PetIntent['bubble'] = null;
  private bubbleSeq = 0;
  private nextChatterAt: number | null = null;

  private lastUsageAt: number | null = null;
  private lastUserAt: number | null = null;
  private lastEatAt = -Infinity;
  private pokes: number[] = [];
  private dragging = false;
  private todayDate: string | null = null;
  private todayTokens = 0;
  private readonly quota = new Map<QuotaKind, QuotaMemory>();

  constructor(rules: BrainRules, now: number, random: () => number = Math.random) {
    this.rules = rules;
    this.random = random;
    this.startedAt = now;
    this.activity = this.computeActivity(now);
  }

  intent(): PetIntent {
    return {
      mood: moodOf(this.level),
      activity: this.activity,
      action: this.action ? { id: this.action.id, startedAt: this.action.startedAt, until: this.action.until } : null,
      bubble: this.bubble,
      info: {
        basis: this.pressure.basis,
        pressure: Math.round(this.pressure.pressure * 10) / 10,
        todayTokens: this.pressure.todayTokens,
        stale: this.pressure.stale,
      },
    };
  }

  // ---- inputs ------------------------------------------------------------------

  observe(snapshot: PackSnapshot, now: number): PetIntent {
    // Usage first, so new activity wakes her before anything else reacts
    const today = snapshot.today;
    const reported = today?.lastActivityAt ?? null;
    if (reported != null && (this.lastUsageAt == null || reported > this.lastUsageAt)) this.lastUsageAt = reported;
    this.advance(now);

    const pressure = computePressure(snapshot, this.rules, now);
    if (today && today.date === localDate(now)) {
      if (this.todayDate && today.date > this.todayDate) this.request({ id: 'newDay', line: 'event.newDay' }, now);
      else if (this.todayDate === today.date && pressure.todayTokens > this.todayTokens) this.onUsageGrew(now);
      this.todayDate = today.date;
      this.todayTokens = pressure.todayTokens;
    }

    if (snapshot.quota) this.checkQuota(snapshot, now);
    this.updateMood(pressure, now);
    return this.intent();
  }

  interact(kind: Interaction, now: number): PetIntent {
    const wasAsleep = this.computeActivity(now) === 'sleeping';
    this.lastUserAt = now;
    this.advance(now, { quietWake: true });

    if (kind === 'poke') {
      this.pokes = [...this.pokes.filter((t) => now - t < POKE_WINDOW_MS), now];
      if (wasAsleep) this.request({ id: 'wake', line: 'event.wake' }, now, PRIORITY.poked);
      else this.request({ id: 'poked', line: this.pokes.length >= ANNOYED_POKES ? 'user.pokeAnnoyed' : 'user.poke' }, now);
    } else if (kind === 'dragStart') {
      this.dragging = true;
      this.request({ id: 'dragged', line: 'user.drag' }, now);
    } else if (this.dragging) {
      this.dragging = false;
      this.request({ id: 'landed', line: 'user.land' }, now);
    }
    return this.intent();
  }

  /** New rules from the settings window; they apply from the next observation or tick */
  setRules(rules: BrainRules, now: number): PetIntent {
    this.rules = rules;
    this.nextChatterAt = null; // re-roll with the new chatter range (or none)
    this.advance(now);
    return this.intent();
  }

  tick(now: number): PetIntent {
    this.advance(now);
    if (this.activity !== 'sleeping' && !this.bubble && !this.action && this.rules.chatterMinutes) {
      this.nextChatterAt ??= now + this.chatterDelay();
      if (now >= this.nextChatterAt) this.say(`mood.${moodOf(this.level)}`, now);
    }
    return this.intent();
  }

  // ---- rules ---------------------------------------------------------------------

  private onUsageGrew(now: number): void {
    if (now - this.lastEatAt < this.rules.eatCooldownMinutes * 60_000) return;
    this.lastEatAt = now;
    this.request({ id: 'eat', line: 'event.eat' }, now);
  }

  /** Alerts on crossing thresholds (once per window cycle) and celebrates resets. Never on the first sighting. */
  private checkQuota(snapshot: PackSnapshot, now: number): void {
    const thresholds = [...this.rules.alertThresholds].sort((a, b) => a - b);
    const highestReached = (used: number) => thresholds.filter((t) => t <= used).at(-1) ?? 0;

    for (const w of moodWindows(snapshot.quota!.windows)) {
      const used = w.usedPercent!;
      const memory = this.quota.get(w.kind);
      if (!memory) {
        // First sighting (e.g. app start at 85%): remember, do not alert
        this.quota.set(w.kind, { lastUsed: used, alerted: highestReached(used) });
        continue;
      }
      if (w.stale) continue;
      if (used < memory.lastUsed - RESET_DROP) {
        memory.alerted = highestReached(used);
        this.request({ id: 'celebrate', line: 'event.quota.reset', params: { window: w.kind } }, now);
      } else {
        const top = highestReached(used);
        if (top > memory.alerted) {
          memory.alerted = top;
          this.request({ id: 'alert', line: `event.quota.${top}`, params: { window: w.kind, percent: used } }, now);
        }
      }
      memory.lastUsed = used;
    }
  }

  private updateMood(pressure: Pressure, now: number): void {
    const previous = this.level;
    if (!this.hasPressure) {
      this.level = initialMoodLevel(pressure.pressure, this.rules.moodThresholds);
      this.hasPressure = true;
    } else if (!pressure.stale) {
      this.level = stepMood(this.level, pressure.pressure, this.rules.moodThresholds, this.rules.moodHysteresis);
    }
    // While stale, keep the last trusted pressure on display as well as the mood
    this.pressure = pressure.stale ? { ...pressure, pressure: this.pressure.pressure } : pressure;
    if (this.level !== previous && !this.action && this.activity !== 'sleeping') {
      this.say(`mood.${moodOf(this.level)}`, now);
    }
  }

  // ---- state machine -------------------------------------------------------------

  /** Expire the action and bubble, start a waiting alert, and follow activity changes */
  private advance(now: number, options: { quietWake?: boolean } = {}): void {
    if (this.bubble && now >= this.bubble.until) this.bubble = null;
    if (this.action && this.action.until != null && now >= this.action.until) {
      this.action = null;
      const pending = this.pendingAlert;
      this.pendingAlert = null;
      if (pending) this.request(pending, now);
    }

    const previous = this.activity;
    this.activity = this.computeActivity(now);
    if (previous === 'sleeping' && this.activity !== 'sleeping' && !options.quietWake) {
      this.request({ id: 'wake', line: 'event.wake' }, now);
    } else if (previous !== 'sleeping' && this.activity === 'sleeping') {
      this.bubble = null; // nothing is said while asleep
      this.pendingAlert = null;
      this.nextChatterAt = null;
    }
  }

  private computeActivity(now: number): ActivityId {
    if (this.dragging) return 'idle';
    const usage = this.lastUsageAt;
    if (usage != null && now - usage < this.rules.workingMinutes * 60_000) return 'working';
    const last = Math.max(usage ?? this.startedAt, this.lastUserAt ?? -Infinity);
    return now - last >= this.rules.idleSleepMinutes * 60_000 ? 'sleeping' : 'idle';
  }

  private request(req: ActionRequest, now: number, priority = PRIORITY[req.id]): void {
    if (this.activity === 'sleeping' && req.id !== 'wake') return; // asleep: no reactions
    const current = this.action;
    if (current && PRIORITY[current.id] > priority) {
      if (req.id === 'alert') this.pendingAlert = req; // alerts wait; the newest one wins
      return;
    }
    const duration = ACTION_MS[req.id];
    this.action = { ...req, startedAt: now, until: duration == null ? null : now + duration };
    if (req.line) this.say(req.line, now, req.params);
  }

  private say(lineKey: LineKey, now: number, params?: Record<string, string | number>): void {
    this.bubble = { id: ++this.bubbleSeq, lineKey, ...(params && { params }), until: now + this.rules.bubbleSeconds * 1_000 };
    this.nextChatterAt = now + this.chatterDelay();
  }

  private chatterDelay(): number {
    const range = this.rules.chatterMinutes;
    if (!range) return Infinity;
    const [min, max] = range;
    return (min + (max - min) * this.random()) * 60_000;
  }
}
