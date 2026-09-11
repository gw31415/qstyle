import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { collectRules, disjointWith, parseDecls, parseQSelector, propertyOf } from './css-syntax.js';
import type { DedupMeta, ParsedRule } from './css-syntax.js';
import { orderableProperties, reorderCss, propertiesMayInteract as propertiesConflict } from './css-order.js';
export type { DedupMeta } from './css-syntax.js';

/**
 * Build-time declaration sharing within a generated CSS pack. Candidate groups may
 * contain any number of rules; selection accounts for their actual UTF-8 cost.
 *
 * Keep wrapper instances separate, exclude conditional/unsupported selectors and
 * preserve declaration order when shorthand or fallback semantics may matter.
 * Crossing another rule requires the existing static-unit non-coexistence proof.
 * The final compression comparison can retain the original even after a raw win.
 */

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface Group {
  readonly decls: readonly string[];
  readonly members: readonly ParsedRule[];
}

const bytes = (text: string): number => Buffer.byteLength(text);

function renderGroups(css: string, groups: readonly Group[], remaining: ReadonlyMap<ParsedRule, Map<string, string>>): string {
  const edits: Edit[] = [];
  const changedRules = new Set<ParsedRule>();
  for (const group of groups) {
    const first = group.members[0];
    if (!first) continue;
    edits.push({ start: first.start, end: first.start,
      text: `${group.members.map((m) => m.selector).join(',')}{${group.decls.join(';')}}` });
    for (const member of group.members) changedRules.add(member);
  }
  for (const member of changedRules) {
    const body = [...(remaining.get(member)?.values() ?? [])].join(';');
    edits.push(body === '' ? { start: member.start, end: member.end, text: '' }
      : { start: member.bodyStart, end: member.bodyEnd, text: body });
  }
  edits.sort((x, y) => y.start - x.start || y.end - x.end);
  let out = css;
  let prevStart = Infinity;
  for (const edit of edits) {
    if (edit.end > prevStart) return css;
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    prevStart = edit.start;
  }
  return out;
}

/** Bounded deterministic greedy search, scored by actual UTF-8 bytes, not declaration count. */
function searchGroups(css: string, meta: DedupMeta, onCandidate?: (css: string) => void,
  alternatives?: { limit: number; accept: (candidates: readonly string[]) => void }): string {
  if (css.length > 8_000_000) return css;
  const rules: ParsedRule[] = [];
  try { collectRules(css, rules); } catch { return css; }
  if (rules.length === 0 || rules.length > 20_000) return css;
  const infos = new Map(rules.map((r) => [r, parseQSelector(r.selector, meta.condUnitIds)]));
  const original = new Map(rules.map((r) => [r, parseDecls(r.body)]));
  const remaining = new Map(rules.map((r) => [r, new Map(original.get(r))]));
  const positions = new Map(rules.map((r, index) => [r, index]));
  const movableDecls = new Map(rules.map((r) => {
    const decls = [...original.get(r)!.keys()];
    return [r, new Set(decls.filter((decl) => decls.every((other) =>
      other === decl || !propertiesConflict(propertyOf(decl), propertyOf(other)))))];
  }));
  const movable = (r: ParsedRule, decl: string): boolean => movableDecls.get(r)!.has(decl);
  let safetyWork = 0;
  const safe = (members: readonly ParsedRule[], decls: readonly string[]): boolean => {
    const first = members[0]!;
    const last = members[members.length - 1]!;
    const selected = new Set(members);
    for (let index = positions.get(first)! + 1; index < positions.get(last)!; index++) {
      // Bound the expensive cascade scans as well as candidate enumeration.
      if (++safetyWork > 500_000) return false;
      const rule = rules[index]!;
      if (selected.has(rule)) continue;
      const declarations = original.get(rule)!;
      // Unknown declarations may contain an overlapping shorthand or custom syntax.
      if (declarations.size === 0) return false;
      if (![...declarations.keys()].some((d) => decls.some((shared) => propertiesConflict(propertyOf(d), propertyOf(shared))))) continue;
      const blocker = infos.get(rule);
      if (!blocker) return false;
      const equalSpecificity = members.some((member) => {
        const info = infos.get(member)!;
        return blocker.spec[0] === info.spec[0] && blocker.spec[1] === info.spec[1];
      });
      if (equalSpecificity && !members.every((member) => disjointWith(blocker, infos.get(member)!, meta))) return false;
    }
    return true;
  };
  const scopes = new Map<number, ParsedRule[]>();
  for (const rule of rules) {
    const info = infos.get(rule);
    if (!info || info.cond || original.get(rule)!.size === 0) continue;
    const list = scopes.get(rule.scope) ?? [];
    list.push(rule); scopes.set(rule.scope, list);
  }
  const committed: Group[] = [];
  let work = 0;
  for (let round = 0; round < 128; round++) {
    let best: Group | undefined;
    let bestSaving = 0;
    const choices = new Map<string, { group: Group; saving: number }>();
    for (const members of scopes.values()) {
      if (members.length > 3000) continue;
      const seeds = new Map<string, readonly string[]>();
      const owners = new Map<string, ParsedRule[]>();
      for (const member of members) for (const d of remaining.get(member)!.keys()) {
        if (!movable(member, d)) continue;
        const list = owners.get(d) ?? []; list.push(member); owners.set(d, list);
      }
      // All owners of a declaration are considered together: no two-rule ceiling.
      const sameOwners = new Map<string, string[]>();
      for (const [d, list] of owners) {
        if (list.length < 2) continue;
        const key = list.map((r) => r.start).join(',');
        const decls = sameOwners.get(key) ?? []; decls.push(d); sameOwners.set(key, decls);
      }
      const addSeed = (decls: string[]): void => {
        if (decls.length === 0 || seeds.size >= 512) return;
        decls.sort(); seeds.set(JSON.stringify(decls), decls);
      };
      for (const decls of sameOwners.values()) addSeed(decls);
      // Pair intersections also discover profitable subsets with different owner sets;
      // every such seed is extended to all matching rules below.
      let pairs = 0;
      for (let i = 0; i < members.length && pairs < 4096; i++) {
        for (let j = i + 1; j < members.length && pairs++ < 4096; j++) {
          const a = members[i]!; const b = members[j]!;
          addSeed([...remaining.get(a)!.keys()].filter((d) => remaining.get(b)!.has(d) && movable(a, d) && movable(b, d)));
        }
      }
      for (const decls of seeds.values()) {
        if (++work > 20_000 || safetyWork > 500_000) break;
        const matches = (owners.get(decls[0]!) ?? []).filter((r) => decls.every((d) => remaining.get(r)!.has(d) && movable(r, d)));
        // A blocked crossing partitions owners, allowing safe groups on either side.
        const groups: ParsedRule[][] = [];
        let group: ParsedRule[] = [];
        for (const member of matches) {
          if (group.length > 0 && !safe([...group, member], decls)) { groups.push(group); group = []; }
          group.push(member);
        }
        groups.push(group);
        const candidateGroups = [...groups];
        if (alternatives) {
          // A codec may prefer a local partial merge over one large selector list.
          // Offer source-local windows as well as every maximal owner group.
          for (const members of groups) for (const count of [2, 4, 8]) {
            if (members.length <= count) continue;
            for (let start = 0; start + count <= members.length; start += Math.max(1, count / 2)) {
              const window = members.slice(start, start + count);
              if (safe(window, decls)) candidateGroups.push(window);
            }
          }
        }
        for (const candidates of candidateGroups) {
          if (candidates.length < 2) continue;
          const shared = new Set(decls);
          let saving = -bytes(`${candidates.map((r) => r.selector).join(',')}{${decls.join(';')}}`);
          for (const member of candidates) {
            const before = [...remaining.get(member)!.keys()];
            const after = before.filter((d) => !shared.has(d));
            const body = before.length === original.get(member)!.size ? member.body : before.join(';');
            saving += bytes(body) - (after.length > 0 ? bytes(after.join(';')) : -bytes(member.selector) - 2);
          }
          if (saving > bestSaving) { best = { members: candidates, decls }; bestSaving = saving; }
          if (alternatives && saving > 0 && choices.size < 2048) {
            const group = { members: candidates, decls };
            choices.set(JSON.stringify([candidates.map((r) => r.start), decls]), { group, saving });
          }
        }
      }
      if (work > 20_000 || safetyWork > 500_000) break;
    }
    if (alternatives) {
      const ranked = [...choices.values()].sort((a, b) => b.saving - a.saving);
      const locality = [...ranked].sort((a, b) => {
        const span = (g: Group): number => g.members.at(-1)!.end - g.members[0]!.start;
        return span(a.group) - span(b.group) || b.saving - a.saving;
      });
      const chosen = new Set<(typeof ranked)[number]>();
      // Keep both high raw savings and nearby small merges; neither proxy alone
      // models the context-dependent compressed objective.
      for (let i = 0; chosen.size < alternatives.limit && i < ranked.length; i++) {
        if (ranked[i]) chosen.add(ranked[i]!);
        if (chosen.size < alternatives.limit && locality[i]) chosen.add(locality[i]!);
      }
      alternatives.accept([...chosen].map(({ group }) => {
        const next = new Map(remaining);
        for (const member of group.members) {
          const decls = new Map(remaining.get(member));
          for (const decl of group.decls) decls.delete(decl);
          next.set(member, decls);
        }
        return renderGroups(css, [group], next);
      }));
      return css;
    }
    if (!best) break;
    committed.push(best);
    for (const member of best.members) for (const decl of best.decls) remaining.get(member)!.delete(decl);
    if (onCandidate && (committed.length <= 8 || (committed.length & (committed.length - 1)) === 0)) {
      onCandidate(renderGroups(css, committed, remaining));
    }
    if (work > 20_000 || safetyWork > 500_000) break;
  }
  return committed.length === 0 ? css : renderGroups(css, committed, remaining);
}

export function groupDuplicateCss(css: string, meta: DedupMeta, onCandidate?: (css: string) => void): string {
  return searchGroups(css, meta, onCandidate);
}

/** Legal one-step alternatives for the codec-guided search, including partial merges. */
export function mergeCssCandidates(css: string, meta: DedupMeta, limit = 32): readonly string[] {
  let candidates: readonly string[] = [];
  searchGroups(css, meta, undefined, { limit, accept: (next) => { candidates = next; } });
  return candidates;
}

export interface CssSizes { readonly raw: number; readonly gzip: number; readonly brotli: number }

/** Fixed build-time comparison settings; this does not change server compression. */
export function measureCss(css: string): CssSizes {
  return { raw: bytes(css), gzip: gzipSync(css, { level: 6 }).length,
    brotli: brotliCompressSync(css, { params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_GENERIC,
    } }).length };
}

export interface CssOptimizationReport {
  readonly css: string;
  readonly original: CssSizes;
  readonly selected: CssSizes;
  readonly evaluatedCandidates: number;
  readonly selectedStrategy: string;
}

/**
 * Joint, bounded search over factoring and legal topological orders. Raw bytes
 * generate merge proposals; whole-stream codec measurements select the output.
 * No intermediate is rejected merely for losing to the current incumbent.
 * normalize models downstream minification for scoring; css remains the selected
 * input source so Vite still owns final processing, inline extraction and hashes.
 */
export function analyzeCssOptimization(css: string, meta: DedupMeta, normalize: (css: string) => string = (value) => value): CssOptimizationReport {
  const normalized = normalize(css);
  const baseline = measureCss(normalized);
  let best = css;
  let bestSizes = baseline;
  let selectedStrategy = 'original';
  const measured = new Map<string, CssSizes>([[normalized, baseline]]);
  let evaluatedBytes = baseline.raw;
  const eligible = (sizes: CssSizes): boolean => sizes.raw <= baseline.raw && sizes.gzip <= baseline.gzip && sizes.brotli <= baseline.brotli;
  const better = (a: CssSizes, b: CssSizes): boolean => a.gzip + a.brotli < b.gzip + b.brotli
    || (a.gzip + a.brotli === b.gzip + b.brotli && a.raw < b.raw);
  const evaluate = (candidate: string, strategy: string): CssSizes | undefined => {
    const output = normalize(candidate);
    const cached = measured.get(output);
    if (cached) return cached;
    if (measured.size >= 512 || evaluatedBytes + bytes(output) > 8_000_000) return undefined;
    const sizes = measureCss(output);
    evaluatedBytes += sizes.raw;
    measured.set(output, sizes);
    if (eligible(sizes) && better(sizes, bestSizes)) {
      best = candidate; bestSizes = sizes; selectedStrategy = strategy;
    }
    return sizes;
  };
  const finish = (): CssOptimizationReport => ({ css: best, original: baseline, selected: bestSizes,
    evaluatedCandidates: measured.size, selectedStrategy });
  if (css.length > 1_000_000) return finish();

  // Keep multiple degrees of factoring even if their current serialization loses:
  // a subsequent ordering can change the compressed ranking.
  const roots = new Map<string, string>([[css, 'original']]);
  let checkpoint = 0;
  const grouped = groupDuplicateCss(css, meta, (candidate) => {
    if ([1, 2, 4, 8].includes(++checkpoint)) roots.set(candidate, `merge-checkpoint-${checkpoint}`);
  });
  roots.set(grouped, grouped === css ? 'original' : 'merge-final');
  for (const [root, label] of roots) {
    for (const declarationOrder of ['source', 'alphabetical', 'frequency'] as const) {
      for (const ruleOrder of ['source', 'body', 'properties', 'similarity'] as const) {
        evaluate(reorderCss(root, meta, declarationOrder, ruleOrder), `${label}/${declarationOrder}/${ruleOrder}`);
      }
    }
  }

  // A fixed property order is only a starting point. Deterministic local swaps
  // search other legal orders, while hard declaration dependencies remain intact.
  const prioritySource = best;
  let priority = [...orderableProperties(prioritySource)];
  let priorityBest = evaluate(reorderCss(prioritySource, meta, 'alphabetical', 'source', priority), 'priority-start');
  let seed = 12345;
  const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let step = 0; step < 128 && priority.length > 1; step++) {
    const next = [...priority];
    const a = random() % next.length; const b = random() % next.length;
    [next[a], next[b]] = [next[b]!, next[a]!];
    const candidate = reorderCss(prioritySource, meta, 'alphabetical', 'source', next);
    const sizes = evaluate(candidate, `priority-swap-${step}`);
    if (!sizes) break;
    if (eligible(sizes) && (!priorityBest || better(sizes, priorityBest))) { priority = next; priorityBest = sizes; }
  }
  for (const ruleOrder of ['body', 'properties', 'similarity'] as const) {
    evaluate(reorderCss(prioritySource, meta, 'alphabetical', ruleOrder, priority), `priority/${ruleOrder}`);
  }

  // Explore partial merges from the codec winner, not only the raw-greedy path.
  // Reorder after each proposal so factoring and dictionary locality can cooperate.
  for (let round = 0; round < 2; round++) {
    const before = best;
    for (const candidate of mergeCssCandidates(before, meta, 64)) {
      evaluate(candidate, `joint-merge-${round}/source`);
      evaluate(reorderCss(candidate, meta, 'alphabetical', 'similarity', priority), `joint-merge-${round}/similarity`);
    }
    if (best === before) break;
  }
  return finish();
}

export function optimizeDuplicateCss(css: string, meta: DedupMeta, normalize?: (css: string) => string): string {
  if (css.length > 1_000_000) return css;
  return analyzeCssOptimization(css, meta, normalize).css;
}
