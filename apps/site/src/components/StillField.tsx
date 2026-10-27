// The still frame: a field of calls drawn as plain SVG, the same on the server and in the browser. It is what
// people see before the 3D scene loads, and all they see with reduced motion or without WebGL.
const N = 190;

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DOTS = (() => {
  const r = mulberry32(1284);
  return Array.from({ length: N }, (_, i) => {
    const depth = r();
    const kind = i % 37 === 0 ? 'problem' : i % 7 === 0 ? 'neutral' : 'good';
    return { x: r() * 1600, y: r() * 900, r: 1.2 + depth * 4.2, o: 0.18 + depth * 0.6, kind };
  });
})();

export function StillField() {
  return (
    <div className="still" aria-hidden="true">
      <svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
        {DOTS.map((d, i) => (
          <circle key={i} cx={d.x.toFixed(1)} cy={d.y.toFixed(1)} r={d.r.toFixed(2)} opacity={d.o.toFixed(2)} className={`still__dot still__dot--${d.kind}`} />
        ))}
      </svg>
    </div>
  );
}
