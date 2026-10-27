import { useEffect, useState } from 'react';
import { SITE } from '../site';
import { scrollToTarget } from '../scroll';

export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="10.5" fill="none" stroke="currentColor" strokeOpacity=".4" strokeWidth="1.6" />
      <circle cx="16" cy="16" r="5" fill="var(--good)" />
      <circle cx="25" cy="7.5" r="2.6" fill="var(--problem)" />
    </svg>
  );
}

export function Nav() {
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const on = () => setSolid(window.scrollY > 24);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  // In-page links go through the smooth scroller when it runs.
  const jump = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const href = e.currentTarget.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      e.preventDefault();
      scrollToTarget(href);
      history.replaceState(null, '', href);
    }
  };
  return (
    <nav className={`nav${solid ? ' is-solid' : ''}`} aria-label="Main">
      <a className="nav__brand" href="#top" onClick={jump}><Mark /><span>{SITE.brand}</span></a>
      <div className="nav__links">
        <a href="#calls" onClick={jump}>How it works</a>
        <a href="#pricing" onClick={jump}>Pricing</a>
        <a href="#faq" onClick={jump}>FAQ</a>
      </div>
      <div className="nav__actions">
        <a className="nav__signin" href={SITE.appUrl}>Sign in</a>
        <a className="btn btn--primary btn--sm" href={SITE.signupUrl}>Start free trial</a>
      </div>
    </nav>
  );
}
