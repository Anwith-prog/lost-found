import React, { useState, useEffect, useCallback } from "react";
import { Search, MapPin, Clock, Camera, X, Pin as PinIcon, Sparkles, ChevronLeft, Loader2, Inbox } from "lucide-react";

const CATEGORIES = ["Electronics", "Bags & Backpacks", "Keys", "Clothing", "ID / Cards", "Books & Notes", "Jewelry & Accessories", "Water Bottles", "Other"];

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const rot = (id) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 700;
  return (h / 700) * 6 - 3;
};

const fmtWhen = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 480;
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round((height * maxDim) / width); width = maxDim; }
        else if (height >= width && height > maxDim) { width = Math.round((width * maxDim) / height); height = maxDim; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.62));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Single combined call: builds one compact prompt (new report + candidates) and asks
// the model to return match confidence + a one-line reason for each, all in one shot.
async function runMatchEngine(report, candidates) {
  const content = [];
  content.push({
    type: "text",
    text:
      `You match campus lost-and-found reports. NEW ${report.type.toUpperCase()} REPORT — ` +
      `category: ${report.category}; desc: ${report.description}; location: ${report.location}; when: ${report.dateTime}. ` +
      (report.image ? "Photo attached below. " : "") +
      `Compare it against these ${candidates.length} candidate ${report.type === "lost" ? "found" : "lost"} reports and judge visual/description overlap, location proximity, and time plausibility.`,
  });
  if (report.image) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: report.image.split(",")[1] } });
  candidates.forEach((c) => {
    content.push({ type: "text", text: `CANDIDATE ${c.id}: category: ${c.category}; desc: ${c.description}; location: ${c.location}; when: ${c.dateTime}.` });
    if (c.image) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: c.image.split(",")[1] } });
  });
  content.push({
    type: "text",
    text:
      'Respond with ONLY raw JSON (no markdown fences, no commentary): {"matches":[{"id":"<candidate id>","confidence":<0-100 integer>,"explanation":"<one short sentence, under 18 words>"}]}. ' +
      "Only include candidates scoring 25+. Sort descending by confidence. Max 5 items. If nothing plausible, return an empty matches array.",
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error("match engine request failed");
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("\n").trim();
  const clean = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);
  return Array.isArray(parsed.matches) ? parsed.matches : [];
}

export default function LostAndFound() {
  const [view, setView] = useState("browse"); // browse | submit
  const [reports, setReports] = useState([]);
  const [loadingReports, setLoadingReports] = useState(true);
  const [storageNote, setStorageNote] = useState("");

  const [query, setQuery] = useState("");
  const [filterType, setFilterType] = useState("all");

  const [detail, setDetail] = useState(null); // report object being viewed
  const [matchState, setMatchState] = useState({}); // reportId -> {loading, error, matches:[{report,confidence,explanation}]}

  const [form, setForm] = useState({ type: "lost", description: "", location: "", dateTime: "", category: CATEGORIES[0], contact: "", image: null });
  const [imgBusy, setImgBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [justSubmitted, setJustSubmitted] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("reports-index", true);
        setReports(r && r.value ? JSON.parse(r.value) : []);
      } catch (e) {
        setReports([]);
      } finally {
        setLoadingReports(false);
      }
    })();
  }, []);

  const saveReports = useCallback(async (next) => {
    setReports(next);
    try {
      await window.storage.set("reports-index", JSON.stringify(next), true);
    } catch (e) {
      setStorageNote("Couldn't save to the shared board — your report is visible to you for now, but may not persist.");
    }
  }, []);

  const findMatches = useCallback(
    async (report, poolOverride) => {
      const pool = poolOverride || reports;
      const candidates = pool.filter((r) => r.type !== report.type && r.id !== report.id).slice(-10);
      setMatchState((s) => ({ ...s, [report.id]: { loading: true, error: null, matches: [] } }));
      if (candidates.length === 0) {
        setMatchState((s) => ({ ...s, [report.id]: { loading: false, error: null, matches: [] } }));
        return;
      }
      try {
        const raw = await runMatchEngine(report, candidates);
        const matches = raw
          .map((m) => ({ ...m, report: candidates.find((c) => c.id === m.id) }))
          .filter((m) => m.report);
        setMatchState((s) => ({ ...s, [report.id]: { loading: false, error: null, matches } }));
      } catch (e) {
        setMatchState((s) => ({ ...s, [report.id]: { loading: false, error: "Couldn't reach the match engine. Try again in a moment.", matches: [] } }));
      }
    },
    [reports]
  );

  const handleImage = async (file) => {
    if (!file) return;
    setImgBusy(true);
    try {
      const data = await compressImage(file);
      setForm((f) => ({ ...f, image: data }));
    } catch (e) {}
    setImgBusy(false);
  };

  const submit = async () => {
    if (!form.description.trim() || !form.location.trim() || !form.dateTime) return;
    setSubmitting(true);
    const report = { id: uid(), createdAt: new Date().toISOString(), ...form };
    const next = [...reports, report];
    await saveReports(next);
    setJustSubmitted(report);
    setForm({ type: "lost", description: "", location: "", dateTime: "", category: CATEGORIES[0], contact: "", image: null });
    setSubmitting(false);
    findMatches(report, next);
  };

  const filtered = reports
    .filter((r) => (filterType === "all" ? true : r.type === filterType))
    .filter((r) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return [r.description, r.location, r.category].join(" ").toLowerCase().includes(q);
    })
    .slice()
    .reverse();

  const openDetail = (r) => {
    setDetail(r);
    if (!matchState[r.id]) findMatches(r);
  };

  return (
    <div className="lf-app">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Special+Elite&family=IBM+Plex+Mono:wght@500;600&family=Inter:wght@400;500;600;700&display=swap');
        .lf-app {
          --ink:#211712; --cork1:#7a5738; --cork2:#5e4128; --paper:#ece1c6; --paper-edge:#d5c496;
          --teal:#2f6e62; --rust:#b3432e; --gold:#c99a3e; --paper-shadow: rgba(30,18,8,0.45);
          font-family:'Inter',sans-serif; color:var(--ink); min-height:600px; border-radius:14px; overflow:hidden;
          background-color:var(--cork1);
          background-image:
            radial-gradient(circle at 15% 20%, rgba(0,0,0,0.16) 0, rgba(0,0,0,0.16) 1.4px, transparent 1.6px),
            radial-gradient(circle at 65% 55%, rgba(0,0,0,0.14) 0, rgba(0,0,0,0.14) 1.4px, transparent 1.6px),
            radial-gradient(circle at 35% 80%, rgba(255,255,255,0.06) 0, rgba(255,255,255,0.06) 1.2px, transparent 1.4px),
            linear-gradient(160deg, var(--cork1), var(--cork2));
          background-size: 26px 26px, 34px 34px, 22px 22px, cover;
          position:relative;
        }
        .lf-header{ display:flex; align-items:center; justify-content:space-between; padding:22px 26px 10px; }
        .lf-title{ font-family:'Special Elite',monospace; color:var(--paper); font-size:22px; letter-spacing:0.5px; display:flex; align-items:center; gap:10px; }
        .lf-title .sub{ font-family:'Inter',sans-serif; font-weight:500; font-size:11px; color:var(--gold); letter-spacing:1.5px; text-transform:uppercase; display:block; margin-top:2px; }
        .lf-tabs{ display:flex; gap:8px; }
        .lf-tab{ font-family:'IBM Plex Mono',monospace; font-weight:600; font-size:12px; letter-spacing:0.5px; padding:9px 16px; border-radius:3px; cursor:pointer; border:1.5px dashed rgba(236,225,198,0.4); color:var(--paper); background:rgba(0,0,0,0.15); transition:all .15s; }
        .lf-tab:hover{ background:rgba(0,0,0,0.28); }
        .lf-tab.active{ background:var(--paper); color:var(--ink); border-color:var(--paper); }
        .lf-body{ padding:8px 26px 30px; }

        .lf-search{ display:flex; gap:10px; margin:6px 0 20px; flex-wrap:wrap; align-items:center; }
        .lf-search-box{ flex:1; min-width:200px; display:flex; align-items:center; gap:8px; background:var(--paper); border-radius:4px; padding:9px 12px; box-shadow:0 3px 8px var(--paper-shadow); }
        .lf-search-box input{ border:none; outline:none; background:transparent; font-family:'Inter'; font-size:14px; width:100%; color:var(--ink); }
        .lf-filters{ display:flex; gap:6px; }
        .lf-filter{ font-family:'IBM Plex Mono'; font-size:11px; font-weight:600; padding:8px 12px; border-radius:4px; cursor:pointer; background:rgba(236,225,198,0.15); color:var(--paper); border:1px solid rgba(236,225,198,0.3); }
        .lf-filter.active{ background:var(--gold); color:var(--ink); border-color:var(--gold); }

        .lf-grid{ display:grid; grid-template-columns:repeat(auto-fill, minmax(210px,1fr)); gap:28px 22px; padding-top:6px; }
        .lf-empty{ text-align:center; padding:60px 20px; color:var(--paper); }
        .lf-empty svg{ opacity:0.7; margin-bottom:10px; }
        .lf-empty .msg{ font-family:'Special Elite'; font-size:16px; }

        .ticket{ background:var(--paper); border-radius:2px; box-shadow:0 6px 14px var(--paper-shadow); position:relative; cursor:pointer; padding:14px 12px 12px; transition:transform .15s; }
        .ticket:hover{ transform:translateY(-3px) rotate(0deg) !important; }
        .ticket::after{ content:''; position:absolute; inset:6px; border:1px dashed var(--paper-edge); pointer-events:none; }
        .pin{ position:absolute; top:-9px; left:50%; transform:translateX(-50%); width:14px; height:14px; border-radius:50%; background:radial-gradient(circle at 35% 30%, #e5867a, var(--rust) 70%); box-shadow:0 2px 4px rgba(0,0,0,0.5); z-index:2; }
        .stamp{ position:absolute; top:8px; right:8px; font-family:'IBM Plex Mono'; font-weight:700; font-size:9.5px; letter-spacing:1px; padding:3px 7px; border:1.5px solid; border-radius:3px; transform:rotate(6deg); text-transform:uppercase; }
        .stamp.lost{ color:var(--rust); border-color:var(--rust); }
        .stamp.found{ color:var(--teal); border-color:var(--teal); }
        .ticket .thumb{ width:100%; height:110px; object-fit:cover; border-radius:2px; margin-bottom:10px; background:#cfc09a; }
        .ticket .noimg{ width:100%; height:110px; display:flex; align-items:center; justify-content:center; color:var(--paper-edge); background:#e2d6b3; border-radius:2px; margin-bottom:10px; }
        .ticket h4{ font-family:'Inter'; font-weight:700; font-size:13px; margin:0 0 6px; line-height:1.3; }
        .ticket .meta{ font-family:'IBM Plex Mono'; font-size:10.5px; color:#6b5c3f; display:flex; align-items:center; gap:4px; margin-top:3px; }

        .lf-form{ max-width:560px; margin:0 auto; background:var(--paper); border-radius:4px; padding:26px; box-shadow:0 10px 24px var(--paper-shadow); position:relative; }
        .lf-form::after{ content:''; position:absolute; inset:8px; border:1px dashed var(--paper-edge); pointer-events:none; }
        .lf-form .pin{ top:-10px; }
        .toggle-row{ display:flex; gap:0; margin-bottom:18px; border-radius:4px; overflow:hidden; border:1.5px solid var(--ink); }
        .toggle-btn{ flex:1; text-align:center; padding:10px; font-family:'IBM Plex Mono'; font-weight:700; font-size:12px; letter-spacing:1px; cursor:pointer; background:transparent; text-transform:uppercase; }
        .toggle-btn.lost.on{ background:var(--rust); color:#fff; }
        .toggle-btn.found.on{ background:var(--teal); color:#fff; }
        .field{ margin-bottom:14px; }
        .field label{ display:block; font-family:'IBM Plex Mono'; font-size:10.5px; font-weight:600; letter-spacing:0.8px; text-transform:uppercase; color:#6b5c3f; margin-bottom:5px; }
        .field input, .field textarea, .field select{ width:100%; box-sizing:border-box; font-family:'Inter'; font-size:14px; padding:9px 11px; border:1.5px solid var(--paper-edge); border-radius:3px; background:#f7f0dc; color:var(--ink); outline:none; }
        .field textarea{ resize:vertical; min-height:64px; }
        .field input:focus, .field textarea:focus, .field select:focus{ border-color:var(--ink); }
        .row2{ display:flex; gap:12px; }
        .row2 .field{ flex:1; }
        .upload-box{ border:1.5px dashed var(--paper-edge); border-radius:4px; padding:14px; display:flex; align-items:center; gap:12px; cursor:pointer; background:#f7f0dc; }
        .upload-box img{ width:52px; height:52px; object-fit:cover; border-radius:3px; }
        .submit-btn{ width:100%; margin-top:6px; padding:12px; font-family:'IBM Plex Mono'; font-weight:700; font-size:13px; letter-spacing:1px; text-transform:uppercase; border:none; border-radius:3px; background:var(--ink); color:var(--paper); cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; }
        .submit-btn:disabled{ opacity:0.55; cursor:not-allowed; }
        .lf-note{ font-family:'Inter'; font-size:11.5px; color:#5e4128; text-align:center; margin-top:10px; opacity:0.75; }

        .overlay{ position:fixed; inset:0; background:rgba(20,12,6,0.55); display:flex; align-items:center; justify-content:center; z-index:50; padding:24px; }
        .panel{ background:var(--paper); border-radius:6px; max-width:640px; width:100%; max-height:86vh; overflow-y:auto; padding:24px; position:relative; box-shadow:0 20px 50px rgba(0,0,0,0.5); }
        .panel-close{ position:absolute; top:14px; right:14px; cursor:pointer; background:rgba(0,0,0,0.08); border-radius:50%; width:28px; height:28px; display:flex; align-items:center; justify-content:center; }
        .panel img.full{ width:100%; max-height:230px; object-fit:cover; border-radius:4px; margin-bottom:14px; }
        .panel h3{ font-family:'Inter'; font-weight:700; font-size:18px; margin:4px 0 8px; }
        .panel .meta-row{ display:flex; gap:16px; flex-wrap:wrap; font-family:'IBM Plex Mono'; font-size:11.5px; color:#6b5c3f; margin-bottom:14px; }
        .panel .meta-row span{ display:flex; align-items:center; gap:4px; }
        .panel p.desc{ font-size:14px; line-height:1.55; margin-bottom:16px; }
        .match-section h4{ font-family:'Special Elite'; font-size:14px; display:flex; align-items:center; gap:7px; margin-bottom:12px; color:var(--ink); }
        .match-loading{ display:flex; align-items:center; gap:8px; font-family:'IBM Plex Mono'; font-size:12px; color:#6b5c3f; }
        .match-row{ display:flex; align-items:center; gap:0; margin-bottom:6px; }
        .mini-ticket{ width:78px; flex-shrink:0; text-align:center; }
        .mini-ticket img{ width:78px; height:60px; object-fit:cover; border-radius:3px; border:2px solid #fff; box-shadow:0 2px 6px rgba(0,0,0,0.25); }
        .mini-ticket .noimg-mini{ width:78px; height:60px; border-radius:3px; background:#e2d6b3; border:2px solid #fff; }
        .mini-ticket .cap{ font-family:'IBM Plex Mono'; font-size:9px; margin-top:3px; color:#6b5c3f; text-transform:uppercase; }
        .thread{ flex:1; height:0; border-top:2px dashed var(--rust); position:relative; margin:0 -4px; display:flex; align-items:center; justify-content:center; }
        .stamp-circle{ background:var(--gold); color:var(--ink); font-family:'IBM Plex Mono'; font-weight:700; font-size:12px; width:44px; height:44px; border-radius:50%; display:flex; align-items:center; justify-content:center; border:2px solid var(--ink); z-index:1; }
        .match-explain{ font-family:'Inter'; font-size:12.5px; color:#4a3c22; text-align:center; margin:2px 0 20px; font-style:italic; }
        .no-match{ font-family:'Inter'; font-size:13px; color:#6b5c3f; text-align:center; padding:16px; }
        .find-btn{ font-family:'IBM Plex Mono'; font-size:11.5px; font-weight:600; padding:8px 14px; border-radius:4px; border:1.5px solid var(--ink); background:transparent; cursor:pointer; display:flex; align-items:center; gap:6px; margin:0 auto 14px; }

        .success-banner{ max-width:560px; margin:0 auto 16px; background:var(--teal); color:#fff; padding:12px 16px; border-radius:4px; font-family:'Inter'; font-size:13px; display:flex; align-items:center; gap:10px; }
      `}</style>

      <div className="lf-header">
        <div className="lf-title">
          <PinIcon size={20} color="#c99a3e" />
          <div>
            LOST &amp; FOUND
            <span className="sub">campus board</span>
          </div>
        </div>
        <div className="lf-tabs">
          <div className={`lf-tab ${view === "browse" ? "active" : ""}`} onClick={() => setView("browse")}>Browse board</div>
          <div className={`lf-tab ${view === "submit" ? "active" : ""}`} onClick={() => { setView("submit"); setJustSubmitted(null); }}>File a report</div>
        </div>
      </div>

      <div className="lf-body">
        {view === "browse" && (
          <>
            <div className="lf-search">
              <div className="lf-search-box">
                <Search size={16} color="#6b5c3f" />
                <input placeholder="Search by item, location, or category…" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <div className="lf-filters">
                {["all", "lost", "found"].map((t) => (
                  <div key={t} className={`lf-filter ${filterType === t ? "active" : ""}`} onClick={() => setFilterType(t)}>{t.toUpperCase()}</div>
                ))}
              </div>
            </div>

            {loadingReports ? (
              <div className="lf-empty"><Loader2 className="spin" size={26} /><div className="msg" style={{ marginTop: 10 }}>Reading the board…</div></div>
            ) : filtered.length === 0 ? (
              <div className="lf-empty">
                <Inbox size={30} />
                <div className="msg">{reports.length === 0 ? "The board's empty. Be the first to pin a report." : "Nothing matches that search."}</div>
              </div>
            ) : (
              <div className="lf-grid">
                {filtered.map((r) => (
                  <div key={r.id} className="ticket" style={{ transform: `rotate(${rot(r.id)}deg)` }} onClick={() => openDetail(r)}>
                    <div className="pin" />
                    <div className={`stamp ${r.type}`}>{r.type}</div>
                    {r.image ? <img className="thumb" src={r.image} alt="" /> : <div className="noimg"><Camera size={22} color="#a4936a" /></div>}
                    <h4>{r.description.length > 46 ? r.description.slice(0, 46) + "…" : r.description}</h4>
                    <div className="meta"><MapPin size={11} /> {r.location}</div>
                    <div className="meta"><Clock size={11} /> {fmtWhen(r.dateTime)}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {view === "submit" && (
          <>
            {justSubmitted && (
              <div className="success-banner">
                <Sparkles size={16} />
                <span>Pinned to the board. Open it from Browse anytime to check its AI matches.</span>
              </div>
            )}
            <div className="lf-form">
              <div className="pin" />
              <div className="toggle-row">
                <div className={`toggle-btn lost ${form.type === "lost" ? "on" : ""}`} onClick={() => setForm((f) => ({ ...f, type: "lost" }))}>I lost something</div>
                <div className={`toggle-btn found ${form.type === "found" ? "on" : ""}`} onClick={() => setForm((f) => ({ ...f, type: "found" }))}>I found something</div>
              </div>

              <div className="field">
                <label>Photo (optional, helps matching a lot)</label>
                <label className="upload-box">
                  {imgBusy ? <Loader2 className="spin" size={20} /> : form.image ? <img src={form.image} alt="" /> : <Camera size={22} color="#a4936a" />}
                  <span style={{ fontFamily: "Inter", fontSize: 13, color: "#6b5c3f" }}>{form.image ? "Photo attached — tap to replace" : "Tap to attach a photo"}</span>
                  <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => handleImage(e.target.files[0])} />
                </label>
              </div>

              <div className="field">
                <label>Description</label>
                <textarea placeholder="e.g. Black Jansport backpack with a red keychain and a dented water bottle inside" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
              </div>

              <div className="row2">
                <div className="field">
                  <label>Category</label>
                  <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
                    {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Location</label>
                  <input placeholder="e.g. Library, 2nd floor" value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} />
                </div>
              </div>

              <div className="row2">
                <div className="field">
                  <label>Date &amp; time</label>
                  <input type="datetime-local" value={form.dateTime} onChange={(e) => setForm((f) => ({ ...f, dateTime: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Contact (optional)</label>
                  <input placeholder="email or phone" value={form.contact} onChange={(e) => setForm((f) => ({ ...f, contact: e.target.value }))} />
                </div>
              </div>

              <button className="submit-btn" disabled={submitting || !form.description.trim() || !form.location.trim() || !form.dateTime} onClick={submit}>
                {submitting ? <Loader2 className="spin" size={16} /> : <PinIcon size={15} />}
                {submitting ? "Pinning…" : "Pin to board"}
              </button>
              <div className="lf-note">Reports are pinned to a shared board — visible to everyone browsing it.</div>
            </div>

            {justSubmitted && <MatchPanelInline reportId={justSubmitted.id} matchState={matchState} />}
          </>
        )}
      </div>

      {detail && (
        <div className="overlay" onClick={() => setDetail(null)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <div className="panel-close" onClick={() => setDetail(null)}><X size={16} /></div>
            {detail.image && <img className="full" src={detail.image} alt="" />}
            <div className={`stamp ${detail.type}`} style={{ position: "static", display: "inline-block", marginBottom: 8 }}>{detail.type}</div>
            <h3>{detail.description}</h3>
            <div className="meta-row">
              <span><MapPin size={12} /> {detail.location}</span>
              <span><Clock size={12} /> {fmtWhen(detail.dateTime)}</span>
              <span>{detail.category}</span>
              {detail.contact && <span>Contact: {detail.contact}</span>}
            </div>

            <div className="match-section">
              <h4><Sparkles size={14} color="#c99a3e" /> AI-suggested matches</h4>
              <MatchBody reportId={detail.id} matchState={matchState} onRetry={() => findMatches(detail)} />
            </div>
          </div>
        </div>
      )}

      <style>{`.spin{ animation: lf-spin 1s linear infinite; } @keyframes lf-spin{ to{ transform:rotate(360deg); } }`}</style>
    </div>
  );
}

function MatchBody({ reportId, matchState, onRetry }) {
  const s = matchState[reportId];
  if (!s || s.loading) return <div className="match-loading"><Loader2 className="spin" size={14} /> Comparing against the board…</div>;
  if (s.error) return (
    <div className="no-match">
      {s.error}
      <div><button className="find-btn" style={{ marginTop: 10 }} onClick={onRetry}><Sparkles size={13} /> Try again</button></div>
    </div>
  );
  if (s.matches.length === 0) return <div className="no-match">No plausible matches on the board yet. Check back as new reports come in.</div>;
  return (
    <div>
      {s.matches.map((m) => (
        <div key={m.report.id}>
          <div className="match-row">
            <div className="mini-ticket">
              {m.report.image ? <img src={m.report.image} alt="" /> : <div className="noimg-mini" />}
              <div className="cap">{m.report.type}</div>
            </div>
            <div className="thread"><div className="stamp-circle">{m.confidence}%</div></div>
            <div className="mini-ticket">
              <div className="cap" style={{ marginTop: 0 }}>{m.report.location}</div>
              <div className="cap">{fmtWhen(m.report.dateTime)}</div>
            </div>
          </div>
          <div className="match-explain">"{m.explanation}"</div>
        </div>
      ))}
    </div>
  );
}

function MatchPanelInline({ reportId, matchState }) {
  return (
    <div className="lf-form" style={{ marginTop: 18 }}>
      <div className="match-section">
        <h4><Sparkles size={14} color="#c99a3e" /> AI-suggested matches for what you just pinned</h4>
        <MatchBody reportId={reportId} matchState={matchState} onRetry={() => {}} />
      </div>
    </div>
  );
}
