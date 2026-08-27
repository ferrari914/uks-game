/* =========================================================
   Englknight — 게임 목록 데이터
   ---------------------------------------------------------
   게임을 추가하려면 아래 배열에 항목 하나만 추가하면 됩니다.
   허브 메인 페이지에 자동으로 카드가 생깁니다.

   id       : 고유 식별자 (영문/숫자/하이픈)
   title    : 카드에 표시될 게임 이름
   desc     : 한 줄 설명
   path     : 게임 실행 경로 (games/<폴더>/index.html)
   emoji    : 썸네일 대신 쓰는 이모지 (이미지 준비 전 임시)
   color    : 썸네일 그라데이션 색 (hex 2개)
   tags     : 검색/분류용 태그
   status   : "ready"(플레이 가능) | "wip"(준비중)
   added    : 등록일 (YYYY-MM-DD)
   ========================================================= */

window.GAMES = [
  {
    id: "tetris",
    title: "테트리스",
    desc: "블록을 쌓아 줄을 지우는 클래식 퍼즐 게임.",
    path: "games/tetris/index.html",
    emoji: "🟦",
    color: ["#3b82f6", "#8b5cf6"],
    tags: ["퍼즐", "클래식", "싱글"],
    status: "ready",
    added: "2026-08-27"
  },
  {
    id: "ox-survival",
    title: "OX 서바이벌",
    desc: "친구들과 실시간 멀티플레이! 틀린 쪽 발판은 무너진다. 마지막 한 명이 우승.",
    path: "games/ox-survival/index.html",
    emoji: "🕳️",
    color: ["#2bd9c4", "#ff4d6d"],
    tags: ["퀴즈", "멀티", "서바이벌"],
    status: "ready",
    added: "2026-08-27"
  },
  {
    id: "mafia",
    title: "마피아",
    desc: "친구들과 방을 만들어 함께 하는 실시간 마피아. 혼자서도 즐길 수 있습니다.",
    path: "games/mafia/index.html",
    emoji: "🔪",
    color: ["#e02947", "#4c1d95"],
    tags: ["추리", "멀티", "싱글", "심리"],
    status: "ready",
    added: "2026-08-27"
  },
  {
    id: "catchmind",
    title: "캐치마인드",
    desc: "제시어를 그림으로! 친구들과 실시간으로 그리고 맞히는 그림 퀴즈.",
    path: "games/catchmind/index.html",
    emoji: "🎨",
    color: ["#f59e0b", "#ec4899"],
    tags: ["그림", "퀴즈", "멀티"],
    status: "ready",
    added: "2026-08-28"
  },
  {
    id: "liar",
    title: "라이어 게임",
    desc: "한 기기를 돌려가며 즐기는 3~10인 파티 추리 게임. 라이어를 찾아내라.",
    path: "games/liar/index.html",
    emoji: "🎭",
    color: ["#a97bff", "#3b1d6e"],
    tags: ["파티", "추리", "심리"],
    status: "ready",
    added: "2026-08-28"
  }
];

/* 옷입히기(dressup)는 RPG 컨셉 전환에 따라 게임이 아니라
   캐릭터 프로필/꾸미기 화면(profile/index.html)으로 재분류되어
   이 목록에서 제외했습니다. games/dressup/ 폴더는 그대로 남아 있습니다. */
