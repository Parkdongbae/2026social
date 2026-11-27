// 방문할 때 자동 반영: 누가 탐험관을 열면 제출 폴더에 새 파일이 있는지 보고, 있으면 동기화를 시작한다.
// (GitHub 의 '10분마다' 예약 실행은 늦거나 건너뛰는 일이 많아서 보완용)
//  GET /api/refresh → { started } | { upToDate } | { recent }
// 누구나 부를 수 있지만: 새 파일이 있을 때만, 그리고 최근 3분 안에 실행된 적이 없을 때만 동기화를 시작한다.
const REPO = "Parkdongbae/2026social";
const WORKFLOW = "sync.yml";
const FOLDER_ID = "1b38gwB84pEzF9g1RyOgMTIJpSk4jcl851-CPel9MncsDDCITJ9APUr5znM_hTHpxA5eV_m0Y";
const COOLDOWN_MS = 3 * 60 * 1000;

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

async function folderHtmlIds() {
  const res = await fetch(`https://drive.google.com/embeddedfolderview?id=${FOLDER_ID}`, { headers: { "Accept-Language": "ko" } });
  if (!res.ok) throw new Error(`drive ${res.status}`);
  const html = await res.text();
  if (!/id="flip-contents"/.test(html)) throw new Error("drive page");
  const ids = [];
  const re = /id="entry-([\w-]+)"[\s\S]*?class="flip-entry-title">([^<]*)</g;
  let m;
  while ((m = re.exec(html))) if (/\.html\s*$/i.test(m[2])) ids.push(m[1]);
  return ids;
}

async function knownIds(host) {
  const known = new Set();
  const add = (g) => { if (g?.driveId) known.add(g.driveId); (g?.replaced || []).forEach((d) => known.add(d)); };
  const site = await fetch(`https://${host}/games.json?t=${Date.now()}`, { cache: "no-store" });
  if (site.ok) {
    const d = await site.json();
    [...(d.games || []), ...(d.hidden || []), ...(d.rejected || [])].forEach(add);
  }
  // 건너뛴 파일(중복·옛 버전·숨김 등)은 저장소의 sync-report.json 에만 있다
  const rep = await fetch(`https://raw.githubusercontent.com/${REPO}/main/sync-report.json?t=${Date.now()}`, { cache: "no-store" });
  if (rep.ok) (await rep.json()).skipped?.forEach(add);
  return known;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.GITHUB_TOKEN) return res.status(200).json({ disabled: true });
  try {
    const runs = await github(`/actions/workflows/${WORKFLOW}/runs?per_page=1`);
    if (!runs.ok) return res.status(200).json({ error: `GitHub 토큰 확인 실패 (${runs.status})` });
    const last = runs.ok ? (await runs.json()).workflow_runs?.[0] : null;
    if (last && (last.status !== "completed" || Date.now() - Date.parse(last.created_at) < COOLDOWN_MS)) {
      return res.status(200).json({ recent: true, running: last.status !== "completed" });
    }
    const [ids, known] = await Promise.all([folderHtmlIds(), knownIds(req.headers.host)]);
    const fresh = ids.filter((id) => !known.has(id));
    if (!fresh.length) return res.status(200).json({ upToDate: true, tokenOk: true });
    const r = await github(`/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main" }),
    });
    return res.status(200).json({ started: r.status === 204, newFiles: fresh.length });
  } catch (e) {
    return res.status(200).json({ error: String(e.message || e) });
  }
}
