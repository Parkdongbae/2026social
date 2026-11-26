// F9 관리자 창의 "바로 반영" 서버 기능 (Vercel 함수)
//  GET  /api/admin             → 최근 동기화 실행 상태
//  POST /api/admin {op:"sync"} → GitHub Actions 동기화를 지금 실행
//
// 관리자 확인: 이 함수에는 관리자 명단이 없다. 로그인 토큰을 그대로 Firestore 에 넘겨
// socialAdminCheck 문서를 읽어 보고, 보안 규칙(명단: Firestore socialConfig/admins)이 허락하면 관리자로 본다.
// 필요한 환경 변수: GITHUB_TOKEN (2026social 저장소의 Actions 읽기·쓰기 권한만 있는 토큰)

const PROJECT = "dongshin-game-2026";
const REPO = "Parkdongbae/2026social";
const WORKFLOW = "sync.yml";
const CHECK_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/socialAdminCheck/ping`;

async function isAdmin(req) {
  const m = /^Bearer ([\w.-]+)$/.exec(req.headers.authorization || "");
  if (!m) return false;
  const r = await fetch(CHECK_URL, { headers: { Authorization: `Bearer ${m[1]}` } });
  return r.status === 200 || r.status === 404; // 404 = 읽기는 허락됐지만 문서가 없음 → 관리자
}

function github(path, init = {}) {
  return fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!(await isAdmin(req))) return res.status(403).json({ error: "관리자 계정으로 로그인해야 해요" });
  if (!process.env.GITHUB_TOKEN) return res.status(503).json({ error: "서버에 GITHUB_TOKEN 이 설정되지 않았어요 (운영가이드 참고)" });

  if (req.method === "GET") {
    const r = await github(`/actions/workflows/${WORKFLOW}/runs?per_page=5`);
    if (!r.ok) return res.status(502).json({ error: `GitHub 응답 ${r.status}` });
    const data = await r.json();
    const runs = (data.workflow_runs || []).map((w) => ({
      status: w.status, conclusion: w.conclusion, event: w.event, createdAt: w.created_at, url: w.html_url,
    }));
    return res.status(200).json({ runs });
  }

  if (req.method === "POST") {
    let body = req.body || {};
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    if (body.op !== "sync") return res.status(400).json({ error: "알 수 없는 요청" });
    const r = await github(`/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main" }),
    });
    if (r.status !== 204) return res.status(502).json({ error: `GitHub 응답 ${r.status}` });
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "허용되지 않는 방식" });
}
