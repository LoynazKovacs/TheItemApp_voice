import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { PLATFORM_DOCUMENT_STORE } from '@loynazkovacs/theitemapp-platform-sdk';

/**
 * Frontend-direct chip-ref → display label resolver.
 *
 * Why frontend (not the voice-api backend):
 *  - The chip renderer (host's `pf-ref-chip`) already does this resolution
 *    using the model's `ui.display.templates[]`. Mirroring the same logic
 *    here means the speaker reads exactly what the user is seeing.
 *  - Uses the host's shared `HttpClient` so the existing authInterceptor
 *    attaches the user's access token — no extra auth round-trip via the
 *    voice-api backend.
 *  - Federated remotes cannot directly inject the host's `RefLabelService`
 *    (class identity differs across module graphs), so we keep this tiny
 *    self-contained implementation in the voice repo.
 *
 * Cache strategy (mirrors core's `RefLabelService`):
 *  - Model definitions: one bulk fetch of `/api/dynamic/items?_l=500` on
 *    first call, kept for the lifetime of the page.
 *  - Per-ref rows: rehomed onto the shared SDK `PLATFORM_DOCUMENT_STORE`.
 *    Missing ids are batch-fetched via `?_ids=` (one request for N ids — the
 *    store has no cross-document batching of its own) and each row is fed into
 *    the store via `seed`, so it lives as a single cached, socket-live entry
 *    shared with every other surface (chips, show prefabs, …). Labels are then
 *    computed from those store rows. Ids the batch doesn't return are
 *    negative-cached (`seed(..., null)`) so a miss is never re-fetched.
 */
// Component-provided (NOT providedIn:'root'): this service injects
// PLATFORM_DOCUMENT_STORE, which core supplies to a federated prefab's ELEMENT
// injector via prefab-host. A root-provided service would resolve in the
// remote's own environment injector (no PLATFORM_* tokens) → NG0201. So it is
// listed in the consuming prefabs' `providers`. Its only per-instance state is
// the `modelDefs` map; the ref-row cache lives in the shared core DocumentStore
// singleton, so separate per-prefab instances all read/write the same rows.
@Injectable()
export class RefResolverService {
  private readonly http = inject(HttpClient);
  private readonly store = inject(PLATFORM_DOCUMENT_STORE);

  private readonly modelDefs = new Map<string, ModelDef>();
  private modelDefsPromise: Promise<void> | null = null;

  /**
   * Resolve as many of the given refs as possible. Returns a snapshot map of
   * labels for the requested refs (including empty strings for known misses,
   * so the sanitiser strips them). Callers can pass this directly to
   * `sanitizeForTts`.
   */
  async resolve(refs: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!refs.length) return out;

    // De-dupe + validate. Bucket by collection only the ids the store isn't
    // already tracking, so a batch `?_ids=` fetch pulls just the misses.
    type Parsed = { ref: string; coll: string; id: string };
    const parsed: Parsed[] = [];
    const buckets = new Map<string, Set<string>>();
    const seen = new Set<string>();
    for (const ref of refs) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      const slash = ref.indexOf('/');
      if (slash <= 0) continue;
      const coll = ref.substring(0, slash);
      const id = ref.substring(slash + 1);
      if (!/^[0-9a-f]{24}$/i.test(id)) continue;
      parsed.push({ ref, coll, id });
      if (this.store.peek(coll, id) === undefined) {
        // Placeholder + `settled` promise so a concurrent resolve/getNow
        // coalesces onto the imminent batch seed instead of racing it.
        this.store.seed(coll, id, undefined);
        let bucket = buckets.get(coll);
        if (!bucket) { bucket = new Set(); buckets.set(coll, bucket); }
        bucket.add(id);
      }
    }
    if (!parsed.length) return out;

    if (buckets.size) {
      await this.ensureModelDefs();
      await Promise.all(
        Array.from(buckets.entries()).map(([coll, ids]) =>
          this.fetchCollection(coll, Array.from(ids)),
        ),
      );
    }

    // Build snapshot from the store (getNow awaits any placeholder still
    // settling from a concurrent batch). Missing row → '' sentinel (strip).
    await Promise.all(
      parsed.map(async ({ ref, coll, id }) => {
        const row = await this.store.getNow<Record<string, unknown>>(coll, id);
        const label = row ? labelForRow(this.modelDefs.get(coll), row) : null;
        out.set(ref, label ?? '');
      }),
    );
    return out;
  }

  // ---------------------------------------------------------------- internals

  private async ensureModelDefs(): Promise<void> {
    if (this.modelDefs.size > 0) return;
    if (this.modelDefsPromise) return this.modelDefsPromise;
    this.modelDefsPromise = (async () => {
      try {
        const rows = await firstValueFrom(
          this.http.get<unknown>('/api/dynamic/items', { params: { _l: 500 } }),
        );
        if (Array.isArray(rows)) {
          for (const r of rows) {
            const key = (r as any)?.key;
            if (typeof key === 'string' && key) {
              this.modelDefs.set(key, r as ModelDef);
            }
          }
        }
      } catch {
        // Leave map empty — fallback label logic still works without templates.
      } finally {
        this.modelDefsPromise = null;
      }
    })();
    return this.modelDefsPromise;
  }

  /**
   * Batch-fetch `ids` of `collection` via `?_ids=` and feed each row into the
   * shared store (`seed`). Ids the batch doesn't return are negative-cached so
   * their placeholder `settled` promise resolves and getNow doesn't hang.
   */
  private async fetchCollection(collection: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    try {
      const rows = await firstValueFrom(
        this.http.get<unknown>(`/api/dynamic/${encodeURIComponent(collection)}`, {
          params: { _ids: ids.join(','), _l: ids.length },
        }),
      );
      const returned = new Set<string>();
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const id = extractId((row as any)?._id);
          if (!id) continue;
          returned.add(id);
          this.store.seed<Record<string, unknown>>(collection, id, row as Record<string, unknown>);
        }
      }
      // Negative-cache anything not returned (resolves its placeholder).
      for (const id of ids) {
        if (!returned.has(id)) this.store.seed<Record<string, unknown>>(collection, id, null);
      }
    } catch {
      // Resolve every placeholder to `missing` so getNow settles (strip).
      for (const id of ids) this.store.seed<Record<string, unknown>>(collection, id, null);
    }
  }
}

// ----------------------------------------------------------------- template

interface ModelDef {
  key?: string;
  collection?: string;
  ui?: { display?: { templates?: unknown } };
}

function labelForRow(def: ModelDef | undefined, row: Record<string, unknown>): string | null {
  const templates = readTemplates(def);
  for (const t of templates) {
    const rendered = cleanupRendered(renderMustache(t, row));
    if (rendered) return rendered.slice(0, 160);
  }
  // Minimal fallback — keep audio sane even when a model has no template.
  for (const k of ['title', 'name', 'key', 'username', 'email', 'displayName'] as const) {
    const v = row[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 160);
  }
  return null;
}

function readTemplates(def: ModelDef | undefined): readonly string[] {
  const t = def?.ui?.display?.templates;
  if (!Array.isArray(t)) return [];
  return t.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
}

function renderMustache(template: string, ctx: Readonly<Record<string, unknown>>): string {
  if (!template) return '';
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, raw) => {
    const path = String(raw ?? '').trim();
    if (!path) return '';
    return stringify(getPath(ctx, path));
  });
}

function getPath(obj: unknown, path: string): unknown {
  const parts = path.split('.').map((p) => p.trim()).filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' ? String(x) : ''))
      .filter(Boolean)
      .join(', ');
  }
  // Object: try id-like extraction so x-ref placeholders don't print [object].
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['$oid'] === 'string') return String(o['$oid']);
    const nested = o['_id'] ?? o['id'];
    if (nested != null) return stringify(nested);
  }
  return '';
}

function cleanupRendered(s: string): string | null {
  const raw = (s ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const noSpaceBeforePunct = raw.replace(/\s+([,.;:!?])/g, '$1');
  const trimmed = noSpaceBeforePunct.replace(/^[,.;:!?]+\s*/g, '').replace(/\s*[,.;:!?]+$/g, '').trim();
  return trimmed || null;
}

function extractId(v: unknown): string | null {
  if (typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v)) return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['$oid'] === 'string' && /^[0-9a-f]{24}$/i.test(o['$oid'])) return o['$oid'];
    if (typeof (o as any).toString === 'function') {
      const s = String((o as any).toString());
      if (/^[0-9a-f]{24}$/i.test(s)) return s;
    }
  }
  return null;
}
