import type { Translate } from '../../shared/i18n/index.ts';
import type { DayTotal } from '../../shared/stats.ts';

// Two small charts above the session table, both from active tokens per day:
//   Heatmap  the last 26 weeks, one cell per day (columns = weeks from Monday)
//   Trend    the last 60 days as bars, with the peak day called out

const HEATMAP_WEEKS = 26;
const TREND_DAYS = 60;

interface ChartProps {
  daily: DayTotal[];
  today: string;
  t: Translate;
  locale: string;
  fmt: (n: number) => string;
}

export function Heatmap({ daily, today, t, locale, fmt }: ChartProps) {
  const byDate = new Map(daily.map((d) => [d.date, d.active]));
  const monday = shift(today, -weekday(today));
  const start = shift(monday, -(HEATMAP_WEEKS - 1) * 7);
  const levels = levelScale(daily.filter((d) => d.date >= start).map((d) => d.active));

  const weeks: Array<{ month: string | null; days: Array<{ date: string; active: number; future: boolean }> }> = [];
  let lastMonth = '';
  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    const first = shift(start, w * 7);
    const month = first.slice(0, 7);
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = shift(first, i);
      return { date, active: byDate.get(date) ?? 0, future: date > today };
    });
    weeks.push({ month: month !== lastMonth ? monthName(first, locale) : null, days });
    lastMonth = month;
  }
  const activeDays = daily.filter((d) => d.date >= start).length;

  return (
    <section className="chart">
      <div className="chart-head">
        <span className="chart-title">{t('sessions.activity')}</span>
        <span className="chart-meta">{t('sessions.activeDays', { count: activeDays })}</span>
      </div>
      <div className="heatmap">
        {weeks.map((week, w) => (
          <div className="hm-week" key={w}>
            <span className="hm-month">{week.month ?? ''}</span>
            {week.days.map((d) => (
              <span
                key={d.date}
                className={d.future ? 'hm-cell future' : `hm-cell l${levels(d.active)}`}
                title={d.future ? '' : t('sessions.dayTip', { date: d.date, tokens: fmt(d.active) })}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="hm-legend">
        {t('sessions.less')}
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className={`hm-cell l${l}`} />
        ))}
        {t('sessions.more')}
      </div>
    </section>
  );
}

export function Trend({ daily, today, t, fmt }: ChartProps) {
  const byDate = new Map(daily.map((d) => [d.date, d.active]));
  const days = Array.from({ length: TREND_DAYS }, (_, i) => {
    const date = shift(today, i - (TREND_DAYS - 1));
    return { date, active: byDate.get(date) ?? 0 };
  });
  const peak = days.reduce((best, d) => (d.active > best.active ? d : best), days[0]!);
  const max = Math.max(1, peak.active);
  const label = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

  return (
    <section className="chart">
      <div className="chart-head">
        <span className="chart-title">{t('sessions.trend')}</span>
        <span className="chart-meta">{peak.active > 0 && t('sessions.peak', { tokens: fmt(peak.active) })}</span>
      </div>
      <div className="trend">
        {days.map((d) => (
          <span
            key={d.date}
            className={d === peak && d.active > 0 ? 'tr-bar peak' : 'tr-bar'}
            style={{ height: `${d.active > 0 ? Math.max(3, (d.active / max) * 100) : 0}%` }}
            title={t('sessions.dayTip', { date: d.date, tokens: fmt(d.active) })}
          />
        ))}
      </div>
      <div className="tr-axis">
        <span>{label(days[0]!.date)}</span>
        <span>{label(days[Math.floor(TREND_DAYS / 2)]!.date)}</span>
        <span>{label(today)}</span>
      </div>
    </section>
  );
}

/**
 * Map a day's tokens to a colour level 0–4 by quartiles of the active days shown,
 * so one huge day doesn't wash every other day out to the lightest shade.
 */
function levelScale(values: number[]): (v: number) => number {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return () => 0;
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  return (v) => (v <= 0 ? 0 : v <= cuts[0]! ? 1 : v <= cuts[1]! ? 2 : v <= cuts[2]! ? 3 : 4);
}

/** YYYY-MM-DD shifted by whole days (local calendar, no time zone drift) */
function shift(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const next = new Date(y, m - 1, d + days);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

/** Monday = 0 … Sunday = 6 */
function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
}

function monthName(date: string, locale: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return new Date(y, m - 1, 1).toLocaleString(locale, { month: 'short' });
}
