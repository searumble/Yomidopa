#!/usr/bin/env python3
"""外字の置き換え表(tools/gaiji-used.json)を、build.py とは別の方法で確かめる。

build.py は面区点 → EUC-JIS-2004 で文字を得ている。ここでは面区点 → Shift_JIS-2004 の
バイト列を自前で計算してデコードし、同じ文字になるかを見る。U+XXXX はそのまま比べる。
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MEN2_S1 = {1: 0xF0, 8: 0xF0, 3: 0xF1, 4: 0xF1, 5: 0xF2, 12: 0xF2, 13: 0xF3, 14: 0xF3, 15: 0xF4}


def sjis2004(men, ku, ten):
    if men == 1:
        s1 = (ku + 0x101) >> 1 if ku <= 62 else (ku + 0x181) >> 1
    else:
        s1 = MEN2_S1[ku] if ku in MEN2_S1 else (ku + 0x19B) >> 1
    if ku % 2:
        s2 = ten + 0x3F + (1 if ten >= 64 else 0)
    else:
        s2 = ten + 0x9E
    return bytes([s1, s2]).decode("shift_jis_2004")


def main():
    table = json.loads((ROOT / "tools" / "gaiji-used.json").read_text("utf-8"))
    bad = 0
    for note, ch in table.items():
        m = re.search(r"U\+([0-9A-Fa-f]{4,6})", note)
        if m:
            expect = chr(int(m.group(1), 16))
        else:
            m = re.search(r"(?:第[34]水準)?([12])-(\d{1,2})-(\d{1,2})", note)
            expect = sjis2004(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        if expect != ch:
            bad += 1
            print(f"NG {note}: {ch!r} != {expect!r}")
    print(f"gaiji: {len(table) - bad}/{len(table)} OK")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
