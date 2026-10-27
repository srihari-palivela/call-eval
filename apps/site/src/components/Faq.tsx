import { FAQ } from '../content';

export function Faq() {
  return (
    <section className="faq" id="faq" aria-labelledby="faq-title">
      <h2 id="faq-title" className="section-title">Questions</h2>
      <div className="faq__list">
        {FAQ.map((f) => (
          <details key={f.q}>
            <summary>{f.q}</summary>
            <p>{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
