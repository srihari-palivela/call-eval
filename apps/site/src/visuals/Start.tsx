import { useRef } from 'react';
import { SITE } from '../site';
import { useSceneTimeline } from './timeline';

export function StartVisual() {
  const ref = useRef<HTMLDivElement>(null);
  useSceneTimeline(ref, (tl, q) => {
    tl.from(q('.v-start > *'), { opacity: 0, y: 18, stagger: 0.05, duration: 0.08 }, 0.02);
  });
  return (
    <div ref={ref} className="v-start">
      <p className="works">Works with <span>ElevenLabs</span> <span>Retell AI</span> <span>Apollo.io</span> <span>recording uploads</span></p>
      <p className="cta-row">
        <a className="btn btn--primary btn--lg" href={SITE.signupUrl}>Start free trial</a>
        <a className="btn btn--ghost btn--lg" href="#pricing">See pricing</a>
      </p>
      <p className="fine">14 days · No card · 250 scored calls · 10 co-pilot drafts</p>
    </div>
  );
}
