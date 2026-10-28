import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { translator } from '../../shared/i18n/index.ts';
import type { SessionsView } from '../../shared/ipc.ts';
import { PERIODS, type Period } from '../../shared/stats.ts';
import { Heatmap, Trend } from './Charts.tsx';

// Session window: one pack's usage per session for a period, from the ledger.
// Sessions have no titles (that would mean reading conversation content), so they
// are identified by the start of their id plus their dates and models.

const api = window.nekoSessions;

export function App() {
  const [period, setPeriod] = useState<Period>('today');
  const [view, setView] = useState<SessionsView | null>(null);

  const load = useCallback(() => {
    void api.get(period).then((v) => v && setView(v));
  }, [period]);

  useEffect(() => {
    load();
    return api.onChanged(load);
  }, [load]);

  if (!view) return null;
  const t = translator(view.locale);
  const fill = view.theme.gradient ? `linear-gradient(90deg, ${view.theme.gradient.join(', ')})` : view.theme.color;
  const style = { '--pack': view.theme.color, '--pack-fill': fill } as CSSProperties;
  const max = Math.max(1, ...view.rows.map((r) => r.usage.active));

  return (
    <div className="page" style={style}>
      <header>
        <h1>{view.packName}</h1>
        <div className="tabs">
          {PERIODS.map((p) => (
            <button key={p} className={p === period ? 'tab active' : 'tab'} onClick={() => setPeriod(p)}>
              {t(`period.${p}`)}
            </button>
          ))}
        </div>
      </header>

      <div className="charts">
        <Heatmap daily={view.daily} today={view.today} t={t} locale={view.locale} fmt={fmt} />
        <Trend daily={view.daily} today={view.today} t={t} locale={view.locale} fmt={fmt} />
      </div>

      <p className="summary">
        {t('sessions.summary', {
          tokens: fmt(view.totals.active),
          sessions: view.totals.sessions,
          input: fmt(view.totals.input),
          output: fmt(view.totals.output),
          cacheRead: fmt(view.totals.cacheRead),
        })}
      </p>

      {view.rows.length === 0 ? (
        <p className="empty">{t('sessions.empty')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('sessions.session')}</th>
              <th>{t('sessions.dates')}</th>
              <th className="num">{t('sessions.tokens')}</th>
              <th className="num">{t('sessions.input')}</th>
              <th className="num">{t('sessions.output')}</th>
              <th className="num">{t('sessions.cacheRead')}</th>
              <th className="num">{t('sessions.messages')}</th>
              <th>{t('sessions.models')}</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr key={r.key}>
                <td>
                  <code title={r.sessionId}>{shortId(r.sessionId)}</code>
                  {r.retained && (
                    <span className="badge" title={t('sessions.retainedHint')}>
                      {t('sessions.retained')}
                    </span>
                  )}
                </td>
                <td className="dates">{r.firstDate === r.lastDate ? r.firstDate.slice(5) : `${r.firstDate.slice(5)} – ${r.lastDate.slice(5)}`}</td>
                <td className="num tokens">
                  <span>{fmt(r.usage.active)}</span>
                  <div className="bar">
                    <div style={{ width: `${(r.usage.active / max) * 100}%` }} />
                  </div>
                </td>
                <td className="num">{fmt(r.usage.input)}</td>
                <td className="num">{fmt(r.usage.output)}</td>
                <td className="num">{fmt(r.usage.cacheRead)}</td>
                <td className="num">{r.usage.messages}</td>
                <td className="models">{r.models.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {view.truncated && <p className="empty">{t('sessions.truncated', { count: view.rows.length })}</p>}
    </div>
  );
}

/** A session id is a UUID or a long rollout file name; show a recognizable part */
function shortId(id: string): string {
  const uuid = id.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  return (uuid ?? id).slice(0, 8);
}

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
