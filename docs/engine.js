// ヨミドーパの中核ロジック(画面にもストレージにも触らない純粋関数だけ)。
// アプリ本体(app.js)と検証スクリプト(tools/verify.mjs)の両方がこのファイルを使う。

const TERMINATORS = "。！？!?";
const CLOSERS = "」』）)〕】〉》”’";
const OPENERS = "「『（(〔【〈《“‘";
const SPACE = " 　\t";

// 一文の区切り。かぎかっこの中では区切らない(ただし長すぎる台詞は中でも区切る)。
function splitLine(text, ls, le, units) {
  let i = ls;
  let start = ls; // 行の最初の文は字下げの全角スペースも含める
  let depth = 0;
  while (i < le) {
    const c = text[i];
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c)) depth = Math.max(0, depth - 1);
    if (TERMINATORS.includes(c)) {
      let j = i + 1;
      while (j < le && (TERMINATORS.includes(text[j]) || CLOSERS.includes(text[j]))) {
        if (CLOSERS.includes(text[j])) depth = Math.max(0, depth - 1);
        j++;
      }
      if (depth === 0 || j - start > 140) {
        units.push([start, j]);
        start = j; // 文と文のあいだの空白も次の文に含める(1字も落とさない)
        depth = 0;
      }
      i = j;
      continue;
    }
    i++;
  }
  if (start < le && text.slice(start, le).trim() !== "") units.push([start, le]);
}

/** 本文を「文」の単位に分ける。返り値は [開始, 終了) の配列(本文の中の位置)。 */
export function sentenceUnits(text) {
  const units = [];
  let ls = 0;
  while (ls <= text.length) {
    let le = text.indexOf("\n", ls);
    if (le === -1) le = text.length;
    let e = le;
    while (e > ls && SPACE.includes(text[e - 1])) e--;
    if (text.slice(ls, e).replace(/[ 　\t]/g, "") !== "") splitLine(text, ls, e, units);
    ls = le + 1;
  }
  return units;
}

/**
 * 「続きを読む」1回分のかたまり(1〜2文)に分ける。
 * 短い文(見出し・詩の行・短い台詞)は次の文と合わせて2文にする。3文以上は合わせない。
 */
export function chunkText(text) {
  const units = sentenceUnits(text);
  const chunks = [];
  for (let k = 0; k < units.length; k++) {
    const [s, e] = units[k];
    const next = units[k + 1];
    if (next && e - s < 28 && next[1] - s <= 90 && !text.slice(e, next[0]).includes("\n\n")) {
      chunks.push([s, next[1]]);
      k++;
    } else {
      chunks.push([s, e]);
    }
  }
  return chunks;
}

/** offset 以降で最初に始まるかたまりの番号。なければ -1。 */
export function chunkIndexAt(chunks, offset) {
  for (let i = 0; i < chunks.length; i++) if (chunks[i][0] >= offset) return i;
  return -1;
}

/** 似ている度合い: テーマタグの重なりの数 + 同じ作者なら2。 */
export function similarity(a, b) {
  if (a.id === b.id) return 0;
  const shared = a.tags.filter((t) => b.tags.includes(t));
  return shared.length + (a.authorId === b.authorId ? 2 : 0);
}

export function sharedTags(a, b) {
  return a.tags.filter((t) => b.tags.includes(t));
}

/** レア度は似ている度合いで決める(よく似ているほどレア)。 */
export function rarityOf(score) {
  if (score >= 5) return 3;
  if (score >= 3) return 2;
  return 1;
}

/** 似ている順に並べた候補(似ている度合いが1以上)。 */
export function similarWorks(index, work) {
  return index
    .map((w) => ({ w, score: similarity(work, w) }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || x.w.id.localeCompare(y.w.id));
}

/** 重みつき抽選(重み=似ている度合い)。 */
export function pickWeighted(cands, rand) {
  const total = cands.reduce((s, c) => s + c.score, 0);
  let r = rand() * total;
  for (const c of cands) {
    r -= c.score;
    if (r < 0) return c;
  }
  return cands[cands.length - 1];
}

/**
 * 読み終えたときの次の作品: まだ読み終えていない作品のうち、いちばん似ているもの。
 * 同点が複数あればランダム。全部読み終えていたら、いちばん似ている作品。
 */
export function nextWorkAfter(index, work, finished, rand) {
  let cands = similarWorks(index, work).filter((c) => !finished.includes(c.w.id));
  if (cands.length === 0) cands = index.filter((w) => w.id !== work.id && !finished.includes(w.id)).map((w) => ({ w, score: 0 }));
  if (cands.length === 0) cands = similarWorks(index, work);
  if (cands.length === 0) cands = index.filter((w) => w.id !== work.id).map((w) => ({ w, score: 0 }));
  const best = cands[0].score;
  const top = cands.filter((c) => c.score === best);
  return top[Math.floor(rand() * top.length)].w;
}

export const TRIVIA_RATE = 0.4;

/**
 * 押すたびのガチャ。40%で豆知識、残りは似た作品。
 * 返り値: {type:"trivia", fact, work} または {type:"similar", work, score, rarity, shared}
 */
export function drawGacha(index, current, rand) {
  if (rand() < TRIVIA_RATE) {
    // 豆知識は、いま読んでいる作品か、同じ作者の作品のもの
    const pool = index.filter((w) => w.id === current.id || w.authorId === current.authorId);
    const w = rand() < 0.6 ? current : pool[Math.floor(rand() * pool.length)];
    const fact = w.facts[Math.floor(rand() * w.facts.length)];
    return { type: "trivia", fact, work: w };
  }
  const cands = similarWorks(index, current);
  if (cands.length === 0) return null;
  const c = pickWeighted(cands, rand);
  return { type: "similar", work: c.w, score: c.score, rarity: rarityOf(c.score), shared: sharedTags(current, c.w) };
}

/** 再現できる乱数(検証用)。 */
export function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- タイムライン(フィード) ----------

/**
 * フィードに出す作品を選ぶ。最近出した作品は避け、「続きを読む」を押した作品に似ているものを出やすくする。
 * recent: 最近フィードに出した作品ID、interest: 最近「続きを読む」を押した作品(メタデータ)
 */
export function pickFeedWork(index, recent, interest, rand) {
  let pool = index.filter((w) => !recent.includes(w.id));
  if (pool.length === 0) pool = index;
  const cands = pool.map((w) => ({ w, score: 1 + interest.reduce((s, x) => s + similarity(x, w), 0) * 0.6 }));
  return pickWeighted(cands, rand).w;
}

/** 段落の頭から始まるかたまりかどうか(抜き出しは段落の頭から始めると読みやすい)。 */
function startsParagraph(text, s) {
  return s === 0 || text[s - 1] === "\n";
}

/**
 * 投稿の最初のかたまりを決める。
 * 読みかけの作品なら 35% で続きから、20% で冒頭、残りは本文のどこか(段落の頭)を抜き出す。
 * 返り値: {i: かたまり番号, kind: "resume" | "opening" | "excerpt"}
 */
export function feedStart(text, chunks, savedPos, rand) {
  if (savedPos > 0 && savedPos < text.length && rand() < 0.35) {
    const i = chunkIndexAt(chunks, savedPos);
    if (i > 0) return { i, kind: "resume" };
  }
  if (rand() < 0.2 || chunks.length < 4) return { i: 0, kind: "opening" };
  const cands = [];
  for (let i = 1; i < chunks.length - 1; i++) {
    const [s, e] = chunks[i];
    if (startsParagraph(text, s) && e - s >= 16) cands.push(i);
  }
  if (cands.length === 0) return { i: 0, kind: "opening" };
  return { i: cands[Math.floor(rand() * cands.length)], kind: "excerpt" };
}
