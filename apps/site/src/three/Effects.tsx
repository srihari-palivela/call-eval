// Bloom on laptops and desktops only: the orbs' colours run above 1, so the bright ones glow.
import { Bloom, EffectComposer } from '@react-three/postprocessing';

export default function Effects() {
  return (
    <EffectComposer multisampling={0}>
      <Bloom mipmapBlur intensity={0.9} luminanceThreshold={0.18} luminanceSmoothing={0.25} radius={0.72} />
    </EffectComposer>
  );
}
