import { SITE } from '../site';

export function Hero() {
  return (
    <header className="hero" id="top">
      <div className="hero__inner">
        <p className="eyebrow">Call quality for AI voice agents</p>
        <h1>Every call your AI agent makes is a story. <em>Read all of them.</em></h1>
        <p className="lede">
          Score every call your ElevenLabs or Retell AI agent makes against 62 metrics and 9 compliance gates, see which
          callers and journeys go wrong, and ship fixes proven on live calls.
        </p>
        <p className="cta-row">
          <a className="btn btn--primary btn--lg" href={SITE.signupUrl}>Start free trial</a>
          <a className="btn btn--ghost btn--lg" href="#pricing">See pricing</a>
        </p>
        <p className="fine">14-day trial · No card · 250 scored calls</p>
      </div>
      <a className="scroll-cue" href="#calls"><span>Follow one call</span><i aria-hidden="true" /></a>
    </header>
  );
}
