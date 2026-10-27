import { useRef } from 'react';
import { useSceneTimeline } from './timeline';

const CARDS = [
  { title: 'Business profile', body: 'Families and overseas investors. Meetings online or at the sales centre. Calls 9:00–18:00.' },
  { title: 'Taxonomy', body: '6 caller types and 9 journeys to score, with the checkpoints each journey should reach.' },
  { title: 'Funnel', body: 'New → Contacted → Viewing booked → Reservation → Sale' },
];

export function CopilotVisual() {
  const ref = useRef<HTMLDivElement>(null);
  useSceneTimeline(ref, (tl, q) => {
    tl.from(q('.bubble--you'), { opacity: 0, y: 12, duration: 0.04 }, 0.02);
    tl.from(q('.bubble--you .bubble__text'), { clipPath: 'inset(0 0 100% 0)', duration: 0.12 }, 0.04);
    tl.from(q('.bubble--copilot'), { opacity: 0, y: 12, duration: 0.05 }, 0.17);
    tl.from(q('.draft'), { opacity: 0, y: 24, rotateX: -35, transformOrigin: '50% 0', stagger: 0.05, duration: 0.08 }, 0.2);
    q('.draft__ok').forEach((ok, i) => {
      tl.fromTo(ok, { opacity: 0.35 }, { opacity: 1, duration: 0.03 }, 0.38 + i * 0.04);
    });
  });
  return (
    <div ref={ref} className="v-copilot">
      <div className="bubble bubble--you">
        <p className="label">You</p>
        <p className="bubble__text">We sell villas in Dubai Hills to families and overseas investors. Meetings are online or at our sales centre.</p>
      </div>
      <div className="bubble bubble--copilot"><p className="label">Co-pilot</p><p>Here’s a draft. Approve each part.</p></div>
      <div className="drafts">
        {CARDS.map((c) => (
          <div key={c.title} className="card draft">
            <p className="draft__title">{c.title}</p>
            <p className="draft__body">{c.body}</p>
            <p className="draft__ok">✓ Approved</p>
          </div>
        ))}
      </div>
    </div>
  );
}
