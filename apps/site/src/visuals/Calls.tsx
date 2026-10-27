import { useRef } from 'react';
import { countUp, useSceneTimeline } from './timeline';

export function CallsVisual() {
  const ref = useRef<HTMLDivElement>(null);
  useSceneTimeline(ref, (tl, q) => {
    countUp(tl, q('[data-total]')[0], 0, 0.3);
    tl.from(q('li'), { opacity: 0, x: 24, stagger: 0.06, duration: 0.12 }, 0.12);
    q('li b').forEach((b, i) => countUp(tl, b, 0.14 + i * 0.06, 0.2));
  });
  return (
    <div ref={ref} className="card v-calls">
      <p className="v-calls__total"><span data-total data-n="1284">1,284</span><small>calls today</small></p>
      <ul className="v-calls__legend">
        <li><i className="dot dot--good" /><b data-n="1141">1,141</b> went well</li>
        <li><i className="dot dot--neutral" /><b data-n="117">117</b> fell below the Good line</li>
        <li><i className="dot dot--problem" /><b data-n="26">26</b> broke a rule or lost the lead</li>
      </ul>
    </div>
  );
}
