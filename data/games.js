/* =========================================================
   UK's Game — 게임 목록 데이터
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
    title: "OX 대명 서바이벌",
    desc: "친구들과 실시간 멀티플레이! 틀린 쪽 발판은 무너진다. 마지막 한 명이 우승.",
    path: "games/ox-survival/index.html",
    emoji: "🕳️",
    color: ["#2bd9c4", "#ff4d6d"],
    tags: ["퀴즈", "멀티", "서바이벌"],
    status: "ready",
    added: "2026-08-27"
  },
  {
    id: "dressup",
    title: "옷입히기 게임",
    desc: "캐릭터에게 옷을 입혀 스타일을 완성하는 게임. (제작 예정)",
    path: "games/dressup/index.html",
    emoji: "👗",
    color: ["#ec4899", "#f59e0b"],
    tags: ["캐주얼", "꾸미기"],
    status: "wip",
    added: "2026-08-27"
  }
];
