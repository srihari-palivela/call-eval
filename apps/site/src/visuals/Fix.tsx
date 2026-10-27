import { useRef } from 'react';
import { useSceneTimeline } from './timeline';

export function FixVisual() {
  const ref = useRef<HTMLDivElement>(null);
  useSceneTimeline(ref, (tl, q) => {
    tl.from(q('.v-fix > *'), { opacity: 0, y: 16, stagger: 0.03, duration: 0.07 }, 0.02);
    tl.from(q('.diff__strike'), { scaleX: 0, transformOrigin: '0 50%', duration: 0.08 }, 0.2);
    tl.from(q('.diff__add .diff__text'), { clipPath: 'inset(0 100% 0 0)', duration: 0.14 }, 0.28);
  });
  return (
    <div ref={ref} className="card v-fix">
      <p className="label">Recommendation · prompt change</p>
      <p className="v-fix__title">Ask one question at a time, starting with what the home is for.</p>
      <p className="v-fix__meta"><span>Moves question discipline and need fit</span><span>Seen in 214 calls</span><span className="good">About +6 points expected</span></p>
      <div className="diff mono" aria-label="Prompt change">
        <p className="diff__del"><span aria-hidden="true">−</span><span className="diff__text">Ask about budget, timeline and bedrooms together.<i className="diff__strike" /></span></p>
        <p className="diff__add"><span aria-hidden="true">+</span><span className="diff__text">Ask one question at a time. Start with whether the home is to live in or to rent out.</span></p>
      </div>
      <p className="v-fix__actions"><span className="btn btn--ghost btn--sm">Open the 214 calls</span><span className="btn btn--primary btn--sm">Accept</span></p>
    </div>
  );
}
