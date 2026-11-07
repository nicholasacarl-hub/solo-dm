/** The bundled SRD's manifest (version, entry counts, upstream sources), or null until loaded. */
import { useEffect, useState } from 'react';
import { loadSrdManifest, type SrdManifest } from '@/data';

export function useSrdManifest(): SrdManifest | null {
  const [manifest, setManifest] = useState<SrdManifest | null>(null);
  useEffect(() => {
    let alive = true;
    loadSrdManifest().then(
      (m) => {
        if (alive) setManifest(m);
      },
      () => {
        // Optional extra detail; the screens work without it.
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  return manifest;
}

/** Total number of SRD entries in the manifest. */
export function manifestEntryCount(manifest: SrdManifest | null): number | undefined {
  if (!manifest) return undefined;
  return Object.values(manifest.counts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
}
