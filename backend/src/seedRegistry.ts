import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SeedRegistry {
  manifest: Record<string, unknown> | null;
  getCollection: (collection: string) => unknown | null;
  listCollections: () => string[];
}

export function loadSeedRegistry(): SeedRegistry {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const seedDirCandidate1 = path.resolve(__dirname, '../../dbseed');
  const seedDirCandidate2 = path.resolve(__dirname, '../dbseed');
  const seedDir = existsSync(path.join(seedDirCandidate1, 'manifest.json')) ? seedDirCandidate1 : seedDirCandidate2;
  const manifestPath = path.join(seedDir, 'manifest.json');

  if (!existsSync(manifestPath)) {
    return {
      manifest: null,
      getCollection: () => null,
      listCollections: () => [],
    };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  const index = new Map<string, string>();
  for (const entry of (manifest.collections as Array<{ collection?: string; file?: string }> | undefined) ?? []) {
    if (!entry.collection || !entry.file) continue;
    const filePath = path.resolve(seedDir, entry.file);
    if (existsSync(filePath)) {
      index.set(entry.collection, filePath);
    }
  }

  return {
    manifest,
    getCollection: (collection: string) => {
      const filePath = index.get(collection);
      if (!filePath) return null;
      return JSON.parse(readFileSync(filePath, 'utf-8'));
    },
    listCollections: () => Array.from(index.keys()),
  };
}
