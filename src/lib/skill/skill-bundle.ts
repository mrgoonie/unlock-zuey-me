/**
 * The ai-unlocked skill as served by /skill/**: every file under skills/ai-unlocked/ bundled as text at build time
 * (Vite `import.meta.glob` with `?raw`), plus a manifest with each file's sha256 so the bootstrap installer
 * (skills/ai-unlocked/scripts/install.mjs) can verify what it downloads. Tests are never served.
 */

const PREFIX = '/skills/ai-unlocked/';

// `?raw` + `import: 'default'` makes every module value the file text.
const rawFiles = import.meta.glob<string>('/skills/ai-unlocked/**/*', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Served relative path → file text. Excludes test files. */
export const SKILL_FILES: ReadonlyMap<string, string> = new Map(
  Object.entries(rawFiles)
    .filter(([key]) => key.startsWith(PREFIX) && !/\.test\.[a-z]+$/.test(key) && !key.split('/').some((s) => s.startsWith('.')))
    .map(([key, text]) => [key.slice(PREFIX.length), text] as const)
    .sort(([a], [b]) => a.localeCompare(b)),
);

export interface SkillManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface SkillManifest {
  name: string;
  version: string;
  minNode: number;
  hookMarker: string;
  files: SkillManifestFile[];
}

interface BaseManifest {
  name: string;
  version: string;
  minNode: number;
  hookMarker: string;
}

function baseManifest(): BaseManifest {
  const text = SKILL_FILES.get('manifest.json');
  if (!text) throw new Error('skills/ai-unlocked/manifest.json is missing from the bundle');
  const parsed = JSON.parse(text) as Partial<BaseManifest>;
  if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string' || typeof parsed.minNode !== 'number' || typeof parsed.hookMarker !== 'string') {
    throw new Error('skills/ai-unlocked/manifest.json has an unexpected shape');
  }
  return { name: parsed.name, version: parsed.version, minNode: parsed.minNode, hookMarker: parsed.hookMarker };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** UTF-8 bytes of a served file, exactly what the route sends. */
export const skillFileBytes = (text: string) => new TextEncoder().encode(text);

let manifestPromise: Promise<SkillManifest> | null = null;

/** Manifest with sha256 and byte length per file; computed once per isolate. */
export function skillManifest(): Promise<SkillManifest> {
  manifestPromise ??= (async () => {
    const files: SkillManifestFile[] = [];
    for (const [path, text] of SKILL_FILES) {
      const bytes = skillFileBytes(text);
      files.push({ path, sha256: await sha256Hex(bytes), bytes: bytes.byteLength });
    }
    return { ...baseManifest(), files };
  })();
  manifestPromise.catch(() => { manifestPromise = null; });
  return manifestPromise;
}

/** Response headers shared by every /skill file route. */
export const SKILL_CACHE_CONTROL = 'public, max-age=300';
