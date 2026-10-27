import type { ReactNode } from 'react';
import { SCENES } from '../content';
import { CallsVisual } from '../visuals/Calls';
import { TranscriptVisual } from '../visuals/Transcript';
import { ScoreVisual } from '../visuals/Score';
import { PatternsVisual } from '../visuals/Patterns';
import { FixVisual } from '../visuals/Fix';
import { SafeVisual } from '../visuals/Safe';
import { LeadsVisual } from '../visuals/Leads';
import { CopilotVisual } from '../visuals/Copilot';
import { StartVisual } from '../visuals/Start';

const VISUALS: Record<string, ReactNode> = {
  calls: <CallsVisual />,
  'one-call': <TranscriptVisual />,
  scored: <ScoreVisual />,
  patterns: <PatternsVisual />,
  fixes: <FixVisual />,
  safely: <SafeVisual />,
  leads: <LeadsVisual />,
  setup: <CopilotVisual />,
  start: <StartVisual />,
};

export function Story() {
  return (
    <div className="story" aria-label="How it works">
      {SCENES.map((s, i) => (
        <section key={s.id} id={s.id} className={`scene scene--${s.id}`} data-scene={i} aria-labelledby={`${s.id}-claim`}>
          <div className="scene__pin">
            <div className="scene__copy">
              <p className="eyebrow"><span className="mono">{String(i + 1).padStart(2, '0')}</span>{s.eyebrow}</p>
              <h2 id={`${s.id}-claim`} className="claim">{s.claim}</h2>
              <p className="scene__body">{s.body}</p>
            </div>
            <div className="scene__visual">{VISUALS[s.id]}</div>
          </div>
        </section>
      ))}
    </div>
  );
}
