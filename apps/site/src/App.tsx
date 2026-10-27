import { lazy, Suspense, useEffect, useState } from 'react';
import { DeviceProvider, useDevice } from './device';
import { startStoryScroll } from './scroll';
import { Nav } from './components/Nav';
import { Hero } from './components/Hero';
import { StillField } from './components/StillField';
import { Story } from './components/Story';
import { Proof } from './components/Proof';
import { Pricing } from './components/Pricing';
import { Faq } from './components/Faq';
import { Footer } from './components/Footer';

const Stage = lazy(() => import('./three/Stage'));

// The 3D stage loads after the page has painted, and only where motion is welcome and WebGL works.
function StageMount() {
  const { motion, webgl, mobile } = useDevice();
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (motion !== 'full' || !webgl) return;
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const start = () => setGo(true);
    if (idle) idle(start, { timeout: 1200 });
    else setTimeout(start, 300);
  }, [motion, webgl]);
  if (!go) return null;
  return (
    <Suspense fallback={null}>
      <Stage mobile={mobile} />
    </Suspense>
  );
}

function ScrollRuntime() {
  const { motion } = useDevice();
  useEffect(() => {
    if (motion !== 'full') return;
    return startStoryScroll(true);
  }, [motion]);
  return null;
}

export function App() {
  return (
    <DeviceProvider>
      <ScrollRuntime />
      <a className="skip" href="#pricing">Skip to pricing</a>
      <StillField />
      <StageMount />
      <Nav />
      <main>
        <Hero />
        <Story />
        <div className="after">
          <Proof />
          <Pricing />
          <Faq />
        </div>
      </main>
      <Footer />
    </DeviceProvider>
  );
}
