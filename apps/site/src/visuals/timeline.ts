// A scene visual's animation, scrubbed by the scroll position through its scene. The markup's own state is
// the final frame, so the prerendered page, reduced motion and no-JavaScript readers all see it complete.
import { useEffect, useLayoutEffect, type RefObject } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useDevice } from '../device';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

// Animations play over the first 60% of a scene; the rest holds the final frame while the next scene arrives.
export const HOLD = 0.4;

export function useSceneTimeline(ref: RefObject<HTMLElement>, build: (tl: gsap.core.Timeline, q: (sel: string) => HTMLElement[]) => void) {
  const { motion } = useDevice();
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (motion !== 'full' || !el) return;
    gsap.registerPlugin(ScrollTrigger);
    const section = el.closest('[data-scene]');
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({
        defaults: { ease: 'none', duration: 0.1 },
        scrollTrigger: { trigger: section, start: 'top 70%', end: 'bottom bottom', scrub: 0.6 },
      });
      build(tl, gsap.utils.selector(el) as unknown as (sel: string) => HTMLElement[]);
      tl.to({}, { duration: HOLD });
    }, el);
    return () => ctx.revert();
  }, [motion]);
}

/** A counter from 0 to its final value, scrubbed; the element keeps its final text when not animated. */
export function countUp(tl: gsap.core.Timeline, el: HTMLElement, at: number | string, duration = 0.25) {
  const to = Number(el.dataset.n ?? '0');
  const v = { n: 0 };
  tl.fromTo(v, { n: 0 }, { n: to, duration, onUpdate: () => { el.textContent = Math.round(v.n).toLocaleString('en-US'); } }, at);
}
