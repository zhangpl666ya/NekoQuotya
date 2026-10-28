import { useEffect, useState, type CSSProperties, type DragEvent } from 'react';
import { describeError, translator, type Translate } from '../../shared/i18n/index.ts';
import type { LauncherPack, LauncherState } from '../../shared/ipc.ts';
import { PERIODS, type Period } from '../../shared/stats.ts';
import type { QuotaWindow } from '../../shared/types.ts';

// Launcher panel (docs/architecture.md §6.2): one row per pack plus refresh,
// launch-at-startup and quit. Layout and look are placeholders until the UI
// design is settled; all styling lives in style.css.

const api = window.nekoLauncher;

export function App() {
  const [state, setState] = useState<LauncherState | null>(null);
  // While a card is dragged the order is local; it is sent to main on drop
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  useEffect(() => {
    void api.get().then((s) => s && setState(s));
    return api.onState(setState);
  }, []);

  if (!state) return null;
  const t = translator(state.locale);
  const byId = new Map(state.packs.map((p) => [p.id, p]));
  const packs = dragOrder ? dragOrder.flatMap((id) => byId.get(id) ?? []) : state.packs;

  const drag = {
    start: (id: string) => (e: DragEvent) => {
      e.dataTransfer.effectAllowed = 'move';
      setDragging(id);
      setDragOrder(state.packs.map((p) => p.id));
    },
    over: (id: string) => (e: DragEvent) => {
      if (!dragging || !dragOrder) return;
      e.preventDefault();
      if (id === dragging) return;
      // Move the dragged card to the hovered card's slot (before it in the upper half, after it in the lower)
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      const rest = dragOrder.filter((x) => x !== dragging);
      const at = rest.indexOf(id) + (after ? 1 : 0);
      const next = [...rest.slice(0, at), dragging, ...rest.slice(at)];
      if (next.join() !== dragOrder.join()) setDragOrder(next);
    },
    end: () => {
      if (dragOrder && dragOrder.join() !== state.packs.map((p) => p.id).join()) {
        api.command({ type: 'reorder', order: dragOrder });
        // Keep the new order on screen until main pushes it back
        setState({ ...state, packs: dragOrder.flatMap((id) => byId.get(id) ?? []) });
      }
      setDragging(null);
      setDragOrder(null);
    },
  };

  return (
    <div className="panel">
      <header>
        <span className="title">NekoQuotya</span>
        <div className="header-actions">
          <button disabled={state.refreshing} onClick={() => api.command({ type: 'refreshNow' })}>
            {t(state.refreshing ? 'launcher.refreshing' : 'launcher.refresh')}
          </button>
          <button onClick={() => api.command({ type: 'openSettings' })}>{t('launcher.settings')}</button>
        </div>
      </header>

      <main>
        {packs.map((pack) => (
          <PackCard
            key={pack.id}
            pack={pack}
            t={t}
            locale={state.locale}
            dragging={dragging === pack.id}
            onDragStart={drag.start(pack.id)}
            onDragOver={drag.over(pack.id)}
            onDragEnd={drag.end}
          />
        ))}
        {state.loadErrors.map((e) => (
          <p key={e.dir} className="warn">
            {t('launcher.packSkipped', { reason: describeError(t, e.error) })}
          </p>
        ))}
      </main>

      <footer>
        <label className={state.autostartAvailable ? '' : 'disabled'} title={state.autostartAvailable ? '' : t('launcher.autostartDev')}>
          <input
            type="checkbox"
            checked={state.autostart}
            disabled={!state.autostartAvailable}
            onChange={(e) => api.command({ type: 'setAutostart', enabled: e.target.checked })}
          />
          {t('launcher.autostart')}
        </label>
        <UpdateButton update={state.update} t={t} />
        <button className="quiet" onClick={() => api.command({ type: 'quit' })}>
          {t('launcher.quit')}
        </button>
      </footer>
    </div>
  );
}

function UpdateButton({ update, t }: { update: LauncherState['update']; t: Translate }) {
  switch (update.state) {
    case 'checking':
      return <span className="update muted">{t('update.checking')}</span>;
    case 'latest':
      return (
        <button className="update quiet" title={t('update.check')} onClick={() => api.command({ type: 'checkUpdate' })}>
          {t('update.latest', { version: update.version })}
        </button>
      );
    case 'available':
      return (
        <button className="update new" onClick={() => api.command({ type: 'openUpdate' })}>
          {t('update.available', { version: update.version })}
        </button>
      );
    case 'error':
      return (
        <button className="update quiet warn-text" onClick={() => api.command({ type: 'checkUpdate' })}>
          {t('update.error')}
        </button>
      );
    default:
      return (
        <button className="update quiet" onClick={() => api.command({ type: 'checkUpdate' })}>
          {t('update.check')}
        </button>
      );
  }
}

/** The pack's brand colour as CSS variables: --pack for text and borders, --pack-fill for bars */
function themeStyle(theme: LauncherPack['theme']): CSSProperties {
  const fill = theme.gradient ? `linear-gradient(90deg, ${theme.gradient.join(', ')})` : theme.color;
  return { '--pack': theme.color, '--pack-fill': fill } as CSSProperties;
}

interface CardProps {
  pack: LauncherPack;
  t: Translate;
  locale: string;
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDragEnd: () => void;
}

function PackCard({ pack, t, locale, dragging, onDragStart, onDragOver, onDragEnd }: CardProps) {
  const error = pack.status?.lastError;
  const [period, setPeriod] = useState<Period>('today');
  const usage = pack.usage?.[period];
  // Clicking the card opens the session window; its controls (toggle, tabs) must not
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <section
      className={dragging ? 'pack clickable dragging' : 'pack clickable'}
      style={themeStyle(pack.theme)}
      title={t('launcher.details')}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={(e) => e.preventDefault()}
      onClick={() => api.command({ type: 'openSessions', packId: pack.id })}
    >
      {pack.cardArt && <img className="card-art" src={pack.cardArt} alt="" draggable={false} />}
      <div className="pack-head">
        <div>
          <div className="pack-name">{pack.name}</div>
          {pack.mood && (
            <div className="pack-mood">
              {t(`moodName.${pack.mood}`)}
              {pack.activity && ` · ${t(`activity.${pack.activity}`)}`}
            </div>
          )}
        </div>
        <label className="toggle" onClick={stop}>
          <input type="checkbox" checked={pack.petVisible} onChange={() => api.command({ type: 'togglePet', packId: pack.id })} />
          {t('launcher.pet')}
        </label>
      </div>

      <div className="usage">
        <div className="tabs" onClick={stop}>
          {PERIODS.map((p) => (
            <button key={p} className={p === period ? 'tab active' : 'tab'} onClick={() => setPeriod(p)}>
              {t(`period.${p}`)}
            </button>
          ))}
        </div>
        {usage && usage.active > 0 ? (
          <>
            <span className="big">{fmt(usage.active)}</span>
            <span className="unit">{t('launcher.tokens')}</span>
            <div className="detail">
              {t('launcher.detail', {
                input: fmt(usage.input),
                output: fmt(usage.output),
                cacheRead: fmt(usage.cacheRead),
                sessions: usage.sessions,
              })}
            </div>
          </>
        ) : (
          <div className="detail">{t('launcher.noData')}</div>
        )}
      </div>

      {pack.quota && (
        <div className="quota">
          <div className="label">
            {t('launcher.quota')}
            {pack.quota.plan && <span className="plan">{pack.quota.plan}</span>}
            {pack.quota.checking && <span className="checking">{t('launcher.quotaChecking')}</span>}
          </div>
          {pack.quota.windows.filter((w) => w.applicable).length === 0 && !pack.quota.checking && (
            <div className="detail">{t('launcher.quotaNone')}</div>
          )}
          {pack.quota.windows
            .filter((w) => w.applicable)
            .map((w) => (
              <QuotaBar key={w.rawLabel} window={w} t={t} locale={locale} />
            ))}
          {pack.quota.error && <div className="warn">{describeError(t, pack.quota.error)}</div>}
        </div>
      )}

      {!!pack.status?.retainedSessions && <div className="detail">{t('launcher.retained', { count: pack.status.retainedSessions })}</div>}
      {error && error.stage !== 'quota' && <div className="warn">{describeError(t, error)}</div>}
    </section>
  );
}

function QuotaBar({ window: w, t, locale }: { window: QuotaWindow; t: Translate; locale: string }) {
  const used = w.usedPercent ?? 0;
  const label = w.kind === 'other' ? w.rawLabel : t(`quota.${w.kind}`);
  return (
    <div className={`bar ${w.stale ? 'stale' : ''}`}>
      <div className="bar-head">
        <span>{label}</span>
        <span>
          {w.usedPercent ?? '?'}%{w.stale && ` · ${t('quota.stale')}`}
        </span>
      </div>
      <div className="track">
        <div className="fill" style={{ width: `${Math.min(100, used)}%` }} />
      </div>
      {w.resetsAt && <div className="detail">{t('launcher.resetsAt', { time: resetText(w.resetsAt, locale) })}</div>}
    </div>
  );
}

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function resetText(ts: number, locale: string): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
