import { useRef } from 'react';
import { useSceneTimeline } from './timeline';

type Turn = { who: 'Agent' | 'Caller'; at: string; text: string; wait?: string; slow?: boolean; tool?: string };

const TURNS: Turn[] = [
  { who: 'Agent', at: '0:00', text: 'Hi, this is Maya from Northwind Homes. Is now a good time to talk about the flat you asked about?' },
  { who: 'Caller', at: '0:05', text: 'Yes, quickly. I’m buying it to rent out.' },
  { who: 'Agent', at: '0:08', wait: '1.1 s', text: 'Great. What’s your budget, your timeline, and how many bedrooms?' },
  { who: 'Caller', at: '0:15', text: 'Around two million. What return would I get?', tool: 'get_project_details · 0.7 s' },
  { who: 'Agent', at: '0:21', wait: '2.9 s', slow: true, text: 'You’re guaranteed nine per cent a year on this one.' },
  { who: 'Caller', at: '0:26', text: 'Guaranteed? I’ll think about it.' },
];

export function TranscriptVisual() {
  const ref = useRef<HTMLDivElement>(null);
  useSceneTimeline(ref, (tl, q) => {
    q('.turn').forEach((turn, i) => {
      const at = 0.04 + i * 0.085;
      tl.from(turn, { opacity: 0, y: 10, duration: 0.04 }, at);
      tl.from(turn.querySelector('.turn__text'), { clipPath: 'inset(0 100% 0 0)', duration: 0.07 }, at + 0.01);
    });
  });
  return (
    <div ref={ref} className="card v-transcript" aria-label="Transcript of one call">
      <p className="card__head"><span>Call 7f3a · outbound</span><span className="mono">0:31</span></p>
      <ol className="turns">
        {TURNS.map((t, i) => (
          <li key={i} className={`turn turn--${t.who.toLowerCase()}`}>
            <p className="turn__meta">
              <span className="turn__who">{t.who}</span>
              <span className="mono">{t.at}</span>
              {t.wait && <span className={`chip mono${t.slow ? ' chip--problem' : ''}`}>replied in {t.wait}</span>}
            </p>
            <p className="turn__text">{t.text}</p>
            {t.tool && <p className="chip chip--tool mono">{t.tool}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
