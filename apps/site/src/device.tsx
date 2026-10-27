// What this visitor's device can do. Unknown on the server and in the first paint (so the prerendered
// page and the first client render match); known once mounted.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Motion = 'unknown' | 'full' | 'reduced';
export type Device = { motion: Motion; webgl: boolean; mobile: boolean };

const DeviceContext = createContext<Device>({ motion: 'unknown', webgl: false, mobile: false });

function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export function DeviceProvider({ children }: { children: ReactNode }) {
  const [device, setDevice] = useState<Device>({ motion: 'unknown', webgl: false, mobile: false });
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const small = window.matchMedia('(max-width: 760px)');
    const detect = () => {
      const webgl = hasWebGL();
      const mobile = small.matches || (navigator.hardwareConcurrency ?? 8) <= 4;
      const motion: Motion = reduce.matches ? 'reduced' : 'full';
      document.documentElement.dataset.motion = motion;
      document.documentElement.dataset.webgl = String(webgl);
      setDevice({ motion, webgl, mobile });
    };
    detect();
    reduce.addEventListener('change', detect);
    small.addEventListener('change', detect);
    return () => {
      reduce.removeEventListener('change', detect);
      small.removeEventListener('change', detect);
    };
  }, []);
  return <DeviceContext.Provider value={device}>{children}</DeviceContext.Provider>;
}

export const useDevice = () => useContext(DeviceContext);
