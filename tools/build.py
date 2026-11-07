#!/usr/bin/env python3
"""青空文庫の原文ファイル(Shift_JIS)からアプリ用データを作る。

- source/aozora/ 以下の原文(青空文庫のZIPに入っているテキストそのもの)を読む
- 冒頭の表題・記号説明、末尾の書誌情報を取り除く
- ルビ《》、ルビ開始記号｜、注記［＃…］を取り除く
- 外字注記 ※［＃…］ は、注記にある JIS X 0213 面区点番号 / U+XXXX を Unicode 文字に置き換える
- くの字点 ／＼ ／″＼ を 〳〵 〴〵 に置き換える(青空文庫の表記規則どおり)
- それ以外の文字は一字も変えない

出力: docs/data/index.json, docs/data/works/<id>.json
"""
import json
import pathlib
import re
import sys
from datetime import date

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "source" / "aozora"
OUT = ROOT / "docs" / "data"

GAIJI_RE = re.compile(r"※［＃([^］]*)］")
JIS_RE = re.compile(r"(?:第[34]水準)?([12])-(\d{1,2})-(\d{1,2})")
UCS_RE = re.compile(r"U\+([0-9A-Fa-f]{4,6})")
NOTE_RE = re.compile(r"［＃[^］]*］")
RUBY_RE = re.compile(r"《[^》]*》")


class BuildError(Exception):
    pass


def jis_to_unicode(men: int, ku: int, ten: int) -> str:
    b = bytes([0xA0 + ku, 0xA0 + ten])
    if men == 2:
        b = b"\x8f" + b
    return b.decode("euc_jis_2004")


def gaiji_char(note: str, where: str) -> str:
    m = UCS_RE.search(note)
    if m:
        return chr(int(m.group(1), 16))
    m = JIS_RE.search(note)
    if m:
        return jis_to_unicode(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    raise BuildError(f"{where}: Unicode に置き換えられない外字注記: ※［＃{note}］")


def split_source(raw: str):
    """原文を (表題行, 本文行, 書誌行) に分ける。"""
    lines = raw.replace("\r\n", "\n").split("\n")
    # 表題部: 最初の空行まで
    first_blank = lines.index("")
    head = lines[:first_blank]
    start = first_blank + 1
    # 記号説明ブロック(-------- で囲まれた部分)があれば飛ばす
    j = start
    while j < len(lines) and lines[j] == "":
        j += 1
    if j < len(lines) and lines[j].startswith("-----"):
        k = j + 1
        while not lines[k].startswith("-----"):
            k += 1
        start = k + 1
    # 書誌部: 最後の「底本：」行から
    foot_idx = max(i for i, l in enumerate(lines) if l.startswith("底本："))
    return head, lines[start:foot_idx], lines[foot_idx:]


def clean_line(line: str, gaiji_log: dict, where: str) -> str:
    def rep(m):
        ch = gaiji_char(m.group(1), where)
        gaiji_log[m.group(0)] = ch
        return ch

    s = GAIJI_RE.sub(rep, line)
    s = NOTE_RE.sub("", s)
    s = RUBY_RE.sub("", s)
    s = s.replace("｜", "")
    s = s.replace("／″＼", "〴〵").replace("／＼", "〳〵")
    return s


def clean_body(body_lines, where):
    gaiji_log = {}
    out = []
    for line in body_lines:
        had_note = "［＃" in line
        s = clean_line(line, gaiji_log, where)
        # 注記だけの行(字下げ指定・改ページなど)は行ごと消す
        if had_note and s.strip(" 　") == "":
            continue
        out.append(s.rstrip())
    # 前後の空行と、3行以上続く空行を整理(空白の量だけで、文字は変えない)
    text = "\n".join(out).strip("\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    for bad in ("《", "》", "［＃", "｜"):
        if bad in text:
            raise BuildError(f"{where}: 取り除けなかった記号 {bad}")
    return text, gaiji_log


def biblio(foot_lines):
    """書誌部から 底本 / 底本の親本 / 初出 / 作成日 を取り出す(文言はそのまま)。"""
    fields = {}
    key = None
    for l in foot_lines:
        m = re.match(r"^(底本の親本|底本|初出)：(.*)$", l)
        if m:
            key = m.group(1)
            fields[key] = [m.group(2).strip()]
            continue
        if key and l.startswith("　") and l.strip("　 "):
            fields[key].append(l.strip("　 "))
            continue
        key = None
        m = re.match(r"^(\d{4})年(\d{1,2})月(\d{1,2})日作成", l)
        if m and "created" not in fields:
            fields["created"] = f"{m.group(1)}年{int(m.group(2))}月{int(m.group(3))}日"
            fields["created_raw"] = m.group(0)
    return fields


ERA_DATE = re.compile(r"(\d{4})（[^）]*）年(?:(\d{1,2})月)?(?:(\d{1,2})日)?")


def age_fact(author, born, first_pub):
    """初出年と生年月日から作者の年齢を出す。"""
    m = ERA_DATE.search(first_pub)
    if not m:
        return None
    y = int(m.group(1))
    by, bm, bd = map(int, born.split("-"))
    if m.group(2) and m.group(3):
        d = date(y, int(m.group(2)), int(m.group(3)))
        age = y - by - ((d.month, d.day) < (bm, bd))
        return f"初出の{y}年{int(m.group(2))}月{int(m.group(3))}日、{author}は満{age}歳でした。"
    return f"初出の{y}年は、{author}が満{y - by}歳になる年でした。"


def make_facts(title, author, a, b):
    """豆知識。src には根拠(原文末尾の書誌の文言 / 図書カードの生没年)をそのまま入れる。"""
    facts = []
    if "初出" in b:
        pub = "、".join(b["初出"])
        facts.append({"t": f"『{title}』の初出は{pub}です。", "src": b["初出"], "kind": "biblio"})
        af = age_fact(author, a["born"], pub)
        if af:
            facts.append({"t": af, "src": [a["born"]] + b["初出"][:1], "kind": "age"})
    if "底本" in b:
        facts.append({"t": f"青空文庫版『{title}』の底本は{'、'.join(b['底本'])}です。", "src": b["底本"], "kind": "biblio"})
    if "底本の親本" in b:
        facts.append({"t": f"『{title}』の底本の親本は{'、'.join(b['底本の親本'])}です。", "src": b["底本の親本"], "kind": "biblio"})
    if "created" in b:
        facts.append({"t": f"青空文庫で『{title}』のファイルが作られたのは{b['created']}です。", "src": [b["created_raw"]], "kind": "biblio"})
    by, bm, bd = a["born"].split("-")
    dy, dm, dd = a["died"].split("-")
    facts.append({"t": f"{author}は{by}年{int(bm)}月{int(bd)}日に生まれ、{dy}年{int(dm)}月{int(dd)}日に亡くなりました。", "src": [a["born"], a["died"]], "kind": "author"})
    # 作者のエピソード(tools/catalog.json の authors.*.episodes。手で書いたもの)
    for ep in a.get("episodes", []):
        facts.append({"t": ep, "src": ["catalog:episodes"], "kind": "episode"})
    return facts


def main():
    catalog = json.loads((ROOT / "tools" / "catalog.json").read_text("utf-8"))
    (OUT / "works").mkdir(parents=True, exist_ok=True)
    index = []
    errors = []
    gaiji_all = {}
    for w in catalog["works"]:
        path = SRC / w["file"]
        pid = w["file"].split("/")[0]
        a = catalog["authors"][pid]
        wid = w["file"].split("/")[2].split("_")[0]
        raw = path.read_bytes().decode("cp932")
        head, body, foot = split_source(raw)
        title = head[0].strip()
        try:
            text, glog = clean_body(body, w["file"])
        except BuildError as e:
            errors.append(str(e))
            continue
        gaiji_all.update(glog)
        b = biblio(foot)
        rec = {
            "id": wid,
            "title": title,
            "author": a["name"],
            "authorId": pid,
            "genre": w["genre"],
            "tags": w["tags"],
            "chars": len(text),
            "facts": make_facts(title, a["name"], a, b),
            "card": f"https://www.aozora.gr.jp/cards/{pid}/card{wid}.html",
            "source": w["file"],
        }
        index.append(rec)
        (OUT / "works" / f"{wid}.json").write_text(
            json.dumps({"id": wid, "title": title, "author": a["name"], "text": text}, ensure_ascii=False),
            "utf-8",
        )
    if errors:
        print("\n".join(errors), file=sys.stderr)
        sys.exit(1)
    (OUT / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=0), "utf-8")
    (ROOT / "tools" / "gaiji-used.json").write_text(
        json.dumps(gaiji_all, ensure_ascii=False, indent=1), "utf-8"
    )
    print(f"{len(index)} works, {sum(r['chars'] for r in index)} chars, {len(gaiji_all)} gaiji")


if __name__ == "__main__":
    main()
