// 구글 드라이브 공개 폴더 → play/{id}.html + site/games.json  (웹앱 스토어용: 설명·분류 추가)
// 규칙: docs/01_핵심로직_규칙명세서.md, docs/tasks/동기화_구현.md
// 사용: node scripts/sync.mjs   (외부 패키지 없음, Node 20+)

import { readFile, writeFile, readdir, unlink, mkdir, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAY_DIR = path.join(ROOT, "play");
const INBOX_DIR = path.join(ROOT, "inbox");
const GAMES_JSON = path.join(ROOT, "site", "games.json");
const REPORT_JSON = path.join(ROOT, "sync-report.json"); // 건너뛴 파일 목록 (사이트에는 올리지 않음)

const NAME_RE = /(\d{4})\s*([가-힣][가-힣\s]*[가-힣])\s*\.html$/i;
const ID_RE = /^\d{4}(-\d+)?$/;
const AI_CHAT_HOSTS = ["gemini.google.com", "chatgpt.com", "chat.openai.com", "claude.ai"];
const REASON_AI = "AI 대화 화면 저장본 (웹앱 파일 아님)";
const REASON_DUP = "같은 파일을 두 번 올림 (한 번만 게시)";
const REASON_OLD = "새 버전으로 교체됨 (옛 파일)";
const FIXES = {
  [REASON_AI]: "AI와 대화한 화면을 저장한 파일이에요. AI가 만들어 준 웹앱 코드를 HTML 파일로 내려받아(또는 복사해서 .html로 저장해) 다시 올려 주세요.",
  "파일명에서 학번·이름을 찾지 못함": "파일 이름 끝을 '학번이름.html'로 바꿔 주세요. 예) 내앱 - 3115홍길동.html",
  "HTML 파일이 아님": "웹앱이 들어 있는 .html 파일로 다시 올려 주세요.",
  "내려받기 실패": "잠시 뒤 자동으로 다시 시도해요. 계속 보이면 선생님께 알려 주세요.",
};
const HEADERS = { "Accept-Language": "ko", "User-Agent": "Mozilla/5.0" };

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw new Error(`${path.relative(ROOT, file)} 을(를) 읽을 수 없습니다: ${e.message}`);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// 목록의 "수정 시각" 글자를 분 단위 숫자로. 오늘 수정한 파일만 시각(16:04, 4:04 pm, 오후 4:04)으로 나오고
// 그 전 파일은 날짜로 나오므로, 읽지 못하면 -1(더 오래된 것으로 취급).
function parseClock(text) {
  const m = /(\d{1,2}):(\d{2})/.exec(text ?? "");
  if (!m) return -1;
  let h = Number(m[1]);
  if (/pm|오후/i.test(text) && h < 12) h += 12;
  if (/am|오전/i.test(text) && h === 12) h = 0;
  return h * 60 + Number(m[2]);
}

// 두 게임 파일이 "같은 게임의 다른 버전"인지 판단하기 위한 줄 단위 유사도 (0~1)
const lineCache = new WeakMap();
function linesOf(buf) {
  if (!lineCache.has(buf)) {
    lineCache.set(buf, new Set(buf.toString("utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 12)));
  }
  return lineCache.get(buf);
}
function similarity(bufA, bufB) {
  const a = linesOf(bufA), b = linesOf(bufB);
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}
const normTitle = (t) => String(t).replace(/\s+/g, "").toLowerCase();
// 서로 다른 게임끼리는 실측 최대 0.13. 제목까지 같으면 0.15, 제목이 달라도 0.4 이상이면 같은 게임의 수정본으로 본다.
function sameGameScore(a, b) {
  if (!a.buf || !b.buf) return 0;
  const s = similarity(a.buf, b.buf);
  if (s >= 0.4) return s;
  if (s >= 0.15 && normTitle(a.title) === normTitle(b.title)) return s;
  return 0;
}
const copyNo = (name) => Number(/\((\d+)\)/.exec(name)?.[1] ?? 0);

// ---------- 웹앱 설명·분류 ----------
const clean = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const cut = (s, n) => ([...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s);

// 한 줄 설명: <meta name="description"> → 제목과 다른 첫 <h1>/<h2>/<p> 문장 (없으면 빈 문자열)
function describe(text, title) {
  const meta = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i.exec(text)?.[1]
    ?? /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["']/i.exec(text)?.[1];
  if (meta && clean(meta)) return cut(clean(meta), 70);
  const body = text.replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/gi, " ");
  for (const m of body.matchAll(/<(h1|h2|h3|p)[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const s = clean(m[2]);
    if ([...s].length < 10) continue;
    if (/^[\d\s:./-]+$/.test(s)) continue;
    if (/(세요|주세요|하세요|해요\?)[!.?\s]*$/.test(s)) continue; // "선택하세요!" 같은 안내 문구는 설명이 아님
    if (similarTo(s, title)) continue;
    return cut(s, 70);
  }
  return "";
}
// 제목을 거의 그대로 반복하는 문장인지 (글자 2개 묶음 겹침 60% 이상, 또는 한쪽이 다른 쪽을 포함)
function similarTo(a, b) {
  const n = (s) => s.toLowerCase().replace(/[^가-힣a-z0-9]/g, "");
  const x = n(a), y = n(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const grams = (s) => new Set([...s].slice(0, -1).map((c, i) => c + s[i + 1]));
  const gx = grams(x), gy = grams(y);
  let hit = 0;
  for (const g of gx) if (gy.has(g)) hit++;
  return hit / Math.min(gx.size, gy.size) >= 0.6;
}

// 분류: 제목(3점)·설명(2점)·본문 글자(1점)에 나오는 낱말 점수가 가장 높은 쪽. 0점이면 etc
export const CATEGORIES = {
  geo: /지리|지도|map|기후|지형|위도|경도|대륙|수도|국기|나라|세계 ?여행|인구 ?분포|도시|지역|화산|지진|하천|산맥|사막|열대|위성|gps|좌표|자원|에너지|환경|날씨|기온|강수/i,
  history: /역사|history|조선|고려|신라|백제|고구려|가야|삼국|왕조|임금|임진왜란|병자호란|독립|일제|광복|근현대|문화재|유물|유적|연표|시대|전쟁|세종|이순신|한국사|세계사|고대|중세|선사|구석기|신석기|청동기/i,
  politics: /정치|선거|투표|헌법|법률|법|법원|재판|국회|대통령|민주|인권|권리|의무|정부|지방 ?자치|시민|정당|국민|입법|사법|행정|판결|배심/i,
  economy: /경제|economy|화폐|시장|수요|공급|가격|무역|금융|은행|저축|투자|주식|세금|소비|기업|용돈|환율|물가|인플레이션|gdp|생산|분배|희소성|가계부|창업/i,
  society: /사회 ?문화|문화|다문화|가족|청소년|미디어|뉴스|저출산|고령화|불평등|차별|규범|사회화|공동체|종교|윤리|성 ?역할|세대|일상|관습|전통|축제|언어/i,
};
function classify(title, desc, text) {
  const body = clean(text.replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/gi, " ")).slice(0, 4000);
  const score = (re, s, w) => (s.match(new RegExp(re.source, "gi"))?.length ?? 0) * w;
  // 제목에 분류 낱말이 있으면 제목이 우선(제목 점수를 크게), 없으면 설명·본문으로 판단
  let best = "etc", bestScore = 0;
  for (const [key, re] of Object.entries(CATEGORIES)) {
    const sc = score(re, title, 100) + score(re, desc, 2) + Math.min(score(re, body, 1), 6);
    if (sc > bestScore) { best = key; bestScore = sc; }
  }
  return best;
}
const CATEGORY_KEYS = [...Object.keys(CATEGORIES), "etc"];

// ---------- 관리자 수정값 (F9 관리자 창 → Firestore socialAdmin/overrides) ----------
// 형식: { "3105": { hide, title, name, studentNo, category, desc }, "drive:<드라이브ID>": { studentNo, name, ignore, ... } }
const FIRESTORE_DOC = "https://firestore.googleapis.com/v1/projects/dongshin-game-2026/databases/(default)/documents/socialAdmin/overrides";
async function loadOverrides() {
  if (process.env.OVERRIDES_JSON) return JSON.parse(process.env.OVERRIDES_JSON); // 로컬 시험용
  const res = await fetch(FIRESTORE_DOC);
  if (res.status === 404) return {}; // 아직 관리자가 아무것도 고치지 않음
  if (!res.ok) throw new Error(`관리자 수정값을 읽지 못함 (${res.status}) — 숨긴 앱이 다시 나타나지 않도록 중단합니다`);
  const doc = await res.json();
  const text = doc.fields?.json?.stringValue;
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new Error("관리자 수정값 형식이 잘못됨"); }
}

// ---------- 1단계: 목록 ----------
async function listFolder(folderId) {
  const res = await fetch(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`폴더 목록 응답 ${res.status}`);
  const html = await res.text();
  const entries = [];
  const re = /id="entry-([\w-]+)"[\s\S]*?class="flip-entry-title">([^<]*)<(?:(?!id="entry-)[\s\S])*?flip-entry-last-modified"><div>([^<]*)</g;
  let m;
  while ((m = re.exec(html))) entries.push({ driveId: m[1], sourceName: decodeEntities(m[2]).trim(), mtime: parseClock(m[3]) });
  // 항목이 0개일 때: 폴더 화면이 정상(빈 폴더)인지, 화면을 못 읽은 것인지 구분
  if (entries.length === 0 && !/id="flip-contents"/.test(html)) {
    throw new Error("폴더 화면을 읽지 못함 (공유 설정 또는 화면 구조 변경 가능성)");
  }
  return entries.filter((e) => /\.html$/i.test(e.sourceName));
}

// ---------- 2단계: 내려받기 ----------
async function download(driveId) {
  let res = await fetch(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveId)}`, { headers: HEADERS });
  let buf = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  const head = buf ? buf.subarray(0, 4000).toString("utf8") : "";
  if (!buf || head.includes("Google Drive - Virus scan warning")) {
    const uuid = /name="uuid" value="([^"]+)"/.exec(buf ? buf.toString("utf8") : "")?.[1] ?? "";
    res = await fetch(
      `https://drive.usercontent.google.com/download?id=${encodeURIComponent(driveId)}&export=download&confirm=t&uuid=${encodeURIComponent(uuid)}`,
      { headers: HEADERS }
    );
    if (!res.ok) throw new Error(`내려받기 응답 ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 4000).toString("utf8").includes("Google Drive - Virus scan warning")) throw new Error("바이러스 검사 안내를 통과하지 못함");
  }
  return buf;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

// ---------- 3단계: 해석 ----------
function analyze(sourceName, buf, forced) {
  // 관리자가 학번·이름을 직접 정해 준 파일은 파일명 규칙·AI 저장본 검사를 건너뛴다
  const m = NAME_RE.exec(sourceName);
  const fStudent = forced && /^\d{4}$/.test(String(forced.studentNo ?? "")) && String(forced.name ?? "").trim();
  if (!m && !fStudent) return { skip: "파일명에서 학번·이름을 찾지 못함" };
  const studentNo = fStudent ? String(forced.studentNo) : m[1];
  const name = fStudent ? String(forced.name).replace(/\s+/g, "") : m[2].replace(/\s+/g, "");

  const text = buf.toString("utf8");
  const head = text.slice(0, 2000);
  const lower = text.toLowerCase();
  const rawTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? "";
  let title = decodeEntities(rawTitle).replace(/\s+/g, " ").trim();

  if (buf.length === 0 || !["<html", "<!doctype", "<script", "<canvas", "<body"].some((t) => lower.includes(t))) {
    return { skip: "HTML 파일이 아님", studentNo, name };
  }
  if (!fStudent && head.includes("saved from url=") && AI_CHAT_HOSTS.some((h) => head.includes(h))) return { skip: REASON_AI, studentNo, name };
  if (!fStudent && title.endsWith(" - Google Gemini")) return { skip: REASON_AI, studentNo, name };

  if (!title) {
    title = sourceName
      .replace(/\.html$/i, "")
      .replace(/\d{4}\s*[가-힣][가-힣\s]*[가-힣]\s*$/, "")
      .replace(/code_artifact|index/gi, "")
      .replace(/\(\d+\)/g, "")
      .replace(/^[\s\-_]+|[\s\-_]+$/g, "")
      .replace(/\s+/g, " ");
  }
  if (!title) title = `${name}의 웹앱`;
  if ([...title].length > 60) title = [...title].slice(0, 59).join("") + "…";

  const desc = describe(text, title);
  return {
    studentNo,
    name,
    title,
    desc,
    category: classify(title, desc, text),
    hash: createHash("sha256").update(buf).digest("hex").slice(0, 16),
    size: buf.length,
  };
}

// ---------- 본문 ----------
async function main() {
  const config = await readJson(path.join(ROOT, "sync.config.json"), { folderIds: [] });
  const overrides = await loadOverrides();
  const prevData = await readJson(GAMES_JSON, { games: [] });
  const prevReport = await readJson(REPORT_JSON, { skipped: [] });
  const prev = [...(Array.isArray(prevData.games) ? prevData.games : []), ...(Array.isArray(prevData.hidden) ? prevData.hidden : [])];
  const prevByDrive = new Map(prev.map((g) => [g.driveId, g]));
  const now = new Date().toISOString();

  // 1. 목록 (실패하면 아무것도 건드리지 않고 종료)
  let sources = [];
  try {
    for (const folderId of config.folderIds ?? []) sources.push(...(await listFolder(folderId)));
    // 전에는 드라이브에 파일이 있었는데 갑자기 0개가 되면 일시 오류로 보고 아무것도 지우지 않는다
    if (sources.length === 0 && prev.some((g) => !String(g.driveId).startsWith("local:"))) {
      throw new Error("폴더가 갑자기 비었음 (일시 오류일 수 있어 그대로 둠). 정말 모두 지운 것이면 site/games.json 을 지우고 다시 실행");
    }
  } catch (e) {
    console.error(`목록을 읽지 못했습니다: ${e.message}`);
    console.error("아무것도 바꾸지 않고 종료합니다.");
    process.exit(1);
  }
  const seen = new Set();
  sources = sources.filter((s) => !seen.has(s.driveId) && seen.add(s.driveId));

  let inboxNames = [];
  try {
    inboxNames = (await readdir(INBOX_DIR)).filter((n) => /\.html$/i.test(n));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  for (const n of inboxNames) sources.push({ driveId: `local:${n}`, sourceName: n, localPath: path.join(INBOX_DIR, n) });

  // 2~3. 내려받기 + 해석
  const skipped = [];
  const kept = []; // 내려받기 실패했지만 이전 결과를 유지하는 항목
  const cur = [];
  await mapLimit(sources, 4, async (s) => {
    let buf;
    try {
      buf = s.localPath ? await readFile(s.localPath) : await download(s.driveId);
    } catch (e) {
      const old = prevByDrive.get(s.driveId);
      if (old) kept.push(old);
      else skipped.push({ sourceName: s.sourceName, driveId: s.driveId, reason: "내려받기 실패" });
      console.error(`! 내려받기 실패: ${s.sourceName} (${e.message})`);
      return;
    }
    const a = analyze(s.sourceName, buf, overrides[`drive:${s.driveId}`]);
    if (a.skip) skipped.push({ sourceName: s.sourceName, driveId: s.driveId, reason: a.skip, studentNo: a.studentNo, name: a.name });
    else cur.push({ ...s, ...a, buf });
  });
  cur.sort((a, b) => (a.sourceName < b.sourceName ? -1 : a.sourceName > b.sourceName ? 1 : 0));

  // 4. ID 배정
  const presentDriveIds = new Set(sources.map((s) => s.driveId));
  const usedIds = new Set(kept.map((g) => g.id));
  const inherited = new Set();
  const results = [];

  const finish = (c, id, addedAt, old) => {
    usedIds.add(id);
    results.push({
      id,
      studentNo: c.studentNo,
      name: c.name,
      title: c.title,
      desc: c.desc,
      category: c.category,
      file: `${id}.html`,
      driveId: c.driveId,
      sourceName: c.sourceName,
      hash: c.hash,
      size: c.size,
      addedAt,
      updatedAt: old && old.hash === c.hash ? old.updatedAt : now,
      buf: c.buf,
      isNew: !old,
      isChanged: Boolean(old) && old.hash !== c.hash,
      // 이 게임의 옛 버전 파일들(폴더에 아직 남아 있는 것만 기억)
      replaced: (old?.replaced ?? []).filter((d) => d !== c.driveId && presentDriveIds.has(d)),
    });
  };

  const fresh = [];
  for (const c of cur) {
    const old = prevByDrive.get(c.driveId);
    if (old && ID_RE.test(old.id)) finish(c, old.id, old.addedAt, old);
    else fresh.push(c);
  }
  // 이미 새 버전으로 교체된 옛 파일 (그 게임의 현재 파일이 폴더에 있는 동안만 유효)
  const retired = new Set(results.flatMap((r) => r.replaced));
  // 오래된 파일부터 처리해서, 같은 게임이면 나중 파일이 앞 파일을 대체하게 한다
  // (최신 파일이 폴더에서 지워져 옛 버전들이 되살아나는 경우에는, 기억해 둔 교체 순서를 그대로 따른다)
  const pastOrder = new Map();
  for (const g of prev) (g.replaced ?? []).forEach((d, i) => pastOrder.set(d, i));
  const rank = (c) => (pastOrder.has(c.driveId) ? pastOrder.get(c.driveId) : Infinity);
  fresh.sort(
    (a, b) =>
      (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1) ||
      (a.mtime ?? -1) - (b.mtime ?? -1) ||
      copyNo(a.sourceName) - copyNo(b.sourceName) ||
      (a.sourceName < b.sourceName ? -1 : 1)
  );
  for (const c of fresh) {
    if (retired.has(c.driveId)) {
      skipped.push({ sourceName: c.sourceName, driveId: c.driveId, reason: REASON_OLD, studentNo: c.studentNo, name: c.name });
      continue;
    }
    // 같은 학생의 같은 게임을 고쳐서 또 올린 경우: 새 파일만 보이고, ID(=좋아요)는 그대로 이어받는다
    if (!results.some((r) => r.studentNo === c.studentNo && r.hash === c.hash)) {
      const match = results
        .filter((r) => r.studentNo === c.studentNo)
        .map((r) => ({ r, score: sameGameScore(r, c) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)[0]?.r;
      if (match) {
        skipped.push({ sourceName: match.sourceName, driveId: match.driveId, reason: REASON_OLD, studentNo: match.studentNo, name: match.name });
        match.replaced = [...match.replaced.filter((d) => d !== c.driveId), match.driveId];
        retired.add(match.driveId);
        Object.assign(match, { driveId: c.driveId, sourceName: c.sourceName, title: c.title, desc: c.desc, category: c.category, hash: c.hash, size: c.size, buf: c.buf, updatedAt: now, isChanged: !match.isNew });
        continue;
      }
    }
    // 같은 학생이 똑같은 파일을 두 번 올린 경우: 한 번만 게시 (서로 다른 게임은 몇 개든 허용)
    if (results.some((r) => r.studentNo === c.studentNo && r.hash === c.hash)) {
      skipped.push({ sourceName: c.sourceName, driveId: c.driveId, reason: REASON_DUP, studentNo: c.studentNo, name: c.name });
      continue;
    }
    const candidates = prev
      .filter((g) => g.studentNo === c.studentNo && !presentDriveIds.has(g.driveId) && !inherited.has(g.id) && !usedIds.has(g.id) && ID_RE.test(g.id))
      .sort((a, b) => a.id.length - b.id.length || (a.id < b.id ? -1 : 1));
    if (candidates.length) {
      const old = candidates[0];
      inherited.add(old.id);
      finish(c, old.id, old.addedAt, old); // 다시 제출: 좋아요 유지
      continue;
    }
    let id = c.studentNo;
    for (let n = 2; usedIds.has(id); n++) id = `${c.studentNo}-${n}`;
    finish(c, id, now, null);
  }

  // 관리자 수정값 적용: 제목·이름·학번·분류·설명 바꾸기, 숨기기(=삭제)
  const games = [];
  const hidden = [];
  const applyOverride = (g) => {
    const o = overrides[g.id];
    if (!o) return g;
    if (typeof o.title === "string" && o.title.trim()) g.title = o.title.trim().slice(0, 60);
    if (typeof o.desc === "string") g.desc = o.desc.trim().slice(0, 80);
    if (typeof o.name === "string" && o.name.trim()) g.name = o.name.replace(/\s+/g, "").slice(0, 10);
    if (/^\d{4}$/.test(String(o.studentNo ?? ""))) g.studentNo = String(o.studentNo);
    if (CATEGORY_KEYS.includes(o.category)) g.category = o.category;
    return g;
  };
  for (const g of [...results, ...kept.map((k) => ({ ...k, buf: null }))]) {
    applyOverride(g);
    if (overrides[g.id]?.hide === true) {
      skipped.push({ sourceName: g.sourceName, driveId: g.driveId, reason: "교사가 숨김" });
      hidden.push(g);
    } else games.push(g);
  }
  hidden.sort((a, b) => a.studentNo.localeCompare(b.studentNo) || a.id.localeCompare(b.id));

  games.sort((a, b) => a.studentNo.localeCompare(b.studentNo) || a.id.localeCompare(b.id));
  skipped.sort((a, b) => a.sourceName.localeCompare(b.sourceName));

  // 5. 쓰기
  await mkdir(PLAY_DIR, { recursive: true });
  await mkdir(path.dirname(GAMES_JSON), { recursive: true });
  const keepFiles = new Set(["index.html"]);
  for (const g of games) {
    if (!ID_RE.test(g.id)) throw new Error(`잘못된 웹앱 ID: ${g.id}`);
    keepFiles.add(g.file);
    if (!g.buf) continue;
    const target = path.join(PLAY_DIR, g.file);
    let same = false;
    try {
      same = (await readFile(target)).equals(g.buf);
    } catch {}
    if (!same) await writeFile(target, g.buf);
  }
  const removed = [];
  for (const f of await readdir(PLAY_DIR)) {
    if (/\.html$/i.test(f) && !keepFiles.has(f)) {
      await unlink(path.join(PLAY_DIR, f));
      removed.push(f);
    }
  }

  const strip = ({ buf, isNew, isChanged, replaced, ...g }) => (replaced?.length ? { ...g, replaced } : g);
  const clean = games.map(strip);
  const cleanHidden = hidden.map(({ file, ...g }) => strip(g)); // 숨긴 앱: 관리자 창에서 되살리기용 (파일은 내림)
  // 갤러리에 보여 줄 "다시 제출이 필요해요" 목록 (교사가 숨긴 앱, 관리자가 '무시'한 파일은 제외)
  const rejected = skipped
    .filter((s) => ![ "교사가 숨김", REASON_DUP, REASON_OLD ].includes(s.reason))
    .filter((s) => overrides[`drive:${s.driveId}`]?.ignore !== true)
    .map((s) => ({
      who: s.studentNo ? `${s.studentNo} ${s.name}` : s.sourceName,
      reason: s.reason,
      fix: FIXES[s.reason] ?? "선생님께 문의해 주세요.",
      driveId: s.driveId,
      sourceName: s.sourceName,
    }));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b ?? []);
  const firstRun = !prevData.updatedAt; // 목록 파일이 아직 없음 → 비어 있어도 한 번은 만든다
  if (firstRun || !same(clean, prevData.games) || !same(cleanHidden, prevData.hidden) || !same(rejected, prevData.rejected)) {
    await writeFile(GAMES_JSON, JSON.stringify({ updatedAt: now, games: clean, hidden: cleanHidden, rejected }, null, 2) + "\n");
  }
  if (JSON.stringify(skipped) !== JSON.stringify(prevReport.skipped ?? [])) {
    await writeFile(REPORT_JSON, JSON.stringify({ updatedAt: now, skipped }, null, 2) + "\n");
  }

  // 6. 보고
  const added = games.filter((g) => g.isNew);
  const changed = games.filter((g) => g.isChanged);
  const lines = [`웹앱 ${games.length}개 (새로 추가 ${added.length}, 내용 변경 ${changed.length}, 삭제 ${removed.length})`];
  for (const g of added) lines.push(`+ ${g.id} ${g.name} — ${g.title}`);
  for (const g of changed) lines.push(`~ ${g.id} ${g.name} — ${g.title}`);
  for (const f of removed) lines.push(`- ${f}`);
  if (skipped.length) {
    lines.push(`건너뜀 ${skipped.length}개`);
    for (const s of skipped) lines.push(`! ${s.sourceName} — ${s.reason}`);
  }
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, "```\n" + lines.join("\n") + "\n```\n");
  }
}

main().catch((e) => {
  console.error(`동기화 실패: ${e.message}`);
  process.exit(1);
});
