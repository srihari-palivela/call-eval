import { useRef } from 'react';
import { gsap } from 'gsap';
import { countUp, useSceneTimeline } from './timeline';

const STAGES = [
  { name: 'New', n: 420 },
  { name: 'Contacted', n: 236 },
  { name: 'Qualified', n: 98 },
  { name: 'Meeting booked', n: 41 },
];
// A 24-hour dial: calls are allowed from 9:00 to 18:00 (the UAE's telemarketing hours).
const CX = 64, CY = 64, R = 50, OPEN = 9, CLOSE = 18;
const at = (h: number) => {
  const a = (h / 24) * Math.PI * 2 - Math.PI / 2;
  return `${(CX + R * Math.cos(a)).toFixed(2)} ${(CY + R * Math.sin(a)).toFixed(2)}`;
};
const hhmm = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}`;

export function LeadsVisual() {
  const ref = useRef<HTMLDivElement>(null);
  useSceneTimeline(ref, (tl, q) => {
    q('.fstage__fill').forEach((f, i) => tl.from(f, { scaleX: 0, duration: 0.08 }, 0.02 + i * 0.05));
    q('.fstage b').forEach((b, i) => countUp(tl, b, 0.02 + i * 0.05, 0.1));
    const hand = q('.clock__hand')[0];
    const time = q('.clock__time')[0];
    const state = q('.clock__state')[0];
    tl.fromTo(hand, { rotation: (7.5 / 24) * 360, svgOrigin: `${CX} ${CY}` }, {
      rotation: (18.5 / 24) * 360, svgOrigin: `${CX} ${CY}`, duration: 0.4,
      onUpdate: () => {
        const h = ((Number(gsap.getProperty(hand, 'rotation')) / 360) * 24 + 24) % 24;
        const open = h >= OPEN && h < CLOSE;
        time.textContent = hhmm(h);
        state.textContent = open ? 'Calling' : 'Paused until 9:00';
        state.classList.toggle('is-open', open);
      },
    }, 0.1);
    tl.from(q('.rules li'), { opacity: 0, y: 10, stagger: 0.04, duration: 0.06 }, 0.3);
  });
  return (
    <div ref={ref} className="card v-leads">
      <ol className="fstages">
        {STAGES.map((s) => (
          <li key={s.name} className="fstage">
            <p><span>{s.name}</span><b className="mono" data-n={s.n}>{s.n}</b></p>
            <span className="fstage__bar"><span className="fstage__fill" style={{ width: `${(s.n / STAGES[0].n) * 100}%` }} /></span>
          </li>
        ))}
      </ol>
      <div className="clock">
        <svg viewBox="0 0 128 128" role="img" aria-label="Calls are placed only between 9:00 and 18:00">
          <circle cx={CX} cy={CY} r={R} className="clock__ring" />
          <path d={`M${at(OPEN)} A${R} ${R} 0 0 1 ${at(CLOSE)}`} className="clock__open" />
          <g className="clock__hand" transform={`rotate(${(18.5 / 24) * 360} ${CX} ${CY})`}>
            <line x1={CX} y1={CY - R + 22} x2={CX} y2={CY - R + 8} />
            <circle cx={CX} cy={CY - R} r="5" />
          </g>
          <text x={CX} y={CY + 2} className="clock__time">18:30</text>
          <text x={CX} y={CY + 18} className="clock__hours">open 9:00–18:00</text>
        </svg>
        <p className="clock__state">Paused until 9:00</p>
      </div>
      <ul className="rules">
        <li>Do-not-call list checked</li>
        <li>No second call after a no</li>
        <li>Retries paced by country</li>
      </ul>
    </div>
  );
}
