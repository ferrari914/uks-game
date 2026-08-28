/* renju.js — 렌주룰 오목 규칙 엔진
 * ------------------------------------------------------------------
 * 화면·통신 코드와 완전히 분리한다. 이유: 승부 판정이 이 게임의 전부인데
 * 눈으로 봐서는 금수 판정이 맞는지 알 수 없다. 여기만 떼어 node로 돌려야
 * 검증이 된다 (test-renju.js).
 *
 * classic script다. ES 모듈을 쓰면 file:// 더블클릭에서 로드되지 않는다.
 *
 * 규칙(RIF 렌주):
 *   흑 — 정확히 5목만 승리. 6목 이상(장목)·삼삼·사사는 금수
 *   백 — 제한 없음. 5목 이상이면 승리
 *   5목이 되는 수는 금수보다 우선한다 (동시에 삼삼이어도 흑의 승리)
 */
(function (root) {
'use strict';

var N = 15, SIZE = N * N;
var EMPTY = 0, BLACK = 1, WHITE = 2;
var DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
var DEPTH = 3;               // 삼 판정의 재귀 상한. 실전에서 3을 넘는 경우는 없다

function idx(x, y) { return y * N + x; }
function inb(x, y) { return x >= 0 && x < N && y >= 0 && y < N; }
function emptyBoard() { var b = new Array(SIZE); for (var i = 0; i < SIZE; i++) b[i] = EMPTY; return b; }

/* (x,y)를 포함하는 dir 방향의 최대 연속 구간을 낮은 좌표부터 담아 반환.
   여기서 "연속"은 판 경계를 넘지 않는다 — 경계를 넘겨 세는 것이
   1차원 배열 오목의 최다 버그다. inb()로 매 칸 막는다. */
function run(b, x, y, dx, dy, c) {
  var a = [], i, nx, ny;
  for (i = 1; ; i++) { nx = x - dx * i; ny = y - dy * i; if (!inb(nx, ny) || b[idx(nx, ny)] !== c) break; a.unshift(idx(nx, ny)); }
  a.push(idx(x, y));
  for (i = 1; ; i++) { nx = x + dx * i; ny = y + dy * i; if (!inb(nx, ny) || b[idx(nx, ny)] !== c) break; a.push(idx(nx, ny)); }
  return a;
}

/* 방금 (x,y)에 c를 둔 판에서 승리 라인. 없으면 null.
   흑은 정확히 5, 백은 5 이상. */
function winLine(b, x, y, c) {
  for (var d = 0; d < 4; d++) {
    var seg = run(b, x, y, DIRS[d][0], DIRS[d][1], c);
    if (c === WHITE ? seg.length >= 5 : seg.length === 5) return seg;
  }
  return null;
}

/* --- 금수 판정 내부 --------------------------------------------------- */

/* 사(四)를 "오가 되는 빈 점의 수"로 세면 열린사 `.●●●●.`가 양끝 2개로 잡혀
   사사로 오판된다. 열린사는 하나의 사다.
   → 오를 이루는 돌 4개의 집합을 키로 삼아 중복 제거한다. 한 줄 안의 진짜
     이중사는 돌 집합이 달라 2로 세어진다. */
function collectFours(b, x, y, dx, dy, out) {
  var me = idx(x, y), i, qx, qy, q, seg, k, j;
  for (i = -4; i <= 4; i++) {
    if (i === 0) continue;
    qx = x + dx * i; qy = y + dy * i;
    if (!inb(qx, qy) || b[idx(qx, qy)] !== EMPTY) continue;
    q = idx(qx, qy);
    b[q] = BLACK;
    seg = run(b, qx, qy, dx, dy, BLACK);
    b[q] = EMPTY;
    if (seg.length !== 5) continue;          // 6목이 되는 자리는 오가 아니다
    if (seg.indexOf(me) < 0) continue;       // 이번 수가 낀 사만 센다
    k = [];
    for (j = 0; j < seg.length; j++) if (seg[j] !== q) k.push(seg[j]);
    out[k.join(',')] = 1;                    // seg는 오름차순이라 키가 안정적이다
  }
}

/* 방금 (x,y)에 흑을 둔 판에서, 이 방향으로 오가 되는 지점의 수.
   2개면 열린사다. */
function fivePoints(b, x, y, dx, dy) {
  var me = idx(x, y), n = 0, i, qx, qy, q, seg;
  for (i = -4; i <= 4; i++) {
    if (i === 0) continue;
    qx = x + dx * i; qy = y + dy * i;
    if (!inb(qx, qy) || b[idx(qx, qy)] !== EMPTY) continue;
    q = idx(qx, qy);
    b[q] = BLACK;
    seg = run(b, qx, qy, dx, dy, BLACK);
    b[q] = EMPTY;
    if (seg.length === 5 && seg.indexOf(me) >= 0) n++;
  }
  return n;
}

/* 삼(三): 한 수를 더 두면 열린사가 되는 형태.
   단 그 한 수를 두는 지점이 흑에게 금수가 아니어야 한다 — 여기서 재귀가 난다. */
function threeInDir(b, x, y, dx, dy, depth) {
  var me = idx(x, y), i, qx, qy, q, open, seg;
  for (i = -4; i <= 4; i++) {
    if (i === 0) continue;
    qx = x + dx * i; qy = y + dy * i;
    if (!inb(qx, qy) || b[idx(qx, qy)] !== EMPTY) continue;
    q = idx(qx, qy);
    b[q] = BLACK;
    seg = run(b, q % N, (q / N) | 0, dx, dy, BLACK);
    open = seg.indexOf(me) >= 0 && fivePoints(b, qx, qy, dx, dy) >= 2;
    b[q] = EMPTY;
    if (!open) continue;
    if (depth > 0 && forbidAt(b, qx, qy, depth - 1)) continue;  // 금수 자리로는 사를 못 뻗는다
    return true;
  }
  return false;
}

/* 이른 배제: 삼삼은 주변 흑돌 4개, 사사는 6개, 장목은 5개가 있어야 성립한다.
   빈 판 대부분이 여기서 걸러져 forbiddenMap()이 실용 속도로 돈다. */
function nearBlack(b, x, y) {
  var n = 0, d, i, nx, ny;
  for (d = 0; d < 4; d++) {
    for (i = -4; i <= 4; i++) {
      if (i === 0) continue;
      nx = x + DIRS[d][0] * i; ny = y + DIRS[d][1] * i;
      if (inb(nx, ny) && b[idx(nx, ny)] === BLACK) n++;
    }
  }
  return n;
}

/* (x,y)에 흑이 이미 놓인 판을 받아 금수 사유를 반환 */
function judge(b, x, y, depth) {
  var d, seg, over = false, out = {}, t = 0;
  for (d = 0; d < 4; d++) {
    seg = run(b, x, y, DIRS[d][0], DIRS[d][1], BLACK);
    if (seg.length === 5) return null;       // 오 우선 — 삼삼이어도 이 수는 승리다
    if (seg.length >= 6) over = true;
  }
  if (over) return 'overline';
  for (d = 0; d < 4; d++) collectFours(b, x, y, DIRS[d][0], DIRS[d][1], out);
  var fours = 0; for (var k in out) if (out.hasOwnProperty(k)) fours++;
  if (fours >= 2) return 'four';
  for (d = 0; d < 4; d++) {
    if (threeInDir(b, x, y, DIRS[d][0], DIRS[d][1], depth)) { t++; if (t >= 2) return 'three'; }
  }
  return null;
}

/* 빈 칸 (x,y)에 흑을 두면 금수인가. 'three'|'four'|'overline'|null */
function forbidAt(b, x, y, depth) {
  var p = idx(x, y);
  if (!inb(x, y) || b[p] !== EMPTY) return null;
  if (nearBlack(b, x, y) < 4) return null;
  b[p] = BLACK;
  var r = judge(b, x, y, depth === undefined ? DEPTH : depth);
  b[p] = EMPTY;
  return r;
}

/* 판 전체의 흑 금수 자리. 225칸 배열, 각 칸은 사유 문자열 또는 null */
function forbiddenMap(b) {
  var m = new Array(SIZE), x, y;
  for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
    m[idx(x, y)] = b[idx(x, y)] === EMPTY ? forbidAt(b, x, y, DEPTH) : null;
  }
  return m;
}

var REASON = { three: '삼삼', four: '사사', overline: '여섯 목(장목)' };
function reasonText(r) { return REASON[r] || ''; }

var API = {
  N: N, SIZE: SIZE, EMPTY: EMPTY, BLACK: BLACK, WHITE: WHITE,
  idx: idx, inb: inb, emptyBoard: emptyBoard, run: run,
  winLine: winLine, forbid: forbidAt, forbiddenMap: forbiddenMap, reasonText: reasonText
};

root.RENJU = API;
if (typeof module === 'object' && module.exports) module.exports = API;   // node 테스트용
})(typeof window !== 'undefined' ? window : this);
