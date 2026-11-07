#!/usr/bin/env node
// アプリが出す文章がすべて青空文庫の原文の連続した部分であることを確かめる。
//
// 1. source/aozora/ の原文(Shift_JIS)を、build.py とは別に、ここで独自に読み解く
//    (冒頭・末尾の書誌、ルビ、注記を取り除き、外字は注記どおりの文字に置き換える)。
// 2. アプリと同じ engine.js で全作品をかたまりに分け、全チャンクが原文の部分文字列かを調べる。
//    比べるときに許すのは「空行の数」の違いだけ(文字は1字もちがってはいけない)。
// 3. かたまりのあいだに読み飛ばした文字がないこと(=本当の続き)を調べる。
// 4. ガチャを何万回も回し、似た作品カードの文章も原文の部分文字列か、豆知識の根拠が書誌にあるかを調べる。
// 5. 読み終えたら別の作品の冒頭へつながることを、全作品について調べる。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chunkText, sentenceUnits, drawGacha, pickFeedWork, feedStart, chunkIndexAt, nextWorkAfter, similarity, rarityOf, seededRandom, TRIVIA_RATE,
} from "../docs/engine.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p));
const index = JSON.parse(read("docs/data/index.json"));
const catalog = JSON.parse(read("tools/catalog.json"));

let failures = 0;
const fail = (msg) => { failures++; if (failures <= 30) console.error("NG", msg); };

import { original } from "./original.mjs";

// 空行・空白だけの行の違いだけを無視する(行の中身は1字もいじらない)
const norm = (s) => s.split("\n").map((l) => l.replace(/[ 　\t]+$/, "")).filter((l) => l.trim() !== "").join("\n");

const orig = new Map();
const texts = new Map();
const chunksOf = new Map();
let chunkCount = 0;

for (const w of index) {
  const o = original(w.source);
  const data = JSON.parse(read(`docs/data/works/${w.id}.json`));
  orig.set(w.id, { ...o, norm: norm(o.body) });
  texts.set(w.id, data.text);
  if (o.title.trim() !== w.title) fail(`${w.id}: 題名が原文の1行目と違う (${w.title})`);
  for (const bad of ["《", "》", "［＃", "｜", "※［"]) if (data.text.includes(bad)) fail(`${w.id}: 記号 ${bad} が残っている`);
  // アプリのデータ全体が、原文(独自に読み解いたもの)と一致すること
  if (norm(data.text) !== orig.get(w.id).norm) fail(`${w.id}: アプリの本文が原文と一致しない`);

  const chunks = chunkText(data.text);
  chunksOf.set(w.id, chunks);
  let prevEnd = 0;
  for (const [s, e] of chunks) {
    chunkCount++;
    const piece = data.text.slice(s, e);
    if (piece.trim() === "") fail(`${w.id}: 空のチャンク @${s}`);
    if (!orig.get(w.id).norm.includes(norm(piece))) fail(`${w.id}: 原文にないチャンク @${s}`);
    const skipped = data.text.slice(prevEnd, s);
    if (skipped.trim() !== "") fail(`${w.id}: 読み飛ばしがある @${prevEnd}`);
    // 行の途中でつながるときは、あいだに1字もはさまないこと(画面では前の段落にそのままつなぐため)
    if (!skipped.includes("\n") && skipped !== "") fail(`${w.id}: 行の途中で空白を飛ばしている @${prevEnd}`);
    const nUnits = sentenceUnits(piece).length;
    if (nUnits > 2 && !piece.includes("\n")) fail(`${w.id}: 3文以上のチャンク @${s}`);
    prevEnd = e;
  }
  if (data.text.slice(prevEnd).trim() !== "") fail(`${w.id}: 末尾が読まれない`);

  // 豆知識: 根拠の文言が原文末尾の書誌、または図書カードの生没年(catalog)にあること
  const a = catalog.authors[w.authorId];
  for (const f of w.facts) {
    for (const src of f.src) {
      const ok = o.foot.includes(src) || src === a.born || src === a.died;
      if (!ok) fail(`${w.id}: 豆知識の根拠が見つからない: ${src}`);
    }
    if (f.kind === "biblio") for (const src of f.src) if (!f.t.includes(src.replace(/作成$/, ""))) fail(`${w.id}: 豆知識の文に根拠がそのまま入っていない`);
  }
}

// ---- ガチャ ----
const byId = new Map(index.map((w) => [w.id, w]));
const rand = seededRandom(20241103);
let trivia = 0, similar = 0;
const N = 30000;
const rarityCount = [0, 0, 0, 0];
for (let k = 0; k < N; k++) {
  const cur = index[k % index.length];
  const g = drawGacha(index, cur, rand);
  if (!g) { fail(`${cur.id}: ガチャの結果がない`); continue; }
  if (g.type === "trivia") {
    trivia++;
    if (!g.work.facts.includes(g.fact)) fail("豆知識が作品の豆知識表にない");
    if (g.work.authorId !== cur.authorId) fail("豆知識が別の作者のもの");
  } else {
    similar++;
    rarityCount[g.rarity]++;
    if (g.work.id === cur.id) fail("似た作品カードに同じ作品が出た");
    const sc = similarity(cur, g.work);
    if (sc <= 0) fail("似ていない作品が出た");
    if (g.rarity !== rarityOf(sc)) fail("レア度が似ている度合いと合わない");
    // カードに出す文章 = その作品のどこかのチャンク(アプリは保存位置のチャンクを出す)
    const chunks = chunksOf.get(g.work.id);
    const [s, e] = chunks[Math.floor(rand() * chunks.length)];
    const shown = texts.get(g.work.id).slice(s, e).replace(/^[ 　]+/, "");
    if (!orig.get(g.work.id).norm.includes(norm(shown))) fail(`カードの文章が原文にない: ${g.work.id}`);
  }
}
const rate = trivia / N;
if (Math.abs(rate - TRIVIA_RATE) > 0.015) fail(`豆知識の出現率が ${rate.toFixed(3)}`);

// ---- タイムライン: 投稿の最初の文章と、そこから「続きを読む」で伸びる文章 ----
let feedPosts = 0;
const feedKinds = { opening: 0, resume: 0, excerpt: 0 };
{
  const recent = [];
  const pos = {};
  for (let k = 0; k < 5000; k++) {
    const interest = recent.slice(0, 3).map((id) => byId.get(id));
    const meta = pickFeedWork(index, recent.slice(0, 12), interest, rand);
    if (recent.slice(0, 12).includes(meta.id)) fail("最近出した作品がまた出た");
    recent.unshift(meta.id);
    const text = texts.get(meta.id), chunks = chunksOf.get(meta.id);
    const { i, kind } = feedStart(text, chunks, pos[meta.id] || 0, rand);
    feedKinds[kind]++;
    feedPosts++;
    if (i < 0 || i >= chunks.length) { fail(`${meta.id}: 投稿の開始位置がおかしい`); continue; }
    if (kind === "resume" && chunks[i][0] < pos[meta.id]) fail(`${meta.id}: 読みかけより前から始まった`);
    // 投稿の中で何回か「続きを読む」を押す: 出る文章は、最初の文章から切れ目なくつながった原文の一部
    const presses = Math.floor(rand() * 4);
    const last = Math.min(chunks.length - 1, i + presses);
    const shown = text.slice(chunks[i][0], chunks[last][1]);
    if (!orig.get(meta.id).norm.includes(norm(shown))) fail(`${meta.id}: 投稿の文章が原文にない @${chunks[i][0]}`);
    if (presses > 0) pos[meta.id] = chunks[last][1];
  }
}

// ---- 読み終えたら似た作品の冒頭へ ----
for (const w of index) {
  const next = nextWorkAfter(index, w, [w.id], rand);
  if (next.id === w.id) fail(`${w.id}: 読み終えたあと同じ作品に戻る`);
}
// 最初の作品から、読み終えた作品を避けながら全作品を読み切れること
{
  let cur = byId.get("43754");
  const done = [];
  for (let k = 0; k < index.length; k++) {
    done.push(cur.id);
    if (k < index.length - 1) {
      cur = nextWorkAfter(index, cur, done, rand);
      if (done.includes(cur.id)) { fail(`読み終えた作品 ${cur.id} にまたつながった`); break; }
    }
  }
  if (new Set(done).size !== index.length) fail("全作品をめぐれない");
}

console.log(`feed: ${feedPosts} 投稿 (冒頭 ${feedKinds.opening} / 読みかけ ${feedKinds.resume} / 抜き出し ${feedKinds.excerpt})`);
console.log(`works: ${index.length}, chunks: ${chunkCount}, gacha: ${N} (豆知識 ${(rate * 100).toFixed(1)}% / 似た作品 ${similar}, ★${rarityCount[1]} ★★${rarityCount[2]} ★★★${rarityCount[3]})`);
if (failures) {
  console.error(`FAILED: ${failures} 件`);
  process.exit(1);
}
console.log("OK: アプリが出すすべての文章は、青空文庫の原文の連続した部分と一致しました。");
