import { useEffect, useState } from 'react';
import { api, type Branding } from '../api';

let current: Branding | null = null;
const listeners = new Set<(b: Branding) => void>();

export function setBranding(b: Branding) {
  current = b;
  listeners.forEach((l) => l(b));
}

/** Aktuelle Logo-URLs; wird einmal geladen und nach Änderungen im Admin-Bereich aktualisiert */
export function useBranding(): Branding | null {
  const [b, setB] = useState(current);
  useEffect(() => {
    listeners.add(setB);
    if (!current) api.branding().then(setBranding, () => {});
    return () => void listeners.delete(setB);
  }, []);
  return b;
}

/** Logo der Installation, passend zum Farbschema. Ohne hinterlegtes Logo wird nichts angezeigt. */
export function BrandLogo({ height = 24, className }: { height?: number; className?: string }) {
  const b = useBranding();
  if (!b?.light || !b.dark) return null;
  return (
    <picture className={className}>
      <source srcSet={b.dark} media="(prefers-color-scheme: dark)" />
      <img src={b.light} alt="Logo" height={height} style={{ height, width: 'auto', display: 'block' }} />
    </picture>
  );
}
