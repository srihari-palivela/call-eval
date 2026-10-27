// The scroll engine: Lenis smooths the scroll, ScrollTrigger turns it into story progress and scrubs each
// scene's timeline. Client only; set up once motion is known to be welcome.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import { story } from './story';

let lenis: Lenis | null = null;

export function scrollToTarget(target: string | HTMLElement) {
  const el = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
  if (!el) return;
  if (lenis) lenis.scrollTo(el, { offset: 0 });
  else el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function startStoryScroll(smooth: boolean): () => void {
  gsap.registerPlugin(ScrollTrigger);
  const tick = (time: number) => lenis?.raf(time * 1000);
  if (smooth) {
    lenis = new Lenis({ lerp: 0.11, wheelMultiplier: 0.9 });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
  }
  const scenes = Array.from(document.querySelectorAll<HTMLElement>('[data-scene]'));
  const triggers = scenes.map((el, i) =>
    ScrollTrigger.create({
      trigger: el,
      start: 'top top',
      end: 'bottom bottom',
      onUpdate: (self) => {
        story.t = Math.min(scenes.length - 0.001, i + self.progress);
      },
    }),
  );
  const refresh = () => ScrollTrigger.refresh();
  document.fonts?.ready.then(refresh);
  window.addEventListener('load', refresh);
  return () => {
    triggers.forEach((t) => t.kill());
    window.removeEventListener('load', refresh);
    gsap.ticker.remove(tick);
    lenis?.destroy();
    lenis = null;
  };
}
