import { chunkText, chunkIndexAt, drawGacha, nextWorkAfter } from "./engine.js";

const $ = (id) => document.getElementById(id);
const flow = $("flow"), slot = $("slot"), more = $("more"), scroller = $("scroller");
const KEY = "yomidopa:v1";
const FIRST_WORK = "43754"; // 注文の多い料理店

// ---------- 保存 ----------
const fresh = () => ({ cur: null, pos: {}, done: [], authors: [], chars: 0, presses: 0, seen: {} });
let st = fresh();
try {
  const raw = localStorage.getItem(KEY);
  if (raw) st = Object.assign(fresh(), JSON.parse(raw));
} catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} };

// ---------- データ ----------
let index = [], byId = new Map();
const works = new Map();
async function loadWork(id) {
  if (works.has(id)) return works.get(id);
  const res = await fetch(`data/works/${id}.json`);
  if (!res.ok) throw new Error(`work ${id}: ${res.status}`);
  const d = await res.json();
  const w = { ...d, chunks: chunkText(d.text) };
  works.set(id, w);
  return w;
}

// ---------- 描画 ----------
let lastP = null, lastWorkId = null;

function titleBlock(meta, ended) {
  const div = document.createElement("div");
  div.className = "title";
  const h = document.createElement("h1");
  h.textContent = meta.title;
  const by = document.createElement("div");
  by.className = "by";
  by.textContent = meta.author;
  div.append(h, by);
  flow.append(div);
  trace.push([meta.id, "title"]);
  lastP = null;
  lastWorkId = meta.id;
  setNow(meta);
  return div;
}

function setNow(meta) {
  $("now").innerHTML = "";
  const b = document.createElement("b");
  b.textContent = meta.title;
  $("now").append(b, `　${meta.author}`);
}

/** 本文の [s,e) をそのまま流れに足す。行の途中から始まるときは前の段落につなげる。 */
const trace = (window.__yomiTrace = []);
function appendChunk(work, s, e, cls = "fresh") {
  const text = work.text;
  trace.push([work.id, s, e]);
  if (trace.length > 2000) trace.shift();
  const pieces = text.slice(s, e).split("\n");
  const startsLine = s === 0 || text[s - 1] === "\n";
  let gap = s >= 2 && text[s - 1] === "\n" && text[s - 2] === "\n";
  const nodes = [];
  pieces.forEach((piece, k) => {
    if (k > 0 && piece === "") { gap = true; return; }
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = piece;
    const cont = k === 0 && !startsLine && lastP && lastWorkId === work.id;
    if (cont) {
      lastP.append(span);
    } else {
      const p = document.createElement("p");
      if (gap) p.className = "gap";
      p.append(span);
      flow.append(p);
      lastP = p;
    }
    gap = false;
    nodes.push(span);
  });
  lastWorkId = work.id;
  trimFlow();
  return nodes[0];
}

function trimFlow() {
  while (flow.childElementCount > 240) flow.firstElementChild.remove();
}

function scrollToLatest() {
  requestAnimationFrame(() => scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" }));
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
function checkPraise(meta, work, end) {
  if (st.presses === 1) praise("first", "最初の一文を読みました。ようこそ、ヨミドーパへ。");
  for (const n of PRESS_MARKS) if (st.presses === n) praise(`p${n}`, `「続きを読む」を${n}回押しました。よく読んでいますね。`);
  for (const n of CHAR_MARKS) if (st.chars >= n) praise(`c${n}`, `これまでに${n.toLocaleString("ja-JP")}文字の本文を読みました。`);
  if (!st.authors.includes(meta.authorId)) {
    st.authors.push(meta.authorId);
    if (st.authors.length > 1) praise(`a${meta.authorId}`, `${meta.author}の文章を読むのは、これがはじめてです。新しい出会いですね。`);
  }
  if (end >= work.text.length / 2 && end < work.text.length) praise(`h${meta.id}`, `『${meta.title}』を半分まで読みました。`);
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
function confetti(n, gold) {
  if (reduced || n === 0) return;
  const dpr = devicePixelRatio || 1;
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = gold ? ["#e0b955", "#f3d27a", "#c99a2e", "#fff3c4", "#d8735b"] : ["#d8735b", "#84a6d6", "#8fa192", "#e0b955", "#c78fc0"];
  const ox = innerWidth / 2, oy = innerHeight * 0.62;
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

// ---------- ガチャのカード ----------
async function showGacha(meta) {
  const g = drawGacha(index, meta, Math.random);
  slot.innerHTML = "";
  if (!g) return;
  const card = document.createElement("div");
  if (g.type === "trivia") {
    card.className = "card trivia";
    card.innerHTML = `<div class="head"><span>📜 豆知識</span></div><div class="text"></div><div class="meta">青空文庫 図書カード・底本の書誌より</div>`;
    card.querySelector(".text").textContent = g.fact.t;
    slot.append(card);
    buzz(8);
    return;
  }
  let w;
  try { w = await loadWork(g.work.id); } catch { return; }
  let i = chunkIndexAt(w.chunks, st.pos[g.work.id] || 0);
  if (i === -1) i = 0;
  const [s, e] = w.chunks[i];
  card.className = `card similar r${g.rarity}`;
  card.innerHTML = `<div class="head"><span>🎁 似た作品</span><span class="stars"></span></div><div class="text"></div><div class="meta"><b></b>　<span class="au"></span><br><span class="tg"></span></div>`;
  card.querySelector(".stars").textContent = "★".repeat(g.rarity);
  card.querySelector(".text").textContent = w.text.slice(s, e).replace(/^[ 　]+/, "");
  card.querySelector("b").textContent = g.work.title;
  card.querySelector(".au").textContent = g.work.author;
  card.querySelector(".tg").textContent = g.shared.length ? g.shared.map((t) => `#${t}`).join(" ") : "";
  card.addEventListener("click", () => { if (!busy) jumpTo(g.work, w, s, e); });
  slot.append(card);
  confetti([0, 16, 60, 170][g.rarity], g.rarity === 3);
  buzz([[15], [20, 40, 20], [40, 50, 40, 50, 120]][g.rarity - 1]);
}

/** カードをタップ: その作品に移り、カードの文章から読みはじめる(以後はその作品の本当の続き)。 */
function jumpTo(meta, w, s, e) {
  slot.innerHTML = "";
  st.cur = meta.id;
  titleBlock(meta);
  const node = appendChunk(w, s, e);
  st.pos[meta.id] = e;
  save();
  buzz(10);
  node.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---------- 続きを読む ----------
let busy = false;
async function readMore() {
  if (busy) return;
  busy = true;
  document.body.dataset.busy = "1";
  try {
    let meta = byId.get(st.cur);
    let w = await loadWork(meta.id);
    let i = chunkIndexAt(w.chunks, st.pos[meta.id] || 0);
    if (i === -1) {
      // 読み終えている: 似た作品の冒頭へつなぐ
      const next = nextWorkAfter(index, meta, st.done, Math.random);
      st.pos[next.id] = 0;
      st.cur = next.id;
      meta = next;
      w = await loadWork(meta.id);
      titleBlock(meta);
      i = 0;
    }
    const [s, e] = w.chunks[i];
    appendChunk(w, s, e);
    st.pos[meta.id] = e;
    st.presses++;
    st.chars += w.text.slice(s, e).replace(/\s/g, "").length;
    checkPraise(meta, w, e);
    if (i === w.chunks.length - 1) {
      st.pos[meta.id] = w.text.length;
      onFinished(meta);
    }
    save();
    await showGacha(meta);
    scrollToLatest();
  } catch (err) {
    console.error(err);
  } finally {
    busy = false;
    delete document.body.dataset.busy;
  }
}
more.addEventListener("click", readMore);

// ---------- 起動 ----------
async function start() {
  index = await (await fetch("data/index.json")).json();
  byId = new Map(index.map((w) => [w.id, w]));
  if (!byId.has(st.cur)) st.cur = FIRST_WORK;
  const meta = byId.get(st.cur);
  const w = await loadWork(meta.id);
  titleBlock(meta);
  // 前回の続き: 直前に読んだ数かたまりを薄く出しておく
  const pos = st.pos[meta.id] || 0;
  let i = chunkIndexAt(w.chunks, pos);
  if (i === -1) i = w.chunks.length;
  for (let k = Math.max(0, i - 3); k < i; k++) appendChunk(w, w.chunks[k][0], w.chunks[k][1], "old");
  more.disabled = false;
  scrollToLatest();
}
start().catch((e) => {
  console.error(e);
  $("now").textContent = "読みこみに失敗しました。通信を確認して開きなおしてください。";
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
