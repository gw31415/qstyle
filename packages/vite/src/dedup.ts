/**
 * 生成 CSS の decl 単位 dedup (plan.md §39 clustering の v1)。
 *
 * 同一 (at-rule prefix + declaration) を持つ `.q_*` unit rule を `,` 結合セレクタへ
 * グループ化する。安全条件:
 * - グループ化候補は qstyle unit rule のみ (parametric / 条件付き unit は同時適用の
 *   性質が異なるため対象外)。
 * - 移動区間に挟まれるルールが、宣言を共有し、かつ詳細度がグループ最小値と一致する
 *   場合は「同じ要素に当たりうる」か証明できないのでグループ化しない (order 競合の
 *   回避)。証明できるのは (a) 異なる static unit class 同士 (1要素1 unit class の
 *   ため非共存)、(b) `.q_x` とその子孫ルールでタグが異なる場合 (祖先自身ではない)。
 * - 一切その他の CSS (tailwind は @layer 内で prefix が分離、legacy は対象外) には
 *   触れず、解析に失敗したら入力をそのまま返す (correctness first)。
 */

export interface DedupMeta {
  /** unit class が適用されたタグ名 (q_xxxxxxxx -> {"span", ...})。 */
  readonly unitTags: ReadonlyMap<string, ReadonlySet<string>>;
  /** 条件付き (ternary 等) で適用される unit class。dedup 対象外かつ block 判定は保守的にする。 */
  readonly condUnitIds: ReadonlySet<string>;
}

interface ParsedRule {
  /** ルール全体の範囲。 */
  start: number;
  end: number;
  /** at-rule chain のテキスト (例: `@media (x){`)。同一 chain 同士のみグループ化。 */
  prefix: string;
  selector: string;
  bodyStart: number;
  bodyEnd: number;
  body: string;
}

interface QSelectorInfo {
  cls: string;
  /** true: base `.q_x`。false: pseudo / descendant を含む。 */
  base: boolean;
  /** 子孫 simple selector のタグ (`.q_x span` の "span")。 */
  descTag: string | null;
  /** 詳細度 (b=class/pseudo, c=element)。順序比較のみに使用。 */
  spec: [number, number];
  cond: boolean;
}

const Q_SELECTOR_RE =
  /^\.q_[0-9a-f]{8,}((?::[-a-zA-Z]+(?:\([^)]*\))?)*)((?:\s+(?:[A-Za-z][A-Za-z0-9-]*|\.[A-Za-z][\w-]*))?)$/;

function parseQSelector(selector: string, condUnitIds: ReadonlySet<string>): QSelectorInfo | null {
  const m: RegExpExecArray | null = Q_SELECTOR_RE.exec(selector);
  if (m === null) return null;
  const head: RegExpMatchArray | null = /^\.q_[0-9a-f]{8,}/.exec(selector);
  if (head === null) return null;
  const cls: string = head[0].slice(1);
  const pseudoPart: string = m[1] ?? '';
  const descPart: string = (m[2] ?? '').trim();
  const pseudoCount: number = pseudoPart === '' ? 0 : (pseudoPart.match(/:/g) ?? []).length;
  let descTag: string | null = null;
  let descClass = false;
  if (descPart !== '') {
    if (descPart.startsWith('.')) {
      descClass = true;
      descTag = descPart.slice(1);
    } else {
      descTag = descPart;
    }
  }
  const b: number = 1 + pseudoCount + (descClass ? 1 : 0);
  const c: number = descTag !== null && !descClass ? 1 : 0;
  return {
    cls,
    base: pseudoPart === '' && descPart === '',
    descTag,
    spec: [b, c],
    cond: condUnitIds.has(cls),
  };
}

function parseDecls(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of body.split(';')) {
    const d: string = raw.trim();
    if (d === '') continue;
    const colon: number = d.indexOf(':');
    if (colon <= 0) continue;
    if (!out.has(d)) out.set(d, d);
  }
  return out;
}

/**
 * block 内を走査して rule を列挙する (at-rule は prefix に積んで再帰)。
 */

/**
 * blocker rule R (詳細度が group 最小値と一致し、宣言を共有する) が、member rule の
 * 対象要素と「同じ要素に当たりうる」場合に false を返す (その場合はグループ化しない)。
 *
 * 証明できる非共存:
 * - R も member も base `.q_x` / `.q_y` で id が異なる (1 要素が持つ static unit class
 *   は高々 1 つ。条件付き unit は除外済み)。
 * - member が `.q_c <tag>` の子孫で、tag が R (= `.q_c`) の適用タグ集合に含まれない
 *   (R 要素は tag が違うため member selector に一致しない。祖先自身は子孫ではない)。
 */
function disjointWith(
  rInfo: QSelectorInfo,
  member: QSelectorInfo,
  meta: DedupMeta,
): boolean {
  if (rInfo.cond || member.cond) return false;
  if (!rInfo.base) return false; // R が pseudo / 子孫の場合は証明不能 (保守的)
  if (member.base) return member.cls !== rInfo.cls;
  // member は子孫 (または pseudo 付き)。pseudo のみ (descTag === null) は同一要素の
  // 可能性があるため証明できない。
  if (member.descTag === null) return false;
  const tags: ReadonlySet<string> | undefined = meta.unitTags.get(rInfo.cls);
  if (tags === undefined || tags.size === 0) return false; // 記録なし → 証明不能
  return !tags.has(member.descTag);
}
function collectRules(css: string, out: ParsedRule[]): void {
  const walk = (start: number, end: number, prefix: string): void => {
    let i = start;
    while (i < end) {
      // 空白・コメントをスキップ
      while (i < end) {
        const ch = css[i];
        if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') {
          i += 1;
        } else if (ch === '/' && css[i + 1] === '*') {
          const close = css.indexOf('*/', i + 2);
          if (close < 0) return;
          i = close + 2;
        } else {
          break;
        }
      }
      if (i >= end) break;
      // トークンを読み、最初の '{' か ';' を探す
      let j = i;
      let header = '';
      let found: '{' | ';' | null = null;
      while (j < end) {
        const ch = css[j];
        if (ch === '"' || ch === "'") {
          const q = ch;
          j += 1;
          while (j < end && css[j] !== q) j += css[j] === '\\' ? 2 : 1;
          if (j >= end) return;
          j += 1;
          continue;
        }
        if (ch === '/' && css[j + 1] === '*') {
          const close = css.indexOf('*/', j + 2);
          if (close < 0) return;
          j = close + 2;
          continue;
        }
        if (ch === '(') {
          // url(...) 等の中に brace が現れても無視
          let depth = 0;
          while (j < end) {
            const c2 = css[j];
            if (c2 === '(') depth += 1;
            else if (c2 === ')') {
              depth -= 1;
              if (depth === 0) {
                j += 1;
                break;
              }
            } else if (c2 === '"' || c2 === "'") {
              const q = c2;
              j += 1;
              while (j < end && css[j] !== q) j += css[j] === '\\' ? 2 : 1;
            }
            j += 1;
          }
          continue;
        }
        if (ch === '{' || ch === ';') {
          found = ch;
          break;
        }
        j += 1;
      }
      if (found === null) return;
      header = css.slice(i, j).trim();
      if (found === ';') {
        // @import 等の statement はスキップ
        i = j + 1;
        continue;
      }
      // '{' の対応を探す
      let depth = 0;
      let k = j;
      while (k < end) {
        const ch = css[k];
        if (ch === '"' || ch === "'") {
          const q = ch;
          k += 1;
          while (k < end && css[k] !== q) k += css[k] === '\\' ? 2 : 1;
          if (k >= end) return;
          k += 1;
          continue;
        }
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
        k += 1;
      }
      if (k >= end) return; // 対応する '}' なし → 解析諦め (呼び出し元で原文返し)
      if (header.startsWith('@')) {
        walk(j + 1, k, `${prefix}${header}{`);
      } else {
        out.push({
          start: i,
          end: k + 1,
          prefix,
          selector: header,
          bodyStart: j + 1,
          bodyEnd: k,
          body: css.slice(j + 1, k),
        });
      }
      i = k + 1;
    }
  };
  walk(0, css.length, '');
}

function propsOf(decls: ReadonlyMap<string, string>): Set<string> {
  const out = new Set<string>();
  for (const d of decls.keys()) {
    const colon = d.indexOf(':');
    if (colon > 0) out.add(d.slice(0, colon).trim());
  }
  return out;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * css 中の `.q_*` unit rule を decl 単位でグループ化する。
 * 解析不能・安全条件未達の場合は元のテキストをそのまま返す。
 */
export function groupDuplicateCss(css: string, meta: DedupMeta): string {
  if (css.length > 8_000_000) return css;
  let rules: ParsedRule[];
  try {
    rules = [];
    collectRules(css, rules);
  } catch {
    return css;
  }
  if (rules.length === 0 || rules.length > 20_000) return css;

  const infos = new Map<ParsedRule, QSelectorInfo | null>();
  const declsOf = new Map<ParsedRule, Map<string, string>>();
  for (const r of rules) {
    infos.set(r, parseQSelector(r.selector, meta.condUnitIds));
    declsOf.set(r, parseDecls(r.body));
  }
  const eligible = (r: ParsedRule): boolean => {
    const info = infos.get(r);
    return info !== null && info !== undefined && !info.cond;
  };

  const edits: Edit[] = [];
  // prefix ごとに処理 (同一 at-rule スコープ内でのみグループ化)
  const byPrefix = new Map<string, ParsedRule[]>();
  for (const r of rules) {
    const list = byPrefix.get(r.prefix) ?? [];
    list.push(r);
    byPrefix.set(r.prefix, list);
  }
  const blocked = new Set<string>();
  const committed: { decls: string[]; members: ParsedRule[] }[] = [];
  for (const items of byPrefix.values()) {
    if (items.length < 2) continue;
    if (items.length > 3000) continue;
    const alive = items.filter(eligible);
    for (;;) {
      // 最大の共有 decl セットを持つペアを探す
      let best: { a: ParsedRule; b: ParsedRule; shared: string[] } | null = null;
      let bestKey = '';
      for (let x = 0; x < alive.length; x++) {
        const a = alive[x];
        if (a === undefined) continue;
        const da = declsOf.get(a);
        if (da === undefined || da.size === 0) continue;
        for (let y = x + 1; y < alive.length; y++) {
          const b = alive[y];
          if (b === undefined) continue;
          const key = `${a.start}:${b.start}`;
          if (blocked.has(key)) continue;
          const db = declsOf.get(b);
          if (db === undefined || db.size === 0) continue;
          const shared: string[] = [];
          for (const [d] of da) {
            if (db.has(d)) shared.push(d);
          }
          if (shared.length === 0) continue;
          if (best === null || shared.length > best.shared.length) {
            best = { a, b, shared };
            bestKey = key;
          }
        }
      }
      if (best === null) break;
      const { a, b, shared } = best;
      const infoA = infos.get(a);
      const infoB = infos.get(b);
      if (infoA === null || infoA === undefined || infoB === null || infoB === undefined) {
        blocked.add(bestKey);
        continue;
      }
      // 安全ガード: 移動区間の挟まれるルールとの order 競合
      const lo = Math.min(a.start, b.start);
      const hi = Math.max(a.end, b.end);
      const minSpec = infoA.spec < infoB.spec ? infoA.spec : infoB.spec;
      const sharedProps = new Set(shared.map((d) => d.slice(0, d.indexOf(':')).trim()));
      let dangerous = false;
      for (const r of items) {
        if (r === a || r === b) continue;
        if (r.start <= lo || r.start >= hi) continue;
        const rd = declsOf.get(r);
        if (rd === undefined) continue;
        const hasOverlap = [...propsOf(rd)].some((p) => sharedProps.has(p));
        if (!hasOverlap) continue;
        const info = infos.get(r);
        if (info === null || info === undefined) {
          // qstyle セレクタ以外 (legacy / preserve block) は証明不能 → 諦める
          dangerous = true;
          break;
        }
        if (info.spec[0] !== minSpec[0] || info.spec[1] !== minSpec[1]) continue; // spec 差は order 無関係
        if (disjointWith(info, infoA, meta) && disjointWith(info, infoB, meta)) continue;
        dangerous = true;
        break;
      }
      if (dangerous) {
        blocked.add(bestKey);
        continue;
      }
      // コミット: 共有 decl をグループ化し、各メンバーから除去
      committed.push({ decls: [...shared].sort(), members: [a, b] });
      for (const member of [a, b]) {
        const d = declsOf.get(member);
        if (d === undefined) continue;
        for (const s of shared) d.delete(s);
      }
    }
  }
  if (committed.length === 0) return css;

  // 反映: 共有 decl を先頭メンバーの位置にグループ rule として挿入し、
  // 各メンバー body から除去 (空になった rule は削除)
  for (const g of committed) {
    const first: ParsedRule | undefined = g.members.reduce<ParsedRule | undefined>(
      (m, x) => (m === undefined || x.start < m.start ? x : m),
      undefined,
    );
    if (first === undefined) continue;
    const sel = g.members.map((m) => m.selector).join(',');
    edits.push({
      start: first.start,
      end: first.start,
      text: `${sel}{${g.decls.join(';')}}`,
    });
    for (const member of g.members) {
      const remaining = declsOf.get(member);
      const body = [...(remaining?.values() ?? [])].join(';');
      if (body === '') {
        edits.push({ start: member.start, end: member.end, text: '' });
      } else {
        edits.push({ start: member.bodyStart, end: member.bodyEnd, text: body });
      }
    }
  }
  // 重複する範囲の編集がないか検査してから適用 (後方から)
  edits.sort((x, y) => y.start - x.start || y.end - x.end);
  let out = css;
  let prevStart = Infinity;
  for (const e of edits) {
    if (e.end > prevStart) return css; // 重複 → 安全側で原文
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    prevStart = e.start;
  }
  return out;
}
