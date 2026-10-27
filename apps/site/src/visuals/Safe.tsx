import { useRef } from 'react';
import { useSceneTimeline } from './timeline';

// The interval on the change in median score, challenger minus current, from wide (unproven) to narrow and above zero.
const X = (v: number) => 20 + ((v + 10) / 30) * 260;

export function SafeVisual() {
  const ref = useRef<HTMLDivElement>(null);
  useSceneTimeline(ref, (tl, q) => {
    tl.from(q('.lane'), { opacity: 0, x: -30, stagger: 0.05, duration: 0.08 }, 0.02);
    const band = q('.ci__band')[0];
    tl.fromTo(band, { attr: { x: X(-6), width: X(16) - X(-6) } }, { attr: { x: X(3), width: X(11) - X(3) }, duration: 0.26 }, 0.08);
    tl.fromTo(q('.ci__early'), { opacity: 1 }, { opacity: 0, duration: 0.04 }, 0.3);
    tl.fromTo(q('.ci__proven'), { opacity: 0 }, { opacity: 1, duration: 0.04 }, 0.32);
    tl.from(q('.promote'), { opacity: 0, y: 10, duration: 0.05 }, 0.36);
    tl.fromTo(q('.promote__idle'), { opacity: 1 }, { opacity: 0, duration: 0.03 }, 0.46);
    tl.fromTo(q('.promote__done'), { opacity: 0 }, { opacity: 1, duration: 0.03 }, 0.47);
  });
  return (
    <div ref={ref} className="card v-safe">
      <div className="lane">
        <p><span>Current prompt</span><span className="mono">80% of calls · median 71</span></p>
        <span className="lane__track" aria-hidden="true"><i /><i /><i /><i /><i /></span>
      </div>
      <div className="lane lane--challenger">
        <p><span>Challenger</span><span className="mono">20% of calls · median 78</span></p>
        <span className="lane__track" aria-hidden="true"><i /><i /><i /></span>
      </div>
      <svg className="ci" viewBox="0 0 300 64" role="img" aria-label="Gain of 7 points, 95% interval 3 to 11 points">
        <line x1={X(0)} x2={X(0)} y1="8" y2="40" className="ci__zero" />
        <rect className="ci__band" x={X(3)} y="18" width={X(11) - X(3)} height="12" rx="6" />
        <circle cx={X(7)} cy="24" r="4" className="ci__point" />
        <text x={X(0)} y="56" className="ci__tick">0</text>
      </svg>
      <p className="ci__label"><span className="ci__early" style={{ opacity: 0 }}>Not proven yet: the interval still crosses zero</span><span className="ci__proven">+7 points, 95% interval +3 to +11</span></p>
      <p className="promote"><span className="btn btn--primary btn--sm"><span className="promote__idle" style={{ opacity: 0 }}>Promote</span><span className="promote__done">Promoted ✓</span></span><span className="promote__who">You approve each promotion, or let verified wins go live</span></p>
    </div>
  );
}
