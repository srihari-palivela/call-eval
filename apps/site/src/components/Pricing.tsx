import { useState } from 'react';
import { ENTERPRISE, PLANS, PRICING_NOTES } from '../content';
import { salesMailto, signupFor } from '../site';

const usd = (n: number) => `$${n.toLocaleString('en-US')}`;

export function Pricing() {
  const [annual, setAnnual] = useState(false);
  return (
    <section className="pricing" id="pricing" aria-labelledby="pricing-title">
      <div className="pricing__head">
        <h2 id="pricing-title" className="section-title">Pay for the calls you score</h2>
        <p className="section-lede">Plans include scored calls each month; pay as you go draws on prepaid credit. Voice minutes and lead data stay on your own accounts.</p>
        <div className="toggle" role="group" aria-label="Billing period">
          <button type="button" aria-pressed={!annual} onClick={() => setAnnual(false)}>Monthly</button>
          <button type="button" aria-pressed={annual} onClick={() => setAnnual(true)}>Annual <span className="toggle__save">2 months free</span></button>
        </div>
      </div>
      <div className="plans">
        {PLANS.map((p) => {
          const per = annual && p.monthly ? Math.round((p.monthly * 10) / 12) : p.monthly;
          return (
            <article key={p.id} className={`plan${p.highlight ? ' plan--highlight' : ''}`} aria-labelledby={`plan-${p.id}`}>
              {p.highlight && <p className="plan__badge">{p.highlight}</p>}
              <h3 id={`plan-${p.id}`}>{p.name}</h3>
              <p className="plan__tagline">{p.tagline}</p>
              <p className="plan__price"><span className="plan__amount">{usd(per)}</span><span className="plan__per">/month</span></p>
              <p className="plan__billing">{p.monthly === 0 ? 'No monthly fee' : annual ? `${usd(p.monthly * 10)} billed yearly` : 'Billed monthly'}</p>
              <ul className="plan__facts">
                <li><strong>{p.calls}</strong></li>
                <li>{p.extra}</li>
                <li>{p.seats}</li>
                <li>{p.drafts}</li>
                <li>{p.cycles}</li>
              </ul>
              <ul className="plan__adds">{p.adds.map((a) => <li key={a}>{a}</li>)}</ul>
              <a className={`btn ${p.highlight ? 'btn--primary' : 'btn--ghost'} plan__cta`} href={signupFor(p.id)}>{p.cta}</a>
            </article>
          );
        })}
      </div>
      <article className="plan plan--enterprise" aria-labelledby="plan-enterprise">
        <div>
          <h3 id="plan-enterprise">{ENTERPRISE.name}</h3>
          <p className="plan__tagline">{ENTERPRISE.tagline}</p>
        </div>
        <ul className="plan__adds plan__adds--row">{ENTERPRISE.adds.map((a) => <li key={a}>{a}</li>)}</ul>
        <a className="btn btn--ghost" href={salesMailto}>Talk to us</a>
      </article>
      <ul className="pricing__notes">{PRICING_NOTES.map((n) => <li key={n}>{n}</li>)}</ul>
    </section>
  );
}
