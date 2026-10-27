import { useRef } from 'react';
import { useSceneTimeline } from './timeline';

// A small persona × journey grid: the same picture the 3D scene builds, readable without it.
const ROWS = 7, COLS = 8, WEAK = { r: 3, c: 5 };
const score = (r: number, c: number) => 62 + ((r * 37 + c * 53) % 31);

export function PatternsVisual() {
  const ref = useRef<HTMLDivElement>(null);
  useSceneTimeline(ref, (tl, q) => {
    tl.from(q('.cell'), { opacity: 0, scale: 0.4, transformOrigin: '50% 50%', stagger: { each: 0.002, from: 'random' }, duration: 0.06 }, 0.02);
    tl.from(q('.cell--weak'), { y: 8, duration: 0.08 }, 0.2);
    tl.from(q('.v-patterns__finding > *'), { opacity: 0, y: 12, stagger: 0.04, duration: 0.08 }, 0.24);
  });
  const cells = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const weak = r === WEAK.r && c === WEAK.c;
      const v = weak ? 49 : score(r, c);
      const tone = weak ? 'weak' : v >= 70 ? 'good' : 'mid';
      cells.push(<rect key={`${r}-${c}`} className={`cell cell--${tone}`} x={c * 22} y={r * 22} width="18" height="18" rx="4" />);
    }
  }
  return (
    <div ref={ref} className="card v-patterns">
      <svg viewBox={`0 0 ${COLS * 22 - 4} ${ROWS * 22 - 4}`} className="v-patterns__map" role="img" aria-label="Caller types by journeys; one cell scores far below the rest">
        {cells}
      </svg>
      <div className="v-patterns__finding">
        <p className="label">Weakest cell</p>
        <p className="v-patterns__name">Overseas investors × Discovery</p>
        <p className="mono v-patterns__nums"><span className="problem">49</span> median · 125 calls · 21 points below the line</p>
      </div>
    </div>
  );
}
