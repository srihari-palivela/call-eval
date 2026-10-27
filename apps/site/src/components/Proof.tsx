import { PROOF } from '../content';

export function Proof() {
  return (
    <section className="proof" aria-labelledby="proof-title">
      <h2 id="proof-title" className="section-title">Built for teams that answer for every call</h2>
      <ul className="proof__grid">
        {PROOF.map((p) => (
          <li key={p.title}><h3>{p.title}</h3><p>{p.body}</p></li>
        ))}
      </ul>
    </section>
  );
}
