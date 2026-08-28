# -*- coding: utf-8 -*-
"""dict.js 굽기 — ENABLE 원본을 접두사 압축(front-coding)해 classic script로 굽는다.

압축 형식: 정렬된 단어 목록에서 앞 단어와 공유하는 접두사 길이를 마커 1글자로 적고
          나머지 접미사만 잇는다. 마커는 chr(48+n) ('0'~'?'), 접미사는 소문자 a~z.
          마커가 소문자가 아니므로 구분자 없이 그리디 파싱이 된다.
"""
import io, os, json

BASE = os.path.dirname(os.path.abspath(__file__))
SRC  = os.path.join(BASE, 'enable1.txt')
OUT  = os.path.join(BASE, '..', 'dict.js')

MIN_LEN, MAX_LEN = 3, 15

words = []
for line in io.open(SRC, encoding='ascii'):
    w = line.strip()
    if MIN_LEN <= len(w) <= MAX_LEN and w.isalpha() and w.islower():
        words.append(w)
words = sorted(set(words))

# --- 접두사 압축 ---
buf, prev = [], ''
for w in words:
    n = 0
    m = min(len(prev), len(w), MAX_LEN)
    while n < m and prev[n] == w[n]:
        n += 1
    buf.append(chr(48 + n))
    buf.append(w[n:])
    prev = w
packed = ''.join(buf)

# --- 글자별 시작/끝 집계 → 구제 글자 선정 ---
start = {}
end = {}
for w in words:
    start[w[0]] = start.get(w[0], 0) + 1
    end[w[-1]] = end.get(w[-1], 0) + 1

RATIO_MIN, START_MIN = 2.0, 1000
rescue, table = [], []
for c in 'abcdefghijklmnopqrstuvwxyz':
    s, e = start.get(c, 0), end.get(c, 0)
    r = (float(e) / s) if s else float('inf')
    hit = (r >= RATIO_MIN) and (s < START_MIN)
    if hit:
        rescue.append(c)
    table.append((c, s, e, r, hit))

# --- 굽기 ---
js = io.open(OUT, 'w', encoding='utf-8')
js.write(u'/* dict.js — 판정용 내장 사전 (자동 생성, 직접 수정하지 말 것)\n')
js.write(u'   원본: ENABLE 워드리스트 (Alan Beale, 퍼블릭 도메인) — _source/enable1.txt\n')
js.write(u'   생성: _source/build_dict.py\n')
js.write(u'   수록: %d단어 (%d~%d자)\n' % (len(words), MIN_LEN, MAX_LEN))
js.write(u'   압축: 접두사 압축(front-coding). 마커 1글자 + 접미사, 구분자 없음 */\n')
js.write(u'(function(){\n')
js.write(u'"use strict";\n')
js.write(u'var PACKED="%s";\n' % packed)
js.write(u'/* 구제 글자 — 선정식: (끝나는 단어 수 / 시작 단어 수) >= %.1f AND 시작 단어 수 < %d */\n'
         % (RATIO_MIN, START_MIN))
js.write(u'var RESCUE=%s;\n' % json.dumps(rescue))
js.write(u'var STARTS=%s;\n' % json.dumps(start, sort_keys=True))
js.write(u'''
/* PACKED를 풀어 단어 배열로 되돌린다. 마커는 비소문자, 접미사는 소문자라 구분자가 필요 없다. */
function unpack(){
  var out=[], prev="", i=0, n=PACKED.length;
  while(i<n){
    var shared=PACKED.charCodeAt(i++)-48;
    var j=i;
    while(j<n){ var c=PACKED.charCodeAt(j); if(c<97||c>122) break; j++; }
    var w=prev.slice(0,shared)+PACKED.slice(i,j);
    out.push(w); prev=w; i=j;
  }
  return out;
}
window.WB_DICT={ unpack:unpack, RESCUE:RESCUE, STARTS:STARTS, COUNT:%d };
})();
''' % len(words))
js.close()

print(u'단어 %d개' % len(words))
print(u'원본 %d B → PACKED %d B (%.1f%%)' % (
    sum(len(w)+1 for w in words), len(packed),
    100.0*len(packed)/sum(len(w)+1 for w in words)))
print(u'dict.js %d B' % os.path.getsize(OUT))
print(u'구제 글자: %s' % rescue)
print(u'\n글자  시작    끝    배율  구제')
for c, s, e, r, hit in table:
    if hit or r >= 1.5 or s < 1500:
        print(u'  %s %6d %6d %7.2f  %s' % (c, s, e, r, 'O' if hit else ''))
