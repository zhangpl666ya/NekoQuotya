import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { translator, type Translate } from '../../shared/i18n/index.ts';
import type { EditableBehavior, SettingsPackView, SettingsView } from '../../shared/ipc.ts';

// Settings window (frameless, sized to its content):
//   1. which character's pet is on the desktop (one at a time)
//   2. that pack's behavior values, saved as an override in its data/settings.json
//      (pack.json is never edited) and applied to the pet immediately
// The daily budget only matters when the mood follows it: for tools without a quota
// (API billing), or when the user chooses the budget over the quota.

const api = window.nekoSettings;
const DEFAULT_CHATTER: [number, number] = [15, 30];

export function App() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.get().then((v) => {
      if (!v) return;
      setView(v);
      setEditing(v.activePackId ?? v.packs[0]?.id ?? null);
    });
  }, []);

  // Keep the window exactly as tall as its content
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const report = () => api.resize(Math.ceil(el.getBoundingClientRect().height));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [view]);

  if (!view) return null;
  const t = translator(view.locale);
  const pack = view.packs.find((p) => p.id === editing);

  const choose = async (packId: string | null) => {
    const v = await api.setActive(packId);
    if (v) setView(v);
    if (packId) setEditing(packId);
  };

  return (
    <div className="page" ref={root} style={pack ? ({ '--pack': pack.theme.color } as CSSProperties) : undefined}>
      <div className="titlebar">
        <span>{t('settings.title')}</span>
        <button className="close" aria-label={t('settings.close')} onClick={() => api.close()}>
          ✕
        </button>
      </div>

      <section className="group">
        <div className="group-title">{t('settings.pet')}</div>
        <div className="pets">
          {view.packs.map((p) => (
            <button
              key={p.id}
              className={p.id === view.activePackId ? 'pet active' : 'pet'}
              style={{ '--pack': p.theme.color } as CSSProperties}
              onClick={() => void choose(p.id)}
            >
              <span className="dot" />
              {p.name}
            </button>
          ))}
          <button className={view.activePackId === null ? 'pet active none' : 'pet none'} onClick={() => void choose(null)}>
            {t('settings.petNone')}
          </button>
        </div>
      </section>

      {pack && <PackSettings key={pack.id} pack={pack} t={t} onSaved={setView} />}
    </div>
  );
}

function PackSettings({ pack, t, onSaved }: { pack: SettingsPackView; t: Translate; onSaved: (v: SettingsView) => void }) {
  const [form, setForm] = useState(() => toForm(pack.values));
  const [status, setStatus] = useState<'idle' | 'saved' | 'invalid'>('idle');
  const usesBudget = !pack.hasQuota || form.moodBasis === 'budget';

  const update = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setStatus('idle');
  };

  const save = async (override: Partial<EditableBehavior>) => {
    const result = await api.save({ packId: pack.id, override });
    if (!result) return;
    onSaved(result);
    const updated = result.packs.find((p) => p.id === pack.id);
    if (updated) setForm(toForm(updated.values));
    setStatus('saved');
  };

  const submit = () => {
    const budget = Number(form.dailyBudget);
    const sleep = Number(form.idleSleepMinutes);
    if ((usesBudget && (!Number.isInteger(budget) || budget <= 0)) || !(sleep > 0)) return setStatus('invalid');
    void save({
      ...(Number.isInteger(budget) && budget > 0 ? { dailyBudget: budget } : {}),
      moodBasis: pack.hasQuota ? form.moodBasis : 'budget',
      idleSleepMinutes: sleep,
      chatterMinutes: form.chatter ? (pack.defaults.chatterMinutes ?? DEFAULT_CHATTER) : null,
    });
  };

  return (
    <section className="group">
      <div className="group-title pack-name">{pack.name}</div>

      {pack.hasQuota && (
        <label className="field">
          <span>{t('settings.moodBasis')}</span>
          <select value={form.moodBasis} onChange={(e) => update({ moodBasis: e.target.value as Form['moodBasis'] })}>
            <option value="quota">{t('settings.moodBasis.quota')}</option>
            <option value="budget">{t('settings.moodBasis.budget')}</option>
          </select>
        </label>
      )}

      {usesBudget && (
        <label className="field">
          <span>{t('settings.dailyBudget')}</span>
          <input type="number" min={1} step={100000} value={form.dailyBudget} onChange={(e) => update({ dailyBudget: e.target.value })} />
          <small>{t('settings.dailyBudgetHint')}</small>
        </label>
      )}

      <label className="field">
        <span>{t('settings.idleSleepMinutes')}</span>
        <input type="number" min={1} step={5} value={form.idleSleepMinutes} onChange={(e) => update({ idleSleepMinutes: e.target.value })} />
      </label>

      <label className="check">
        <input type="checkbox" checked={form.chatter} onChange={(e) => update({ chatter: e.target.checked })} />
        {t('settings.chatter')}
      </label>

      <div className="actions">
        <button className="primary" onClick={submit}>
          {t('settings.save')}
        </button>
        <button onClick={() => void save({})}>{t('settings.reset')}</button>
        {status === 'saved' && <span className="ok">{t('settings.saved')}</span>}
        {status === 'invalid' && <span className="err">{t('settings.invalid')}</span>}
      </div>
    </section>
  );
}

interface Form {
  dailyBudget: string;
  moodBasis: EditableBehavior['moodBasis'];
  idleSleepMinutes: string;
  chatter: boolean;
}

function toForm(v: EditableBehavior): Form {
  return {
    dailyBudget: String(v.dailyBudget),
    moodBasis: v.moodBasis,
    idleSleepMinutes: String(v.idleSleepMinutes),
    chatter: v.chatterMinutes !== null,
  };
}
