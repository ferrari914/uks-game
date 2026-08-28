# -*- coding: utf-8 -*-
"""core.js / extra.js 굽기 — 손으로 쓴 원본(TSV·목록)에서 배포 파일을 만든다.

입력
  core_am.tsv / core_go.tsv / core_pz.tsv / core_fill.tsv  기초어 + 한글 뜻 (탭 구분)
  extra_words.txt                                          현대 어휘 보강 목록
  block_words.txt                                          차단 목록
  ../dict.js                                               대조용 (미수록·중복·형식 검사)

검증에 걸리면 굽지 않고 멈춘다 — 잘못된 사전이 배포되는 것보다 낫다.
"""
import io, os, re, sys, collections

BASE = os.path.dirname(os.path.abspath(__file__))
def P(*a): return os.path.join(BASE, *a)

# --- dict.js 를 풀어 대조용 집합을 만든다 ---
src = io.open(P('..', 'dict.js'), encoding='utf-8').read()
packed = re.search(r'var PACKED="(.*?)";\n', src, re.S).group(1)
words, prev, i, n = [], '', 0, len(packed)
while i < n:
    sh = ord(packed[i]) - 48; i += 1
    j = i
    while j < n and 'a' <= packed[j] <= 'z': j += 1
    w = prev[:sh] + packed[i:j]; words.append(w); prev = w; i = j
DICT = set(words)

def fail(msg):
    sys.stderr.write(u'중단: %s\n' % msg); sys.exit(1)

WORD_RE = re.compile(r'^[a-z]{3,15}$')

# ================= extra.js =================
extra = sorted(set(w.strip() for w in io.open(P('extra_words.txt'), encoding='ascii') if w.strip()))
for w in extra:
    if not WORD_RE.match(w): fail(u'extra 형식 위반: %s' % w)
    if w in DICT:            fail(u'extra 가 ENABLE과 중복: %s' % w)

def wrap(items, width=92):
    out, line = [], u''
    for k, it in enumerate(items):
        tok = u'"%s"%s' % (it, u',' if k < len(items)-1 else u'')
        if len(line) + len(tok) > width:
            out.append(line); line = u''
        line += tok
    if line: out.append(line)
    return u'\n'.join(out) + u'\n'

f = io.open(P('..', 'extra.js'), 'w', encoding='utf-8')
f.write(u'''/* extra.js — 현대 어휘 보강 목록 (판정 전용)   [자동 생성: _source/build_core.py]

   왜 필요한가: dict.js의 원본인 ENABLE은 1997년경 리스트라 현대 어휘가 없다.
   실측 결과 현대어 표본에서 email·internet·online·website·blog·app·wifi·emoji 등이
   전부 누락이었다. 사전이 16만 개여도 학습자가 가장 먼저 떠올리는 단어가 거부되면
   그 자리에서 게임이 끝난다.

   ⚠ 이 목록은 **판정에만 쓰고 AI의 단어 풀에는 넣지 않는다.**
      표준 사전에 없는 조어가 섞여 있어 AI가 내면 플레이어가 납득하지 못한다.
      플레이어를 도와주기만 하고 불리하게는 작용하지 않는 쪽으로 비대칭을 유지한다.

   선정 기준
     포함 — 학습자가 실제로 입력할 법한 현대 어휘와 그 굴절형(app/apps 함께)
     제외 — 고유명사·상표(chatgpt, bitcoin, roomba, faceid),
            문자로 읽는 약어(url, usb — SPEC §3.5 약어 배제),
            두 낱말이 옳은 것(qrcode, solarpanel, carsharing),
            원형이 사전에 없는 억지 파생(googling), 16자 이상

   수록 %d개. 전량 ENABLE과 대조해 중복 0 확인. 손으로 고른 목록이므로 빠진 것이 남아 있다.
*/
(function(){
"use strict";
window.WB_EXTRA=[
''' % len(extra))
f.write(wrap(extra)); f.write(u'];\n})();\n'); f.close()

# ================= core.js =================
rows, seen = [], set()
for fn in ['core_am.tsv', 'core_go.tsv', 'core_pz.tsv', 'core_fill.tsv']:
    for ln in io.open(P(fn), encoding='utf-8'):
        ln = ln.rstrip(u'\n')
        if not ln.strip(): continue
        w, _, ko = ln.partition(u'\t'); w = w.strip(); ko = ko.strip()
        if w in seen:                  fail(u'core 중복: %s' % w)
        if not WORD_RE.match(w):
            sys.stderr.write(u'  건너뜀(형식): %s\n' % w); continue   # 2글자 등은 규칙②로 어차피 못 쓴다
        if not ko:                     fail(u'core 한글 뜻 없음: %s' % w)
        if u'|' in ko or u'"' in ko:   fail(u'core 뜻에 구분자/따옴표: %s' % w)
        if w not in DICT and w not in set(extra): fail(u'core 가 사전에 없음: %s' % w)
        seen.add(w); rows.append((w, ko))

block = sorted(set(w.strip() for w in io.open(P('block_words.txt'), encoding='ascii') if w.strip()))
cnt = collections.Counter(w[0] for w, _ in rows)

f = io.open(P('..', 'core.js'), 'w', encoding='utf-8')
f.write(u'''/* core.js — 기초 영단어 + 한글 뜻, 그리고 차단 목록   [자동 생성: _source/build_core.py]

   쓰임새 셋
     1) AI 견습 난이도의 단어 풀 — AI가 zygodactylous 같은 걸 내면 학습도 재미도 없다
     2) 힌트·전적 화면의 한글 뜻 — Englknight의 교육 축. 16만 개에 뜻을 달 방법은 없다
     3) 판정 사전의 일부 (dict.js + extra.js + core.js 를 하나의 Set으로 합친다)

   수록 %d개. 전량 dict.js와 대조해 **사전 미수록 0 · 중복 0 · 형식 위반 0** 확인.
   글자별 커버리지를 의도적으로 배분했다 — AI가 어느 글자를 받아도 답할 수 있어야 한다.
   x가 %d개뿐인 것은 영어 자체의 한계다(학습자가 쓸 x 단어가 그것뿐).
   구제 글자 규칙(SPEC §4.3)이 받는다.

   형식: "단어|뜻" 을 줄바꿈으로 이었다. 뜻에 | 와 따옴표가 없음을 굽는 시점에 검증한다.

   ── BLOCK: 차단 목록 %d개 ──
   dict.js의 원본 ENABLE에는 욕설·비속어·차별어가 그대로 들어 있다. 사이트가 공개 배포되고
   어린 사용자도 있으므로 판정 규칙 ⑥에서 막는다.
   ⚠ **AI 단어 풀에서도 반드시 제외한다.** 기사·검성 난이도는 넓은 풀을 쓰므로
      거르지 않으면 AI가 욕설을 낸다. 이게 차단 목록의 더 중요한 쓰임이다.
*/
(function(){
"use strict";
var PAIRS=[
''' % (len(rows), cnt.get('x', 0), len(block)))
f.write(wrap([u'%s|%s' % r for r in rows]))
f.write(u'];\n\nvar BLOCK=[\n')
f.write(wrap(block))
f.write(u'''];

var WORDS=[], MEAN={};
for(var i=0;i<PAIRS.length;i++){
  var p=PAIRS[i], k=p.indexOf("|"), w=p.slice(0,k);
  WORDS.push(w); MEAN[w]=p.slice(k+1);
}
window.WB_CORE={ WORDS:WORDS, MEAN:MEAN, BLOCK:BLOCK };
})();
''')
f.close()

print(u'extra.js  %d단어' % len(extra))
print(u'core.js   %d단어 / 차단 %d개' % (len(rows), len(block)))
print(u'글자별: ' + u''.join(u'%s:%-4d' % (c, cnt.get(c, 0)) for c in u'abcdefghijklmnopqrstuvwxyz'))
low = [c for c in u'abcdefghijklmnopqrstuvwxyz' if cnt.get(c, 0) < 10]
print(u'10개 미만: %s' % (u' '.join(low) if low else u'없음'))
