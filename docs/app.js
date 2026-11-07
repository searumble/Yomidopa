import { chunkText, chunkIndexAt, drawGacha, nextWorkAfter, pickFeedWork, feedStart } from "./engine.js";

const $ = (id) => document.getElementById(id);
const feed = $("feed"), sentinel = $("sentinel");
const KEY = "yomidopa:v2";

// ---------- 保存(作品ごとの読書位置など。すべてこの端末の中だけ) ----------
const fresh = () => ({ pos: {}, done: [], authors: [], chars: 0, presses: 0, seen: {}, last: null, interest: [] });
let st = fresh();
try {
  const raw = localStorage.getItem(KEY) || localStorage.getItem("yomidopa:v1");
  if (raw) st = Object.assign(fresh(), JSON.parse(raw));
} catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} };

// ---------- データ ----------
let index = [], byId = new Map();
const works = new Map();
async function loadWork(id) {
  if (works.has(id)) return works.get(id);
  const p = fetch(`data/works/${id}.json`)
    .then((r) => { if (!r.ok) throw new Error(`work ${id}: ${r.status}`); return r.json(); })
    .then((d) => ({ ...d, chunks: chunkText(d.text) }));
  works.set(id, p);
  p.catch(() => works.delete(id));
  return p;
}

// 検証用: 画面に出した本文の範囲を記録する(作品ID, 開始, 終了)
const trace = (window.__yomiTrace = []);

// ---------- 投稿(1作品の抜き出し。押した投稿だけ続きが伸びる) ----------
const KIND_LABEL = { opening: "冒頭", resume: "📖 読みかけ", excerpt: "", similar: "🎁 似た作品から" };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** 投稿をつくる。first はその投稿で最初に出すかたまりの番号。 */
function makePost(meta, w, first, kind) {
  const post = el("article", "post");
  post.dataset.work = meta.id;
  const head = el("header", "post-head");
  head.append(el("b", "post-title", meta.title), el("span", "post-author", meta.author));
  if (KIND_LABEL[kind]) head.append(el("span", "post-kind", KIND_LABEL[kind]));
  const body = el("div", "post-body");
  const slot = el("div", "post-slot");
  const foot = el("footer", "post-foot");
  const btn = el("button", "more", "続きを読む");
  btn.type = "button";
  foot.append(btn);
  post.append(head, body, slot, foot);

  const state = { meta, w, next: first, lastP: null, busy: false, post, body, slot, btn };
  appendChunk(state, first, "");
  btn.addEventListener("click", () => readMore(state));
  return post;
}

/** 本文の [s,e) をそのまま足す。行の途中から始まるかたまりは前の段落につなげる。 */
function appendChunk(state, i, cls) {
  const { w } = state;
  const [s, e] = w.chunks[i];
  trace.push([w.id, s, e, state.post]);
  if (trace.length > 4000) trace.shift();
  const pieces = w.text.slice(s, e).split("\n");
  const startsLine = s === 0 || w.text[s - 1] === "\n";
  let gap = false;
  pieces.forEach((piece, k) => {
    if (k > 0 && piece === "") { gap = true; return; }
    const span = el("span", cls, piece);
    if (k === 0 && !startsLine && state.lastP) {
      state.lastP.append(span);
    } else {
      const p = el("p", gap ? "gap" : "");
      p.append(span);
      state.body.append(p);
      state.lastP = p;
    }
    gap = false;
  });
  state.next = i + 1;
  return { s, e };
}

async function readMore(state) {
  if (state.busy) return;
  state.busy = true;
  document.body.dataset.busy = "1";
  try {
    const { meta, w } = state;
    if (state.next >= w.chunks.length) {
      // 読み終えた投稿: 似た作品の冒頭を、すぐ下に新しい投稿として出す
      const next = nextWorkAfter(index, meta, st.done, Math.random);
      const nw = await loadWork(next.id);
      const post = makePost(next, nw, 0, "opening");
      state.post.after(post);
      state.btn.remove();
      notePosted(next.id);
      post.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const { e } = appendChunk(state, state.next, "fresh");
    st.pos[meta.id] = e;
    st.last = meta.id;
    st.presses++;
    st.chars += w.text.slice(w.chunks[state.next - 1][0], e).replace(/\s/g, "").length;
    st.interest = [meta.id, ...st.interest.filter((x) => x !== meta.id)].slice(0, 5);
    checkPraise(meta, w, e);
    if (state.next >= w.chunks.length) {
      st.pos[meta.id] = w.text.length;
      onFinished(meta);
      state.btn.textContent = "続きを読む";
      state.post.classList.add("ended");
    }
    save();
    await showGacha(state);
  } catch (err) {
    console.error(err);
  } finally {
    state.busy = false;
    delete document.body.dataset.busy;
  }
}

// ---------- ガチャ(押すたび: 40% 豆知識 / 残り 似た作品) ----------
async function showGacha(state) {
  const g = drawGacha(index, state.meta, Math.random);
  state.slot.innerHTML = "";
  if (!g) return;
  if (g.type === "trivia") {
    const card = el("div", "card trivia");
    const head = el("div", "head");
    head.append(el("span", "", "📜 豆知識"));
    card.append(head, el("div", "text", g.fact.t), el("div", "meta", "青空文庫 図書カード・底本の書誌より"));
    state.slot.append(card);
    buzz(8);
    return;
  }
  let w;
  try { w = await loadWork(g.work.id); } catch { return; }
  let i = chunkIndexAt(w.chunks, st.pos[g.work.id] || 0);
  if (i === -1) i = 0;
  const [s, e] = w.chunks[i];
  const card = el("div", `card similar r${g.rarity}`);
  const head = el("div", "head");
  head.append(el("span", "", "🎁 似た作品"), el("span", "stars", "★".repeat(g.rarity)));
  const meta = el("div", "meta");
  meta.append(el("b", "", g.work.title), `　${g.work.author}`);
  if (g.shared.length) meta.append(el("br"), g.shared.map((t) => `#${t}`).join(" "));
  card.append(head, el("div", "text", w.text.slice(s, e).replace(/^[ 　]+/, "")), meta);
  card.addEventListener("click", () => {
    // タップ: その作品を新しい投稿として、すぐ下に出す(カードの文章から始まり、続きはその作品の本当の続き)
    const post = makePost(g.work, w, i, "similar");
    state.post.after(post);
    state.slot.innerHTML = "";
    notePosted(g.work.id);
    buzz(10);
    post.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  state.slot.append(card);
  confetti(state.slot, [0, 16, 60, 170][g.rarity], g.rarity === 3);
  buzz([[15], [20, 40, 20], [40, 50, 40, 50, 120]][g.rarity - 1]);
}

// ---------- タイムラインの読みこみ(下までスクロールしたら足す) ----------
const recent = [];
function notePosted(id) {
  recent.unshift(id);
  recent.length = Math.min(recent.length, 12);
}

let loading = false;
async function addPosts(n) {
  if (loading) return;
  loading = true;
  try {
    for (let k = 0; k < n; k++) {
      const interest = st.interest.map((id) => byId.get(id)).filter(Boolean);
      const meta = pickFeedWork(index, recent, interest, Math.random);
      notePosted(meta.id);
      const w = await loadWork(meta.id);
      const { i, kind } = feedStart(w.text, w.chunks, st.pos[meta.id] || 0, Math.random);
      feed.append(makePost(meta, w, i, kind));
    }
    while (feed.childElementCount > 150) feed.firstElementChild.remove();
  } finally {
    loading = false;
  }
}

// ---------- 通知(読書をほめる。数字はすべてこの端末の本当の記録) ----------
const queue = [];
let toastTimer = null;
function praise(key, msg) {
  if (st.seen[key]) return;
  st.seen[key] = 1;
  queue.push(msg);
  updateBadge();
  if (!toastTimer) showNextToast();
}
function updateBadge() {
  const n = queue.length + (toastTimer ? 1 : 0);
  $("badge").hidden = n === 0;
  $("badge").textContent = n;
}
function showNextToast() {
  const t = $("toast");
  const msg = queue.shift();
  if (!msg) { t.hidden = true; toastTimer = null; updateBadge(); return; }
  t.textContent = msg;
  t.hidden = false;
  toastTimer = setTimeout(showNextToast, 4800);
  updateBadge();
}
$("toast").addEventListener("click", () => { clearTimeout(toastTimer); showNextToast(); });

const PRESS_MARKS = [10, 30, 100, 300, 1000, 3000, 10000];
const CHAR_MARKS = [1000, 5000, 10000, 30000, 50000, 100000, 200000, 300000];
const DONE_MARKS = [3, 5, 10, 20, 30, 40];
function checkPraise(meta, w, end) {
  if (st.presses === 1) praise("first", "はじめて続きを読みました。ようこそ、ヨミドーパへ。");
  for (const n of PRESS_MARKS) if (st.presses === n) praise(`p${n}`, `「続きを読む」を${n}回押しました。よく読んでいますね。`);
  for (const n of CHAR_MARKS) if (st.chars >= n) praise(`c${n}`, `これまでに${n.toLocaleString("ja-JP")}文字の本文を読みました。`);
  if (!st.authors.includes(meta.authorId)) {
    st.authors.push(meta.authorId);
    if (st.authors.length > 1) praise(`a${meta.authorId}`, `${meta.author}の続きを読むのは、これがはじめてです。新しい出会いですね。`);
  }
  if (end >= w.text.length / 2 && end < w.text.length) praise(`h${meta.id}`, `『${meta.title}』を半分まで読みました。`);
}
function onFinished(meta) {
  if (!st.done.includes(meta.id)) st.done.push(meta.id);
  praise(`d${meta.id}`, `『${meta.title}』を最後まで読みました。おつかれさまでした。`);
  for (const n of DONE_MARKS) if (st.done.length >= n) praise(`D${n}`, `読み終えた作品が${n}作品になりました。`);
  if (st.done.length === index.length) praise("all", `収録されている${index.length}作品をすべて読み終えました。すばらしい読書です。`);
}

// ---------- 紙吹雪とバイブ ----------
const cv = $("confetti"), cx = cv.getContext("2d");
let parts = [], raf = 0;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
function confetti(anchor, n, gold) {
  if (reduced || n === 0) return;
  const dpr = devicePixelRatio || 1;
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const r = anchor.getBoundingClientRect();
  const ox = innerWidth / 2, oy = Math.min(innerHeight * 0.8, Math.max(80, r.top + 20));
  const colors = gold ? ["#e0b955", "#f3d27a", "#c99a2e", "#fff3c4", "#d8735b"] : ["#d8735b", "#84a6d6", "#8fa192", "#e0b955", "#c78fc0"];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
    const v = 6 + Math.random() * (gold ? 11 : 8);
    parts.push({ x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: Math.random() * 6.28, vr: (Math.random() - .5) * .4,
      w: 5 + Math.random() * 5, h: 3 + Math.random() * 4, c: colors[i % colors.length], life: 90 + Math.random() * 50 });
  }
  if (!raf) raf = requestAnimationFrame(tick);
}
function tick() {
  cx.clearRect(0, 0, innerWidth, innerHeight);
  parts = parts.filter((p) => p.life > 0 && p.y < innerHeight + 20);
  for (const p of parts) {
    p.vy += 0.28; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.life--;
    cx.save(); cx.translate(p.x, p.y); cx.rotate(p.r);
    cx.globalAlpha = Math.min(1, p.life / 30);
    cx.fillStyle = p.c; cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    cx.restore();
  }
  raf = parts.length ? requestAnimationFrame(tick) : 0;
  if (!raf) cx.clearRect(0, 0, innerWidth, innerHeight);
}
const buzz = (pattern) => { try { navigator.vibrate && navigator.vibrate(pattern); } catch {} };

// ---------- 起動 ----------
async function start() {
  index = await (await fetch("data/index.json")).json();
  byId = new Map(index.map((w) => [w.id, w]));
  // 前回いちばん最後に読んでいた作品は、続きからいちばん上に出す
  const last = byId.get(st.last);
  if (last) {
    const w = await loadWork(last.id);
    const i = chunkIndexAt(w.chunks, st.pos[last.id] || 0);
    if (i > 0) {
      feed.append(makePost(last, w, i, "resume"));
      notePosted(last.id);
    }
  }
  await addPosts(6);
  new IntersectionObserver((ents) => {
    if (ents.some((e) => e.isIntersecting)) addPosts(5);
  }, { rootMargin: "1200px 0px" }).observe(sentinel);
}
start().catch((e) => {
  console.error(e);
  $("toast").textContent = "読みこみに失敗しました。通信を確認して開きなおしてください。";
  $("toast").hidden = false;
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
