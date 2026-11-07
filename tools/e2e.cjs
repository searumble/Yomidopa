#!/usr/bin/env node
// 実際のブラウザ(iPhone の画面サイズ)でタイムラインを動かし、画面に出た文章をすべて原文と照らし合わせる。
// 使い方: node tools/e2e.cjs [押す回数]   (Playwright が必要)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium, devices } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const DOCS = path.join(ROOT, "docs");
const PRESSES = Number(process.argv[2] || 300);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

const norm = (s) => s.split("\n").map((l) => l.replace(/[ 　\t]+$/, "")).filter((l) => l.trim() !== "").join("\n");

async function main() {
  // 照合用の原文(build の出力ではなく、verify.mjs と同じ独自の読み解き結果を使う)
  const index = JSON.parse(fs.readFileSync(path.join(DOCS, "data/index.json")));
  const { original } = await import(pathToFileURL(path.join(__dirname, "original.mjs")));
  const byId = new Map(index.map((w) => [w.id, { ...w, orig: norm(original(w.source).body) }]));
  const byTitle = new Map([...byId.values()].map((w) => [w.title, w]));

  const server = http.createServer((req, res) => {
    const p = path.join(DOCS, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
    fs.readFile(p, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" });
      res.end(buf);
    });
  }).listen(0);
  const url = `http://127.0.0.1:${server.address().port}/`;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForSelector(".post .more");

  let bad = 0, checked = 0, taps = 0;
  const trivia = new Set();
  const cards = { trivia: 0, similar: 0 };
  const ng = (...a) => { bad++; console.error("NG", ...a); };

  for (let k = 0; k < PRESSES; k++) {
    // ときどき下までスクロールしてタイムラインを伸ばす
    if (k % 10 === 0) {
      await page.evaluate(() => { const m = document.getElementById("scroller"); m.scrollTop = m.scrollHeight; });
      await page.waitForTimeout(150);
    }
    const buttons = await page.$$(".post .more");
    // 同じ投稿を何回か押すことも、別の投稿を押すこともある
    const btn = buttons[(k * 7) % buttons.length];
    await btn.click({ force: true });
    await page.waitForFunction(() => !document.body.dataset.busy);
    // 豆知識は通知(トースト)に出る
    const toast = await page.$eval("#toast", (t) => (t.hidden ? null : { cls: t.className, text: t.textContent }));
    if (toast && toast.cls.includes("trivia")) {
      trivia.add(toast.text);
      if (!toast.text.startsWith("📜 ")) ng("豆知識の通知の形", toast.text);
    }
  }

  // タイムラインの一番上の 🎁 似た作品: タップなしで読める投稿(「続きを読む」付き)になっていること
  const tops = await page.$$eval("#feed > .top-card", (cs) => cs.map((c) => ({
    work: c.dataset.work, read: !!c.dataset.read,
    text: [...c.querySelectorAll(".post-body p")].map((p) => p.textContent).join("\n"),
    label: c.querySelector(".post-gift span")?.textContent, hasButton: !!c.querySelector("button.more"),
  })));
  for (const c of tops) {
    cards.similar++;
    checked++;
    if (c.label !== "🎁 似た作品") ng("似た作品のラベル", c.label);
    if (!c.hasButton) ng("似た作品の投稿に「続きを読む」がない");
    if (!byId.get(c.work)?.orig.includes(norm(c.text))) ng("似た作品の文章が原文にない", c.work);
  }
  const unread = tops.filter((c) => !c.read);
  if (tops.length === 0) ng("似た作品が一番上に出ていない");
  if (new Set(unread.map((c) => c.work)).size !== unread.length) ng("まだ読んでいない同じ作品の投稿が重なっている");
  if (unread.length > 5) ng("一番上の似た作品が多すぎる", unread.length);
  if (tops.length) {
    // 一番上の似た作品の「続きを読む」を、タップなしでそのまま押せること
    const before = await page.$eval("#feed > .top-card .post-body", (b) => b.textContent.length);
    await page.click("#feed > .top-card .more", { force: true });
    await page.waitForFunction(() => !document.body.dataset.busy);
    taps++;
    const after = await page.$eval("#feed > .top-card .post-body", (b) => b.textContent.length).catch(() => before + 1);
    if (!(after > before)) ng("一番上の似た作品の続きが読めない");
  }
  for (const n of await page.evaluate(() => window.__yomiNotes)) {
    if (n.kind === "trivia") trivia.add(`${n.icon} ${n.text}`);
    if (n.kind === "praise" && /上位|位|%|人が/.test(n.text)) ng("ほめる通知に統計や他人の話", n.text);
    if (n.kind === "praise" && /を30回|5,000文字|はじめてです|半分まで/.test(n.text)) ng("消したはずの通知", n.text);
  }
  // 通知に出た豆知識が、作品の豆知識表(書誌から作ったもの)にあること
  const allFacts = new Set(index.flatMap((w) => w.facts.map((f) => f.t)));
  for (const t of trivia) {
    checked++;
    if (!allFacts.has(t.replace(/^📜 /, ""))) ng("書誌にない豆知識", t);
  }
  cards.trivia = trivia.size;

  // すべての投稿: 本文が、その作品の原文の切れ目のない一部であること
  const posts = await page.$$eval(".post", (ps) => ps.map((p) => ({
    work: p.dataset.work,
    title: p.querySelector(".post-title").textContent,
    paras: [...p.querySelectorAll(".post-body p")].map((x) => x.textContent),
  })));
  const titles = new Set();
  for (const p of posts) {
    const w = byId.get(p.work);
    checked++;
    titles.add(p.title);
    if (!w || w.title !== p.title) { ng("投稿の題名と作品が合わない", p.title); continue; }
    if (!w.orig.includes(norm(p.paras.join("\n")))) ng("投稿の文章が原文にない", p.title);
  }

  // 画面に説明文(「ガチャ」など)や偽の統計が出ていないこと
  const bodyText = await page.textContent("body");
  if (/ガチャ|発動|上位\s*\d+\s*%|ランキング/.test(bodyText)) ng("説明文/偽の統計が出ている");
  // ボタンは各投稿の「続きを読む」だけ
  const labels = await page.$$eval("button, [role=button]", (b) => [...new Set(b.map((x) => x.textContent.trim()))]);
  if (labels.length !== 1 || labels[0] !== "続きを読む") ng("ボタン", labels);
  if (errors.length) ng("JS エラー", errors);

  await page.screenshot({ path: path.join(process.env.SHOT_DIR || ROOT, "e2e-last.png") });
  await browser.close();
  server.close();
  console.log(`presses: ${PRESSES}, 投稿: ${posts.length} (${titles.size}作品), 通知に出た豆知識: ${cards.trivia}種, 一番上の似た作品: ${cards.similar}件, その場で続きを読めた: ${taps}, 照合: ${checked}`);
  if (bad) { console.error(`FAILED: ${bad}`); process.exit(1); }
  console.log("OK: 画面に出た文章はすべて原文の連続した部分でした。");
}
main().catch((e) => { console.error(e); process.exit(1); });
