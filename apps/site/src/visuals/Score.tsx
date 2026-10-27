import { useRef } from 'react';
import { useSceneTimeline } from './timeline';

const C = 2 * Math.PI * 52;
const PHASES = [
  { name: 'Introduction', v: 78 },
  { name: 'Body', v: 61 },
  { name: 'Conclusion', v: 70 },
];
const CHIPS = [
  { ok: true, text: 'Used the project’s own data' },
  { ok: false, text: 'Asked three questions at once' },
  { ok: false, text: 'Took 2.9 s to answer' },
  { ok: true, text: 'Confirmed what the caller wanted' },
];

export function ScoreVisual() {
  const ref = useRef<HTMLDivElement>(null);
  useSceneTimeline(ref, (tl, q) => {
    q('.phase__fill').forEach((f, i) => tl.from(f, { scaleX: 0, duration: 0.1 }, 0.02 + i * 0.04));
    tl.from(q('.score-chip'), { opacity: 0, x: (i) => (i % 2 ? 60 : -60), y: (i) => 30 - i * 18, stagger: 0.03, duration: 0.08 }, 0.08);
    const arc = q('.dial__arc')[0];
    tl.set(arc, { stroke: 'var(--good)' }, 0);
    tl.fromTo(arc, { strokeDashoffset: C }, { strokeDashoffset: C * (1 - 0.68), duration: 0.16 }, 0.1);
    tl.fromTo(q('.dial__before'), { opacity: 1 }, { opacity: 1, duration: 0.01 }, 0.1);
    tl.from(q('.gate'), { opacity: 0, scale: 1.25, duration: 0.05 }, 0.34);
    tl.set(arc, { stroke: 'var(--problem)' }, 0.38);
    tl.to(arc, { strokeDashoffset: C * (1 - 0.4), duration: 0.08 }, 0.38);
    tl.fromTo(q('.dial__before'), { opacity: 1 }, { opacity: 0, duration: 0.04 }, 0.38);
    tl.fromTo(q('.dial__after'), { opacity: 0 }, { opacity: 1, duration: 0.04 }, 0.4);
    tl.from(q('.dial__note'), { opacity: 0, duration: 0.05 }, 0.44);
  });
  return (
    <div ref={ref} className="card v-score">
      <div className="v-score__top">
        <svg className="dial" viewBox="0 0 132 132" role="img" aria-label="Call quality score capped at 40">
          <circle cx="66" cy="66" r="52" className="dial__track" />
          <circle cx="66" cy="66" r="52" className="dial__arc" strokeDasharray={C} strokeDashoffset={C * 0.6} />
          <text x="66" y="74" className="dial__value dial__before" style={{ opacity: 0 }}>68</text>
          <text x="66" y="74" className="dial__value dial__after">40</text>
        </svg>
        <div className="phases">
          {PHASES.map((p) => (
            <div key={p.name} className="phase">
              <p><span>{p.name}</span><span className="mono">{p.v}</span></p>
              <span className="phase__bar"><span className="phase__fill" style={{ width: `${p.v}%` }} /></span>
            </div>
          ))}
        </div>
      </div>
      <ul className="score-chips">
        {CHIPS.map((c) => (
          <li key={c.text} className={`score-chip ${c.ok ? 'is-ok' : 'is-bad'}`}><span aria-hidden="true">{c.ok ? '✓' : '✕'}</span>{c.text}</li>
        ))}
      </ul>
      <p className="gate"><strong>Compliance gate</strong> Promised a guaranteed return</p>
      <p className="dial__note">Capped at 40 and sent to a reviewer</p>
    </div>
  );
}
