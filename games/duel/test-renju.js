/* test-renju.js — 규칙 엔진 검증 (개발용, 게임 실행에는 쓰이지 않는다)
 *
 * 이 프로젝트 환경에는 node가 없다. macOS 내장 JavaScriptCore로 돌린다:
 *   cat renju.js test-renju.js > /tmp/r.js && osascript -l JavaScript /tmp/r.js
 * node가 있으면:  node -e "require('./renju.js');require('./test-renju.js')"
 */
var R = (typeof module === 'object' && typeof require === 'function') ? require('./renju.js')
      : (typeof RENJU !== 'undefined' ? RENJU : this.RENJU);

var B = R.BLACK, W = R.WHITE, out = [], pass = 0, fail = 0;

function board(stones) {                 // stones: [[x,y,color], ...]
  var b = R.emptyBoard();
  for (var i = 0; i < stones.length; i++) b[R.idx(stones[i][0], stones[i][1])] = stones[i][2];
  return b;
}
function ok(name, got, want) {
  var g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; out.push('  PASS  ' + name); }
  else { fail++; out.push('  FAIL  ' + name + '\n          기대=' + w + '  실제=' + g); }
}
/* (x,y)에 c를 두고 승리 라인이 생기는지 */
function playWin(stones, x, y, c) {
  var b = board(stones); b[R.idx(x, y)] = c;
  var L = R.winLine(b, x, y, c);
  return L ? L.length : 0;
}
/* 빈 칸 (x,y)의 흑 금수 사유 */
function forb(stones, x, y) { return R.forbid(board(stones), x, y) || 'none'; }

/* row/col 헬퍼 */
function row(y, xs, c) { var a = []; for (var i = 0; i < xs.length; i++) a.push([xs[i], y, c]); return a; }
function col(x, ys, c) { var a = []; for (var i = 0; i < ys.length; i++) a.push([x, ys[i], c]); return a; }
function cat() { var a = []; for (var i = 0; i < arguments.length; i++) a = a.concat(arguments[i]); return a; }

out.push('── A. 승부 판정 ──────────────────────────────');

// 1. 맨 윗줄 가로 5목 (판 가장자리)
ok('1  맨 윗줄(y=0) 가로 5목', playWin(row(0, [0, 1, 2, 3], B), 4, 0, B), 5);
// 2. 맨 왼쪽 열 세로 5목, 판 아래 끝에 걸침
ok('2  좌측 끝열(x=0) 세로 5목 (판 하단)', playWin(col(0, [10, 11, 12, 13], B), 0, 14, B), 5);
// 3. 모서리에서 시작하는 대각 5목
ok('3  모서리 대각 (0,0)→(4,4)', playWin([[0, 0, B], [1, 1, B], [2, 2, B], [3, 3, B]], 4, 4, B), 5);
// 4. 반대 방향 대각 (14,0)→(10,4)
ok('4  반대 대각 (14,0)→(10,4)', playWin([[14, 0, B], [13, 1, B], [12, 2, B], [11, 3, B]], 10, 4, B), 5);
// 5. 행 경계를 넘어 세면 안 된다 — 1차원 배열 오목의 최다 버그
//    y=0의 x=11..14 와 y=1의 x=0 은 인덱스 11,12,13,14,15 로 "연속"이다
ok('5  행 경계 넘김을 5목으로 오판하지 않음',
   playWin(cat(row(0, [11, 12, 13], B), [[0, 1, B]]), 14, 0, B), 0);
// 6. 흑 6목은 승리가 아니다
ok('6  흑 6목은 승리 아님', playWin(row(7, [3, 4, 5, 7, 8], B), 6, 7, B), 0);
// 7. 백 6목은 승리다
ok('7  백 6목은 승리', playWin(row(7, [3, 4, 5, 7, 8], W), 6, 7, W), 6);
// 8. 끊긴 4+1 (●●●●.●) 을 승리로 오판하지 않음
ok('8  끊긴 4+1은 승리 아님', playWin(row(7, [3, 4, 5, 9], B), 6, 7, B), 4 === 4 ? 0 : 0);
// 9. 마지막 한 칸을 채우며 난 5목은 무승부가 아니라 승리
ok('9  빈칸 하나를 채우며 난 5목', playWin(row(7, [3, 4, 6, 7], B), 5, 7, B), 5);

out.push('');
out.push('── B. 흑 금수 판정 ───────────────────────────');

// 10. 열린사 `.●●●●.` 를 사사로 오판하면 안 된다  ← 최우선 확인
ok('10 열린사는 사사가 아니다', forb(row(7, [4, 5, 6], B), 7, 7), 'none');
// 11. 사사 — 가로 사 + 세로 사
ok('11 사사 (가로4 + 세로4)', forb(cat(row(7, [4, 5, 6], B), col(7, [4, 5, 6], B)), 7, 7), 'four');
// 12. 삼삼 — 가로 열린삼 + 세로 열린삼
ok('12 삼삼 (가로 열린삼 + 세로 열린삼)', forb(cat(row(7, [8, 9], B), col(7, [8, 9], B)), 7, 7), 'three');
// 13. 막힌 삼은 삼이 아니다 — 한쪽이 백에 막히면 삼삼이 성립하지 않는다
ok('13 막힌 삼 + 열린 삼 = 금수 아님',
   forb(cat([[4, 7, W]], row(7, [5, 6], B), col(7, [8, 9], B)), 7, 7), 'none');
// 14. 장목 — 6목이 되는 자리는 금수
ok('14 장목(6목) 금수', forb(row(7, [3, 4, 5, 7, 8], B), 6, 7), 'overline');
// 15. 5목 우선 — 삼삼이면서 동시에 5목이면 금수가 아니라 승리
ok('15 5목은 금수보다 우선', forb(cat(row(7, [3, 4, 5, 6], B), col(7, [8, 9], B)), 7, 7), 'none');
ok('15b 그 수는 실제로 승리',
   playWin(cat(row(7, [3, 4, 5, 6], B), col(7, [8, 9], B)), 7, 7, B), 5);
// 16. 대각 삼삼도 잡는가
ok('16 대각 삼삼', forb([[8, 8, B], [9, 9, B], [8, 6, B], [9, 5, B]], 7, 7), 'three');
// 17. 빈 판·외딴 수는 금수가 아니다
ok('17 빈 판의 천원', forb([], 7, 7), 'none');
ok('18 돌 두 개뿐인 자리', forb(row(7, [8, 9], B), 7, 7), 'none');
// 19. 이미 돌이 있는 칸은 금수 대상이 아니다
ok('19 이미 놓인 칸', forb([[7, 7, B]], 7, 7), 'none');
// 20. 한 줄 안의 이중사 — 전수 탐색으로 찾은 실제 배치
//     x: 3 5 6 _ 9  에 흑, 7에 두면
//       · 8에 두면 5,6,7,8,9 = 오  → 사 {5,6,7,9}
//       · 4에 두면 3,4,5,6,7 = 오  → 사 {3,5,6,7}
//     돌 집합이 달라 2로 세어져야 한다 (열린사처럼 뭉뚱그리면 안 된다)
ok('20 한 줄 안의 이중사 (X.XX@.X)', forb(row(7, [3, 5, 6, 9], B), 7, 7), 'four');
ok('20b 한 줄 이중사 다른 배치 (X.X@X.X)', forb(row(7, [3, 5, 7, 9], B), 6, 7), 'four');

out.push('');
out.push('── C. 백은 제한이 없다 ───────────────────────');
// 백에게는 금수가 없다 — 엔진은 흑 전용이고, 화면은 흑 차례에만 호출한다
ok('21 백 삼삼 자리는 백이 둘 수 있다(승리 없음=정상 착수)',
   playWin(cat(row(7, [8, 9], W), col(7, [8, 9], W)), 7, 7, W), 0);

out.push('');
out.push('── D. 금수 맵 ────────────────────────────────');
(function () {
  var b = board(cat(row(7, [8, 9], B), col(7, [8, 9], B)));
  var m = R.forbiddenMap(b), n = 0, where = [];
  for (var i = 0; i < m.length; i++) if (m[i]) { n++; where.push((i % 15) + ',' + ((i / 15) | 0) + ':' + m[i]); }
  ok('22 삼삼 판의 금수 자리 목록', where, ['7,7:three']);
})();
(function () {                                   // 속도: 실전 중반 판에서 전수 계산
  var st = [], i;
  for (i = 0; i < 12; i++) st.push([4 + (i % 7), 4 + ((i / 7) | 0) * 2, i % 2 ? W : B]);
  var b = board(st), t0 = Date.now();
  for (i = 0; i < 5; i++) R.forbiddenMap(b);
  var ms = (Date.now() - t0) / 5;
  out.push('  INFO  forbiddenMap 1회 ' + ms.toFixed(1) + 'ms (돌 12개 판, 5회 평균)');
  ok('23 금수 맵 계산이 100ms 이내', ms < 100, true);
})();

out.push('');
out.push('결과: ' + pass + ' PASS / ' + fail + ' FAIL');
var TEXT = out.join('\n');
if (typeof console === 'object' && console.log) console.log(TEXT);
TEXT;
