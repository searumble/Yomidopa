#!/usr/bin/env python3
"""tools/additions.json の作品を、青空文庫の公式 ZIP から取得して収録に加える。

使い方: python3 tools/fetch_additions.py <list_person_all_extended_utf8.csv>
  (CSV は https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip の中身)

- 作品著作権フラグ・人物著作権フラグ(その作品にかかわる全員)が「なし」のものだけを使う
- 文字遣いは 新字新仮名 > 新字旧仮名 > 旧字旧仮名 の順に選ぶ
- 原文 .txt は ZIP の中身をそのまま source/aozora/<人物ID>/files/<ZIP名>/<ZIP名>.txt に置く
- tools/catalog.json の works に追加し、新しい作者は CSV の生年月日・没年月日で authors に追加する
"""
import collections
import csv
import io
import json
import pathlib
import sys
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
PREF = {"新字新仮名": 0, "新字旧仮名": 1, "旧字新仮名": 2, "旧字旧仮名": 3}
ALIASES = {"芥川龍之介": "芥川竜之介", "森鴎外": "森鷗外"}
TITLE_ALIASES = {"でんでんむしのかなしみ": "デンデンムシノ　カナシミ"}


def main(csv_path):
    rows = list(csv.reader(open(csv_path, encoding="utf-8-sig")))[1:]
    by_work = collections.defaultdict(list)
    for r in rows:
        by_work[r[0]].append(r)
    catalog = json.loads((ROOT / "tools/catalog.json").read_text("utf-8"))
    have = {w["file"] for w in catalog["works"]}
    have_ids = {w["file"].split("/")[2].split("_")[0] for w in catalog["works"]}
    adds = json.loads((ROOT / "tools/additions.json").read_text("utf-8"))
    for a in adds:
        name = ALIASES.get(a["author"], a["author"])
        title = TITLE_ALIASES.get(a["title"], a["title"])
        cands = [r for r in rows if r[15] + r[16] in (name, a["author"]) and r[1] == title and r[23] == "著者"]
        cands = [r for r in cands if r[10] == "なし" and all(x[26] == "なし" for x in by_work[r[0]])]
        cands = [r for r in cands if r[45].endswith(".zip")]
        if not cands:
            print("見つからない/著作権あり:", a["author"], a["title"])
            continue
        r = sorted(cands, key=lambda r: (PREF.get(r[9], 9), -int(r[0])))[0]
        pid, url = r[14], r[45]
        base = url.rsplit("/", 1)[1][:-4]
        rel = f"{pid}/files/{base}/{base}.txt"
        if rel in have or str(int(r[0])) in have_ids:
            print("収録ずみ:", a["title"])
            continue
        data = urllib.request.urlopen(url, timeout=60).read()
        z = zipfile.ZipFile(io.BytesIO(data))
        txts = [n for n in z.namelist() if n.lower().endswith(".txt")]
        assert len(txts) == 1, (url, z.namelist())
        dest = ROOT / "source/aozora" / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(z.read(txts[0]))
        catalog["works"].append({"file": rel, "genre": a["genre"], "tags": a["tags"]})
        if pid not in catalog["authors"]:
            catalog["authors"][pid] = {"name": a["author"], "born": r[24], "died": r[25], "episodes": [],
                                       "sources": [f"https://www.aozora.gr.jp/index_pages/person{int(pid)}.html"]}
        print("追加:", a["author"], a["title"], r[9], rel)
    (ROOT / "tools/catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2), "utf-8")
    print(len(catalog["works"]), "作品")


if __name__ == "__main__":
    main(sys.argv[1])
