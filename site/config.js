// 사회과 웹앱 탐험관 접속 설정. Firebase 는 게임 갤러리·웹앱 스토어와 같은 프로젝트를 쓰고,
// 추천은 socialLikes, 업그레이드 요청은 socialRequests, 관리자 수정값은 socialAdmin 에 따로 저장합니다.
// 관리자 명단은 코드에 두지 않고 Firestore 의 비공개 문서 socialConfig/admins 에 둡니다 (운영가이드 참고).
// Firebase 웹 설정값은 공개되어도 되는 값입니다(접근 통제는 firestore.rules 가 합니다).
window.APP_CONFIG = {
  allowedDomain: "dongshin.ms.kr",
  playBase: "https://dongshin-social-2026-play.vercel.app/",
  firebase: {
    apiKey: "AIzaSyAQ_JXpQgeM54aj--KQ1lIQZJSY2S1FKfg",
    authDomain: "dongshin-game-2026.firebaseapp.com",
    projectId: "dongshin-game-2026",
    appId: "1:355943894723:web:008e36cfa8b6a45ba65c76"
  }
};
