import { SITE } from '../site';
import { Mark } from './Nav';

export function Footer() {
  return (
    <footer className="footer">
      <p className="footer__brand"><Mark /><span>{SITE.brand}</span></p>
      <nav className="footer__links" aria-label="Footer">
        <a href={SITE.appUrl}>Sign in</a>
        <a href="#pricing">Pricing</a>
        <a href="#">Terms</a>
        <a href="#">Privacy</a>
        <a href="#">Status</a>
        <a href={`mailto:${SITE.salesEmail}`}>Contact</a>
      </nav>
      <p className="footer__fine">© 2026 {SITE.brand}. Prices in US dollars before VAT.</p>
    </footer>
  );
}
