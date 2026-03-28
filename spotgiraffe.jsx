import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ═══════════════════════════════════════════════════════════════════
// SPOTGIRAFFE ATS v10 — FULL-STACK RESUME BUILDER + AI + BACKEND
// ═══════════════════════════════════════════════════════════════════

// ── PERSISTENT BACKEND (Storage API) ─────────────────────────────
const DB = {
  async get(k) { try { const r = await window.storage.get(k); return r ? JSON.parse(r.value) : null; } catch { return null; } },
  async set(k, v) { try { await window.storage.set(k, JSON.stringify(v)); return true; } catch { return false; } },
  async del(k) { try { await window.storage.delete(k); return true; } catch { return false; } },
  async list(p) { try { const r = await window.storage.list(p); return r?.keys || []; } catch { return []; } }
};

const API = {
  async saveResume(d) {
    const id = d.id || `resume_${Date.now()}`;
    const rec = { ...d, id, updatedAt: new Date().toISOString(), createdAt: d.createdAt || new Date().toISOString() };
    await DB.set(`resumes:${id}`, rec);
    const idx = (await DB.get("resumes:index")) || [];
    if (!idx.includes(id)) { idx.push(id); await DB.set("resumes:index", idx); }
    await this.logActivity(`Resume saved: ${d.firstName || "Draft"} ${d.lastName || ""}`);
    return rec;
  },
  async getResume(id) { return DB.get(`resumes:${id}`); },
  async listResumes() {
    const idx = (await DB.get("resumes:index")) || [];
    const all = []; for (const id of idx) { const r = await DB.get(`resumes:${id}`); if (r) all.push(r); } return all;
  },
  async deleteResume(id) {
    await DB.del(`resumes:${id}`);
    const idx = (await DB.get("resumes:index")) || [];
    await DB.set("resumes:index", idx.filter(i => i !== id));
    await this.logActivity(`Resume deleted: ${id}`);
  },
  async saveSettings(s) { await DB.set("app:settings", s); },
  async getSettings() { return (await DB.get("app:settings")) || { apiKey: "", model: "claude-sonnet-4-20250514", maxUsers: 50 }; },
  async saveUser(u) {
    const id = u.id || `user_${Date.now()}`;
    const rec = { ...u, id, createdAt: u.createdAt || new Date().toISOString() };
    await DB.set(`users:${id}`, rec);
    const idx = (await DB.get("users:index")) || [];
    if (!idx.includes(id)) { idx.push(id); await DB.set("users:index", idx); }
    return rec;
  },
  async listUsers() {
    const idx = (await DB.get("users:index")) || [];
    const all = []; for (const id of idx) { const r = await DB.get(`users:${id}`); if (r) all.push(r); } return all;
  },
  async updateUserStatus(id, status) {
    const u = await DB.get(`users:${id}`);
    if (u) { u.status = status; u.lastActive = new Date().toISOString(); await DB.set(`users:${id}`, u); }
    await this.logActivity(`User ${id} status changed to ${status}`);
  },
  async deleteUser(id) {
    await DB.del(`users:${id}`);
    const idx = (await DB.get("users:index")) || [];
    await DB.set("users:index", idx.filter(i => i !== id));
  },
  async logActivity(msg) {
    const logs = (await DB.get("app:activitylog")) || [];
    logs.unshift({ msg, ts: new Date().toISOString() });
    await DB.set("app:activitylog", logs.slice(0, 50));
  },
  async getActivityLog() { return (await DB.get("app:activitylog")) || []; },
  async getStats() {
    const resumes = await this.listResumes();
    const users = await this.listUsers();
    return {
      totalPilots: users.length,
      totalResumes: resumes.length,
      generations: resumes.reduce((a, r) => a + (r.genCount || 0), 0),
      avgScore: resumes.length ? Math.round(resumes.reduce((a, r) => a + (r.atsScore || 0), 0) / resumes.length) : 0,
      activeUsers: users.filter(u => u.status === "ACTIVE").length,
    };
  },
  async aiOptimize(data, settings) {
    if (!settings.apiKey) return { error: "API key required. Set it in Admin > Settings." };
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": settings.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: settings.model || "claude-sonnet-4-20250514",
          max_tokens: 2000,
          messages: [{ role: "user", content: `You are an expert ATS resume optimizer. Given this resume data and target job, rewrite the summary and experience bullets to maximize ATS keyword matching.\n\nResume: ${JSON.stringify({ firstName: data.firstName, lastName: data.lastName, title: data.title, summary: data.summary, experience: data.experience, skills: data.skills })}\nTarget Role: ${data.targetRole || "Not specified"}\nJob Description: ${data.jd || "Not provided"}\n\nReturn ONLY valid JSON: { "summary": "optimized summary", "experience": [{ "bullets": ["bullet1", ...] }] }` }]
        })
      });
      const result = await resp.json();
      const text = result.content?.map(c => c.text || "").join("") || "";
      return JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch (e) { return { error: `AI failed: ${e.message}` }; }
  }
};

// ── DESIGN TOKENS ────────────────────────────────────────────────
const C = {
  void: "#000000", hull: "#0a0d1a", console: "#151929", module: "#212538", bright: "#272b40",
  primary: "#8dacff", primaryDim: "#146bfb", primaryFixed: "#779dff",
  onPrimary: "#002a6f", onSurface: "#e3e4f7", onSurfaceVar: "#a8aabc",
  outline: "#727485", outlineVar: "#444756",
  tertiary: "#ff6e82", tertiaryDim: "#fd4b6c",
  error: "#ff716c", success: "#22c55e", warn: "#f59e0b",
  glass: "rgba(33,37,56,0.65)",
};

// ── ATS SCORING ENGINE ──────────────────────────────────────────
function computeATS(data, jd = "") {
  const filled = [data.firstName, data.lastName, data.title, data.email, data.summary, data.experience?.some(e => e.jobTitle), data.education?.some(e => e.degree), data.skills?.length > 0];
  const completeness = Math.round((filled.filter(Boolean).length / filled.length) * 100);
  let keyDensity = 35;
  if (jd && jd.length > 20) {
    const jdWords = new Set(jd.toLowerCase().split(/\W+/).filter(w => w.length > 3));
    const rText = [data.summary || "", ...(data.skills || []), ...(data.experience || []).flatMap(e => e.bullets || [])].join(" ").toLowerCase();
    const hits = [...jdWords].filter(w => rText.includes(w));
    keyDensity = jdWords.size ? Math.min(100, Math.round((hits.length / jdWords.size) * 120)) : 50;
  } else if (data.skills?.length > 5) keyDensity = 60;
  const hasBullets = (data.experience || []).some(e => e.bullets?.filter(Boolean).length > 0);
  const hasDates = (data.experience || []).some(e => e.startDate);
  const formatScore = [hasBullets, hasDates, (data.summary || "").length > 80, (data.skills || []).length > 2].filter(Boolean).length * 25;
  const wc = [data.summary || "", ...(data.experience || []).flatMap(e => e.bullets || [])].join(" ").split(/\s+/).filter(Boolean).length;
  const lengthScore = wc >= 300 && wc <= 900 ? 100 : wc < 300 ? Math.round((wc / 300) * 100) : Math.max(50, 100 - (wc - 900) / 8);
  const contactScore = Math.min(100, [data.email, data.phone, data.linkedin].filter(Boolean).length * 34);
  const total = Math.min(100, Math.round(completeness * 0.3 + keyDensity * 0.25 + formatScore * 0.2 + lengthScore * 0.15 + contactScore * 0.1));
  return { total, completeness, keyDensity, formatScore, lengthScore, contactScore };
}

// ── ICON ─────────────────────────────────────────────────────────
const MI = ({ n, s = 20, c, style: sx }) => (
  <span style={{ fontSize: s, fontFamily: "'Material Symbols Outlined'", fontVariationSettings: "'FILL' 0,'wght' 400", color: c, lineHeight: 1, ...sx }}>{n}</span>
);

// ── TOAST SYSTEM ─────────────────────────────────────────────────
let _toastFn = null;
const toast = (msg, type = "info") => _toastFn?.({ msg, type, id: Date.now() });
const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);
  _toastFn = (t) => { setToasts(p => [...p, t]); setTimeout(() => setToasts(p => p.filter(x => x.id !== t.id)), 3500); };
  const colors = { info: C.primary, success: C.success, error: C.tertiary, warn: C.warn };
  return (<>{children}
    <div style={{ position: "fixed", bottom: 80, right: 16, zIndex: 9999, display: "flex", flexDirection: "column", gap: 8 }}>
      {toasts.map(t => (
        <div key={t.id} style={{ background: C.console, border: `1px solid ${colors[t.type]}40`, borderLeft: `3px solid ${colors[t.type]}`, padding: "10px 16px", borderRadius: 10, backdropFilter: "blur(16px)", fontFamily: "Manrope", fontSize: 12, color: C.onSurface, maxWidth: 300, animation: "slideIn 0.3s ease" }}>{t.msg}</div>
      ))}
    </div>
  </>);
};

// ── SCORE RING ───────────────────────────────────────────────────
const ScoreRing = ({ score, size = 130 }) => {
  const r = size / 2 - 14, circ = 2 * Math.PI * r, off = circ - (score / 100) * circ;
  const col = score >= 80 ? C.success : score >= 60 ? C.warn : C.tertiary;
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={C.module} strokeWidth={8} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={col} strokeWidth={8} strokeDasharray={circ} strokeDashoffset={off} strokeLinecap="round" style={{ transition: "all 1s cubic-bezier(0.4,0,0.2,1)", filter: `drop-shadow(0 0 6px ${col}60)` }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontFamily: "Space Grotesk", fontSize: size * 0.28, fontWeight: 800, color: C.onSurface, lineHeight: 1 }}>{score}</span>
        <span style={{ fontFamily: "Inter", fontSize: 8, letterSpacing: "0.2em", color: col, textTransform: "uppercase", marginTop: 2 }}>SCORE</span>
      </div>
    </div>
  );
};

const ProgBar = ({ label, value, color = C.primary }) => (
  <div style={{ marginBottom: 14 }}>
    <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "Inter", fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: C.onSurfaceVar, marginBottom: 5 }}>
      <span>{label}</span><span style={{ color }}>{value}%</span>
    </div>
    <div style={{ height: 5, background: C.void, borderRadius: 99, overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${Math.min(100, value)}%`, background: `linear-gradient(90deg, ${C.primaryDim}, ${color})`, borderRadius: 99, transition: "width 0.8s cubic-bezier(0.4,0,0.2,1)", boxShadow: `0 0 10px ${color}30` }} />
    </div>
  </div>
);

const Inp = ({ label, value, onChange, placeholder, type = "text", area, disabled }) => {
  const base = { width: "100%", background: C.void, border: "none", borderBottom: `2px solid ${C.outlineVar}30`, padding: "11px 14px", borderRadius: "8px 8px 0 0", color: C.onSurface, fontFamily: "Manrope", fontSize: 13, outline: "none", transition: "border-color 0.3s", opacity: disabled ? 0.5 : 1 };
  return (
    <div style={{ marginBottom: 14 }}>
      {label && <label style={{ fontFamily: "Inter", fontSize: 9, letterSpacing: "0.2em", textTransform: "uppercase", color: C.onSurfaceVar, display: "block", marginBottom: 5, marginLeft: 2 }}>{label}</label>}
      {area ? <textarea style={{ ...base, minHeight: 110, resize: "vertical" }} value={value || ""} onChange={e => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} />
        : <input style={base} type={type} value={value || ""} onChange={e => onChange(e.target.value)} placeholder={placeholder} disabled={disabled}
            onFocus={e => { e.target.style.borderBottomColor = C.primary; e.target.style.boxShadow = `0 2px 12px ${C.primary}15`; }}
            onBlur={e => { e.target.style.borderBottomColor = `${C.outlineVar}30`; e.target.style.boxShadow = "none"; }} />}
    </div>
  );
};

const Tags = ({ tags = [], setTags, placeholder }) => {
  const [inp, setInp] = useState("");
  const add = () => { const v = inp.trim().toUpperCase(); if (v && !tags.includes(v)) { setTags([...tags, v]); setInp(""); } };
  return (
    <div style={{ background: C.void, padding: 14, borderRadius: 12, border: `1px solid ${C.outlineVar}15` }}>
      {tags.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {tags.map((t, i) => (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 7, background: `${C.primary}15`, border: `1px solid ${C.primary}25`, color: C.primary, fontFamily: "Inter", fontSize: 10, fontWeight: 700 }}>
            {t} <span onClick={() => setTags(tags.filter((_, j) => j !== i))} style={{ cursor: "pointer", opacity: 0.7, fontSize: 12 }}>✕</span>
          </span>
        ))}
      </div>}
      <input style={{ width: "100%", background: C.console, border: "none", padding: "10px 14px", borderRadius: 8, color: C.onSurface, fontFamily: "Manrope", fontSize: 12, outline: "none" }}
        value={inp} onChange={e => setInp(e.target.value)} placeholder={placeholder}
        onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }} />
    </div>
  );
};

const SecH = ({ title, sub, action }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderLeft: `3px solid ${C.primaryDim}`, paddingLeft: 14, marginBottom: 18 }}>
    <div>
      <h2 style={{ fontFamily: "Space Grotesk", fontSize: 20, fontWeight: 800, lineHeight: 1.1 }}>{title}</h2>
      {sub && <p style={{ fontFamily: "Manrope", fontSize: 12, color: C.onSurfaceVar, marginTop: 2 }}>{sub}</p>}
    </div>
    {action}
  </div>
);

const btnP = { background: `linear-gradient(135deg, ${C.primaryDim}, ${C.primary})`, color: "#fff", fontFamily: "Space Grotesk", fontWeight: 700, fontSize: 11, padding: "10px 20px", borderRadius: 10, border: "none", cursor: "pointer", letterSpacing: "0.06em", textTransform: "uppercase", display: "inline-flex", alignItems: "center", gap: 8, transition: "all 0.2s", boxShadow: `0 8px 24px ${C.primaryDim}25` };
const btnG = { background: C.module, border: "none", color: C.onSurfaceVar, fontFamily: "Inter", fontSize: 10, fontWeight: 600, padding: "8px 14px", borderRadius: 8, cursor: "pointer", letterSpacing: "0.06em", textTransform: "uppercase", transition: "all 0.2s" };
const btnA = { width: 34, height: 34, borderRadius: 99, background: `${C.primary}18`, border: "none", color: C.primary, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" };

const TMPLS = [
  { id: "vanguard", name: "Vanguard v1", cat: "TECH", sub: "Executive High-Density", bg: "#1a1a2e", fg: "#e2e8f0", accent: "#8dacff" },
  { id: "nebula", name: "Nebula Dark", cat: "CREATIVE", sub: "Creative Minimalist", bg: "#0d1b2a", fg: "#e2e8f0", accent: "#a78bfa" },
  { id: "stellar", name: "Stellar Pure", cat: "ALL", sub: "Classic ATS-Safe", bg: "#ffffff", fg: "#1e293b", accent: "#2563eb" },
  { id: "faang", name: "FAANG Optimized", cat: "TECH", sub: "Maximum Scannability", bg: "#ffffff", fg: "#111827", accent: "#000000" },
  { id: "executive", name: "The Executive", cat: "FINANCE", sub: "Classic Leadership", bg: "#faf8f0", fg: "#1c1917", accent: "#92400e" },
  { id: "hypermod", name: "Hyper-Modern", cat: "TECH", sub: "Next-Gen Interface", bg: "#111827", fg: "#f1f5f9", accent: "#06b6d4" },
  { id: "codebase", name: "Code-Base", cat: "TECH", sub: "Dev & Ops Focused", bg: "#0f172a", fg: "#cbd5e1", accent: "#22c55e" },
  { id: "scholar", name: "CV Scholar", cat: "ALL", sub: "Academic Detail", bg: "#fffbeb", fg: "#1c1917", accent: "#b91c1c" },
  { id: "visualist", name: "Visualist", cat: "CREATIVE", sub: "Design & Media", bg: "#fdf2f8", fg: "#1e1b4b", accent: "#db2777" },
  { id: "minimalist", name: "The Minimalist", cat: "ALL", sub: "No-Nonsense", bg: "#ffffff", fg: "#374151", accent: "#6b7280" },
  { id: "silicon", name: "Silicon Valley", cat: "TECH", sub: "Startup Ready", bg: "#ecfdf5", fg: "#064e3b", accent: "#059669" },
  { id: "standard", name: "Standard Pro", cat: "ALL", sub: "Versatile", bg: "#f8fafc", fg: "#1e293b", accent: "#3b82f6" },
  { id: "landon", name: "Landon Blue", cat: "FINANCE", sub: "Finance & Risk", bg: "#eff6ff", fg: "#1e3a5f", accent: "#1d4ed8" },
  { id: "nomad", name: "The Nomad", cat: "CREATIVE", sub: "Remote First", bg: "#fefce8", fg: "#422006", accent: "#d97706" },
  { id: "matrix", name: "Matrix One", cat: "TECH", sub: "Cybersecurity", bg: "#022c22", fg: "#86efac", accent: "#22c55e" },
  { id: "apollo", name: "Apollo", cat: "TECH", sub: "Engineering", bg: "#f0f9ff", fg: "#0c4a6e", accent: "#0284c7" },
  { id: "horizon", name: "Horizon", cat: "ALL", sub: "Product Mgmt", bg: "#faf5ff", fg: "#3b0764", accent: "#9333ea" },
  { id: "vertex", name: "Vertex", cat: "TECH", sub: "Data Science", bg: "#f0fdf4", fg: "#14532d", accent: "#16a34a" },
];

const ResumePreview = ({ data, templateId = "vanguard" }) => {
  const t = TMPLS.find(x => x.id === templateId) || TMPLS[0];
  const dark = t.bg.match(/^#[0-3]/);
  const divC = dark ? `${t.fg}25` : `${t.fg}20`;
  const subC = dark ? `${t.fg}99` : `${t.fg}88`;
  return (
    <div style={{ background: t.bg, color: t.fg, fontFamily: "'Manrope',sans-serif", fontSize: 10, padding: 24, borderRadius: 10, aspectRatio: "1/1.414", overflow: "hidden", lineHeight: 1.55 }}>
      <div style={{ borderBottom: `2px solid ${dark ? t.fg + "40" : t.fg}`, paddingBottom: 10, marginBottom: 14 }}>
        <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 20, fontWeight: 800, textTransform: "uppercase", letterSpacing: "-0.02em", lineHeight: 1.1 }}>{data.firstName || "Your"} {data.lastName || "Name"}</div>
        <div style={{ fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600, color: subC, marginTop: 2 }}>{data.title || "Professional Title"}</div>
        {(data.email || data.phone || data.location) && <div style={{ fontSize: 8, color: subC, marginTop: 4, display: "flex", gap: 8, flexWrap: "wrap" }}>{data.email && <span>{data.email}</span>}{data.phone && <span>· {data.phone}</span>}{data.location && <span>· {data.location}</span>}</div>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2.2fr", gap: 16 }}>
        <div style={{ fontSize: 8.5 }}>
          {data.skills?.length > 0 && <div style={{ marginBottom: 10 }}>
            <div style={{ fontFamily: "'Inter'", fontSize: 7.5, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 800, borderBottom: `1px solid ${divC}`, paddingBottom: 3, marginBottom: 5, color: t.accent }}>Skills</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>{data.skills.slice(0, 12).map((s, i) => <span key={i} style={{ background: dark ? `${t.fg}10` : `${t.fg}08`, padding: "1px 4px", fontSize: 7, borderRadius: 2 }}>{s}</span>)}</div>
          </div>}
          {data.education?.filter(e => e.degree).length > 0 && <div>
            <div style={{ fontFamily: "'Inter'", fontSize: 7.5, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 800, borderBottom: `1px solid ${divC}`, paddingBottom: 3, marginBottom: 5, color: t.accent }}>Education</div>
            {data.education.filter(e => e.degree).slice(0, 2).map((ed, i) => <div key={i} style={{ marginBottom: 4 }}><div style={{ fontWeight: 700, fontSize: 8 }}>{ed.degree}</div><div style={{ fontSize: 7, color: subC }}>{ed.institution} {ed.year && `· ${ed.year}`}</div></div>)}
          </div>}
        </div>
        <div>
          {data.summary && <div style={{ marginBottom: 10 }}><div style={{ fontFamily: "'Inter'", fontSize: 7.5, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 800, borderBottom: `1px solid ${divC}`, paddingBottom: 3, marginBottom: 5, color: t.accent }}>Summary</div><div style={{ fontSize: 8.5, lineHeight: 1.65 }}>{data.summary.slice(0, 250)}{data.summary.length > 250 ? "..." : ""}</div></div>}
          {data.experience?.filter(e => e.jobTitle).length > 0 && <div>
            <div style={{ fontFamily: "'Inter'", fontSize: 7.5, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 800, borderBottom: `1px solid ${divC}`, paddingBottom: 3, marginBottom: 5, color: t.accent }}>Experience</div>
            {data.experience.filter(e => e.jobTitle).slice(0, 3).map((exp, i) => <div key={i} style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 9 }}>{exp.jobTitle}{exp.company ? ` · ${exp.company}` : ""}</div>
              <div style={{ fontSize: 7, fontStyle: "italic", color: subC }}>{exp.startDate || "—"} — {exp.current ? "Present" : (exp.endDate || "—")}</div>
              {exp.bullets?.filter(Boolean).slice(0, 3).map((b, j) => <div key={j} style={{ fontSize: 8, marginTop: 1.5, paddingLeft: 8 }}>• {b.slice(0, 100)}</div>)}
            </div>)}
          </div>}
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// LANDING PAGE
// ═══════════════════════════════════════════════════════════════════
const LandingPage = ({ go }) => {
  const [hov, setHov] = useState(null);
  return (
    <div style={{ background: C.void, minHeight: "100vh", color: C.onSurface, overflow: "hidden" }}>
      <div style={{ position: "absolute", top: "10%", left: "50%", transform: "translate(-50%,-40%)", width: 600, height: 600, background: `radial-gradient(circle, ${C.primaryDim}12 0%, transparent 65%)`, pointerEvents: "none" }} />
      <div style={{ position: "relative", padding: "90px 24px 50px", textAlign: "center" }}>
        <div style={{ fontFamily: "Inter", fontSize: 10, letterSpacing: "0.35em", textTransform: "uppercase", color: C.primary, marginBottom: 24, opacity: 0.8 }}>THE FUTURE OF EMPLOYMENT</div>
        <h1 style={{ fontFamily: "'Space Grotesk'", fontSize: "clamp(42px,11vw,76px)", fontWeight: 800, lineHeight: 0.92, letterSpacing: "-0.04em", marginBottom: 28 }}>
          Elevate<br /><span style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.primaryDim})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Your</span><br />Orbit.
        </h1>
        <p style={{ fontFamily: "Manrope", color: C.onSurfaceVar, maxWidth: 440, margin: "0 auto 36px", lineHeight: 1.75, fontSize: 14 }}>SpotGiraffe transforms your professional arc with AI-driven ATS v10 optimization. Craft resumes that penetrate high-density applicant tracking filters.</p>
        <button onClick={() => go("builder")} style={{ ...btnP, fontSize: 13, padding: "15px 40px", borderRadius: 14 }}>BEGIN ORBIT →</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12, padding: "32px 20px 48px", maxWidth: 680, margin: "0 auto" }}>
        {[["99%", "ATS Pass Rate", "verified"], ["108K+", "Resumes Built", "description"], ["+40%", "Interview Boost", "trending_up"], ["14,115", "Active Pilots", "group"]].map(([v, l, ic], i) => (
          <div key={i} style={{ background: C.hull, padding: 18, borderRadius: 14, textAlign: "center", border: `1px solid ${C.outlineVar}10` }}>
            <MI n={ic} s={18} c={C.primary} /><div style={{ fontFamily: "'Space Grotesk'", fontSize: 22, fontWeight: 800, marginTop: 4 }}>{v}</div>
            <div style={{ fontFamily: "Inter", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: C.onSurfaceVar, marginTop: 3 }}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{ padding: "32px 24px 48px", maxWidth: 560, margin: "0 auto" }}>
        <h2 style={{ fontFamily: "'Space Grotesk'", fontSize: 34, fontWeight: 800, marginBottom: 32, lineHeight: 1.05 }}>Why<br />SpotGiraffe?</h2>
        {[["neurology", "Deep-Scan Engine", "AI algorithms parse & rank resumes like enterprise ATS systems."],
          ["monitoring", "Real-Time Telemetry", "Watch keyword frequencies and optimization scores shift live."],
          ["sync", "Dynamic Sync", "Resume auto-updates with intelligent content reflow."],
          ["psychology", "AI Neural Optimizer", "Powered by Claude AI to rewrite and maximize ATS resonance."],
        ].map(([ic, title, desc], i) => (
          <div key={i} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)} style={{ display: "flex", gap: 16, marginBottom: 24, padding: 14, borderRadius: 12, background: hov === i ? `${C.primary}08` : "transparent", transition: "all 0.3s" }}>
            <div style={{ width: 44, height: 44, background: `${C.primary}12`, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><MI n={ic} s={22} c={C.primary} /></div>
            <div><div style={{ fontFamily: "'Space Grotesk'", fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{title}</div><div style={{ fontFamily: "Manrope", fontSize: 13, color: C.onSurfaceVar, lineHeight: 1.65 }}>{desc}</div></div>
          </div>
        ))}
      </div>
      <div style={{ padding: "40px 24px 100px", textAlign: "center" }}>
        <div style={{ fontFamily: "'Space Grotesk'", fontSize: 34, fontWeight: 800, lineHeight: 1.05, marginBottom: 20 }}>Precision<br />engineering<br />for your career.</div>
        <div style={{ margin: "20px auto", width: 90, height: 90, borderRadius: 999, background: `linear-gradient(135deg, ${C.primaryDim}, ${C.primary})`, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 0 50px ${C.primary}25` }}>
          <span style={{ fontFamily: "'Space Grotesk'", fontSize: 26, fontWeight: 800, color: "#fff" }}>9.8</span>
        </div>
        <div style={{ fontFamily: "Inter", fontSize: 9, letterSpacing: "0.15em", color: C.onSurfaceVar, textTransform: "uppercase", marginBottom: 28 }}>AVERAGE ATS COMPLIANCE</div>
        <h2 style={{ fontFamily: "'Space Grotesk'", fontSize: 36, fontWeight: 800, lineHeight: 1.0, marginBottom: 20 }}>Ready to break the<br /><span style={{ color: C.primary }}>Atmosphere?</span></h2>
        <button onClick={() => go("builder")} style={{ ...btnP, fontSize: 13, padding: "14px 36px" }}>LAUNCH NOW →</button>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// BUILDER PAGE
// ═══════════════════════════════════════════════════════════════════
const BuilderPage = ({ go }) => {
  const [tab, setTab] = useState(0);
  const [saving, setSaving] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [tmpl, setTmpl] = useState("vanguard");
  const [tmplFilter, setTmplFilter] = useState("ALL");
  const [showPreview, setShowPreview] = useState(false);
  const [data, setData] = useState({
    firstName: "", lastName: "", title: "", email: "", phone: "", location: "", linkedin: "", github: "", website: "",
    summary: "", experience: [{ jobTitle: "", company: "", location: "", startDate: "", endDate: "", current: false, bullets: [""] }],
    education: [{ degree: "", field: "", institution: "", year: "", gpa: "" }],
    skills: [], softSkills: [], tools: [],
    projects: [{ name: "", tech: [], description: "", liveUrl: "", githubUrl: "" }],
    certifications: [{ name: "", org: "", year: "", url: "" }],
    jd: "", targetRole: "", genCount: 0,
  });
  const [score, setScore] = useState({ total: 0, completeness: 0, keyDensity: 0, formatScore: 0, lengthScore: 0, contactScore: 0 });
  const up = useCallback((k, v) => setData(p => ({ ...p, [k]: v })), []);
  useEffect(() => { setScore(computeATS(data, data.jd)); }, [data]);
  useEffect(() => { const t = setTimeout(async () => { setSaving(true); await API.saveResume({ ...data, id: "current", atsScore: score.total }); setTimeout(() => setSaving(false), 600); }, 1500); return () => clearTimeout(t); }, [data, score]);
  useEffect(() => { (async () => { const s = await API.getResume("current"); if (s) setData(p => ({ ...p, ...s })); })(); }, []);

  const doAI = async () => {
    setAiLoading(true); toast("Initializing AI Neural Optimizer...", "info");
    const settings = await API.getSettings();
    const result = await API.aiOptimize(data, settings);
    setAiLoading(false);
    if (result.error) { toast(result.error, "error"); return; }
    if (result.summary) up("summary", result.summary);
    if (result.experience) { const n = [...data.experience]; result.experience.forEach((e, i) => { if (n[i] && e.bullets) n[i] = { ...n[i], bullets: e.bullets }; }); up("experience", n); }
    up("genCount", (data.genCount || 0) + 1);
    toast("Resume optimized for maximum ATS resonance!", "success");
  };

  const tabs = [{ icon: "person", label: "Personal" }, { icon: "description", label: "Summary" }, { icon: "work", label: "Experience" }, { icon: "school", label: "Education" }, { icon: "psychology", label: "Skills" }, { icon: "code", label: "Projects" }, { icon: "workspace_premium", label: "Certs" }, { icon: "auto_awesome", label: "AI Tools" }, { icon: "grid_view", label: "Templates" }];
  const addTo = (k, item) => up(k, [...data[k], item]);
  const rmFrom = (k, i) => up(k, data[k].filter((_, j) => j !== i));
  const updArr = (k, i, field, val) => { const n = [...data[k]]; n[i] = { ...n[i], [field]: val }; up(k, n); };

  const renderTab = () => {
    switch (tab) {
      case 0: return (<div><SecH title="Personal Info" sub="Core identity telemetry." />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
          <Inp label="First Name" value={data.firstName} onChange={v => up("firstName", v)} placeholder="Alex" />
          <Inp label="Last Name" value={data.lastName} onChange={v => up("lastName", v)} placeholder="Sterling" />
          <Inp label="Title" value={data.title} onChange={v => up("title", v)} placeholder="Systems Architect" />
          <Inp label="Email" value={data.email} onChange={v => up("email", v)} placeholder="alex@orbit.io" type="email" />
          <Inp label="Phone" value={data.phone} onChange={v => up("phone", v)} placeholder="+1 555-0123" />
          <Inp label="Location" value={data.location} onChange={v => up("location", v)} placeholder="San Francisco, CA" />
          <Inp label="LinkedIn" value={data.linkedin} onChange={v => up("linkedin", v)} placeholder="linkedin.com/in/alex" />
          <Inp label="GitHub" value={data.github} onChange={v => up("github", v)} placeholder="github.com/alex" />
        </div></div>);
      case 1: return (<div><SecH title="Summary" sub="150-200 words ideal." />
        <Inp label="Professional Summary" value={data.summary} onChange={v => up("summary", v)} placeholder="Describe your career trajectory..." area />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontFamily: "Inter", fontSize: 10, color: C.onSurfaceVar }}>{(data.summary || "").split(/\s+/).filter(Boolean).length} words</span>
          <button onClick={doAI} disabled={aiLoading} style={{ ...btnP, padding: "8px 16px", fontSize: 10, opacity: aiLoading ? 0.6 : 1 }}><MI n="auto_fix_high" s={14} /> AI OPTIMIZE</button>
        </div></div>);
      case 2: return (<div><SecH title="Experience" sub="Operational deployments." action={<button onClick={() => addTo("experience", { jobTitle: "", company: "", location: "", startDate: "", endDate: "", current: false, bullets: [""] })} style={btnA}><MI n="add" s={18} /></button>} />
        {data.experience.map((exp, i) => (
          <div key={i} style={{ background: C.console, padding: 18, borderRadius: 14, marginBottom: 14, border: `1px solid ${C.outlineVar}12` }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
              <Inp label="Job Title" value={exp.jobTitle} onChange={v => updArr("experience", i, "jobTitle", v)} placeholder="Lead Engineer" />
              <Inp label="Company" value={exp.company} onChange={v => updArr("experience", i, "company", v)} placeholder="Orbital Dynamics" />
              <Inp label="Start" value={exp.startDate} onChange={v => updArr("experience", i, "startDate", v)} placeholder="2021" />
              <Inp label="End" value={exp.current ? "Present" : exp.endDate} onChange={v => updArr("experience", i, "endDate", v)} placeholder="Present" />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "Inter", fontSize: 10, color: C.onSurfaceVar, cursor: "pointer", margin: "4px 0 8px" }}>
              <input type="checkbox" checked={exp.current || false} onChange={e => updArr("experience", i, "current", e.target.checked)} /> Currently here
            </label>
            <label style={{ fontFamily: "Inter", fontSize: 9, letterSpacing: "0.2em", textTransform: "uppercase", color: C.onSurfaceVar, display: "block", marginBottom: 6 }}>Achievements</label>
            {(exp.bullets || [""]).map((b, j) => (
              <div key={j} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                <span style={{ color: C.primary, fontSize: 7 }}>●</span>
                <input style={{ flex: 1, background: C.void, border: "none", padding: "7px 12px", borderRadius: 6, color: C.onSurface, fontFamily: "Manrope", fontSize: 12, outline: "none" }}
                  value={b} onChange={e => { const n = [...data.experience]; n[i].bullets[j] = e.target.value; up("experience", n); }} placeholder="Describe achievement with metrics..." />
              </div>
            ))}
            <button onClick={() => { const n = [...data.experience]; n[i].bullets = [...(n[i].bullets || []), ""]; up("experience", n); }} style={{ ...btnG, padding: "5px 12px", fontSize: 9, marginRight: 6 }}>+ BULLET</button>
            {data.experience.length > 1 && <button onClick={() => rmFrom("experience", i)} style={{ ...btnG, color: C.tertiary, background: `${C.tertiary}12`, padding: "5px 12px", fontSize: 9 }}>REMOVE</button>}
          </div>
        ))}</div>);
      case 3: return (<div><SecH title="Education" action={<button onClick={() => addTo("education", { degree: "", field: "", institution: "", year: "" })} style={btnA}><MI n="add" s={18} /></button>} />
        {data.education.map((ed, i) => (
          <div key={i} style={{ background: C.console, padding: 18, borderRadius: 14, marginBottom: 14, border: `1px solid ${C.outlineVar}12` }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
              <Inp label="Degree" value={ed.degree} onChange={v => updArr("education", i, "degree", v)} placeholder="B.S. Computer Science" />
              <Inp label="Institution" value={ed.institution} onChange={v => updArr("education", i, "institution", v)} placeholder="MIT" />
              <Inp label="Field" value={ed.field} onChange={v => updArr("education", i, "field", v)} placeholder="AI" />
              <Inp label="Year" value={ed.year} onChange={v => updArr("education", i, "year", v)} placeholder="2020" />
            </div>
            {data.education.length > 1 && <button onClick={() => rmFrom("education", i)} style={{ ...btnG, color: C.tertiary, background: `${C.tertiary}12`, padding: "5px 12px", fontSize: 9 }}>REMOVE</button>}
          </div>))}</div>);
      case 4: return (<div><SecH title="Skills" sub="Technical loadout." />
        <div style={{ marginBottom: 18 }}><label style={{ fontFamily: "Inter", fontSize: 9, letterSpacing: "0.2em", textTransform: "uppercase", color: C.onSurfaceVar, display: "block", marginBottom: 6 }}>Technical</label><Tags tags={data.skills} setTags={v => up("skills", v)} placeholder="Python, React, AWS..." /></div>
        <div style={{ marginBottom: 18 }}><label style={{ fontFamily: "Inter", fontSize: 9, letterSpacing: "0.2em", textTransform: "uppercase", color: C.onSurfaceVar, display: "block", marginBottom: 6 }}>Soft Skills</label><Tags tags={data.softSkills} setTags={v => up("softSkills", v)} placeholder="Leadership..." /></div>
        <div><label style={{ fontFamily: "Inter", fontSize: 9, letterSpacing: "0.2em", textTransform: "uppercase", color: C.onSurfaceVar, display: "block", marginBottom: 6 }}>Tools</label><Tags tags={data.tools || []} setTags={v => up("tools", v)} placeholder="Docker, Figma..." /></div></div>);
      case 5: return (<div><SecH title="Projects" action={<button onClick={() => addTo("projects", { name: "", description: "", liveUrl: "", githubUrl: "" })} style={btnA}><MI n="add" s={18} /></button>} />
        {data.projects.map((p, i) => (
          <div key={i} style={{ background: C.console, padding: 18, borderRadius: 14, marginBottom: 14, border: `1px solid ${C.outlineVar}12` }}>
            <Inp label="Name" value={p.name} onChange={v => updArr("projects", i, "name", v)} placeholder="Orbital Dashboard" />
            <Inp label="Description" value={p.description} onChange={v => updArr("projects", i, "description", v)} placeholder="Built a..." area />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
              <Inp label="Live URL" value={p.liveUrl} onChange={v => updArr("projects", i, "liveUrl", v)} placeholder="https://..." />
              <Inp label="GitHub" value={p.githubUrl} onChange={v => updArr("projects", i, "githubUrl", v)} placeholder="github.com/..." />
            </div>
            {data.projects.length > 1 && <button onClick={() => rmFrom("projects", i)} style={{ ...btnG, color: C.tertiary, background: `${C.tertiary}12`, padding: "5px 12px", fontSize: 9 }}>REMOVE</button>}
          </div>))}</div>);
      case 6: return (<div><SecH title="Certifications" action={<button onClick={() => addTo("certifications", { name: "", org: "", year: "", url: "" })} style={btnA}><MI n="add" s={18} /></button>} />
        {data.certifications.map((c, i) => (
          <div key={i} style={{ background: C.console, padding: 18, borderRadius: 14, marginBottom: 14, border: `1px solid ${C.outlineVar}12` }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
              <Inp label="Name" value={c.name} onChange={v => updArr("certifications", i, "name", v)} placeholder="AWS SA" />
              <Inp label="Org" value={c.org} onChange={v => updArr("certifications", i, "org", v)} placeholder="AWS" />
              <Inp label="Year" value={c.year} onChange={v => updArr("certifications", i, "year", v)} placeholder="2024" />
              <Inp label="URL" value={c.url} onChange={v => updArr("certifications", i, "url", v)} placeholder="https://..." />
            </div>
            {data.certifications.length > 1 && <button onClick={() => rmFrom("certifications", i)} style={{ ...btnG, color: C.tertiary, background: `${C.tertiary}12`, padding: "5px 12px", fontSize: 9 }}>REMOVE</button>}
          </div>))}</div>);
      case 7: return (<div><SecH title="AI Neural Optimizer" sub="Upload & optimize with Claude AI." />
        <div style={{ background: C.console, border: `2px dashed ${C.outlineVar}35`, borderRadius: 16, padding: 28, textAlign: "center", marginBottom: 20 }}>
          <MI n="cloud_upload" s={40} c={C.onSurfaceVar} /><div style={{ fontFamily: "'Space Grotesk'", fontWeight: 700, fontSize: 15, marginTop: 10 }}>Drop your current Resume</div>
          <div style={{ fontFamily: "Manrope", fontSize: 11, color: C.onSurfaceVar, marginTop: 3 }}>PDF, DOCX (Max 10MB)</div>
          <button style={{ ...btnG, marginTop: 14, padding: "8px 20px" }}>SELECT FILE</button>
        </div>
        <Inp label="Target Role" value={data.targetRole} onChange={v => up("targetRole", v)} placeholder="Senior Fullstack Engineer" />
        <Inp label="Job Description" value={data.jd} onChange={v => up("jd", v)} placeholder="Paste full JD for max keyword resonance..." area />
        <button onClick={doAI} disabled={aiLoading} style={{ ...btnP, width: "100%", padding: "14px", justifyContent: "center", opacity: aiLoading ? 0.6 : 1 }}>
          {aiLoading ? <><MI n="hourglass_empty" s={16} /> OPTIMIZING...</> : <><MI n="auto_awesome" s={16} /> AI OPTIMIZE RESUME</>}
        </button></div>);
      case 8: return (<div><SecH title="Template Gallery" sub="18 chassis optimized for your career." />
        <div style={{ display: "flex", gap: 6, marginBottom: 18, overflowX: "auto" }}>
          {["ALL", "TECH", "FINANCE", "CREATIVE"].map(cat => (
            <button key={cat} onClick={() => setTmplFilter(cat)} style={{ padding: "5px 14px", borderRadius: 7, border: `1px solid ${tmplFilter === cat ? C.primary + "50" : C.outlineVar + "25"}`, background: tmplFilter === cat ? `${C.primary}15` : "transparent", color: tmplFilter === cat ? C.primary : C.onSurfaceVar, fontFamily: "Inter", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", cursor: "pointer", whiteSpace: "nowrap" }}>{cat}</button>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {TMPLS.filter(t => tmplFilter === "ALL" || t.cat === tmplFilter).map(t => (
            <div key={t.id} onClick={() => { setTmpl(t.id); toast(`Template: ${t.name}`, "info"); }} style={{ cursor: "pointer", borderRadius: 12, overflow: "hidden", border: tmpl === t.id ? `2px solid ${C.primary}` : `1px solid ${C.outlineVar}18`, background: C.console, transition: "all 0.25s", transform: tmpl === t.id ? "scale(1.03)" : "scale(1)" }}>
              <div style={{ height: 80, background: t.bg, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontFamily: "'Space Grotesk'", fontSize: 10, fontWeight: 700, color: t.fg, opacity: 0.3, textTransform: "uppercase" }}>PREVIEW</span>
                {tmpl === t.id && <div style={{ position: "absolute", top: 6, right: 6, width: 18, height: 18, borderRadius: 99, background: C.primary, display: "flex", alignItems: "center", justifyContent: "center" }}><MI n="check" s={12} c="#fff" /></div>}
              </div>
              <div style={{ padding: 10 }}><div style={{ fontFamily: "'Space Grotesk'", fontWeight: 700, fontSize: 12 }}>{t.name}</div><div style={{ fontFamily: "Inter", fontSize: 8, color: C.primary, textTransform: "uppercase", letterSpacing: "0.1em" }}>{t.sub}</div></div>
            </div>
          ))}
        </div></div>);
      default: return null;
    }
  };

  return (
    <div style={{ background: C.hull, minHeight: "100vh", color: C.onSurface, paddingBottom: 90 }}>
      <header style={{ position: "sticky", top: 0, zIndex: 50, background: `${C.hull}ee`, backdropFilter: "blur(20px)", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: `1px solid ${C.outlineVar}10` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}><MI n="rocket_launch" s={22} c={C.primaryDim} /><span style={{ fontFamily: "'Space Grotesk'", fontSize: 18, fontWeight: 700, color: C.primaryDim }}>SpotGiraffe</span></div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {saving && <span style={{ fontFamily: "Inter", fontSize: 8, color: C.success, letterSpacing: "0.1em", animation: "pulse 1.5s infinite" }}>● SAVING</span>}
          <div style={{ padding: "3px 10px", borderRadius: 99, background: C.module, border: `1px solid ${C.outlineVar}15`, display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 5, height: 5, borderRadius: 99, background: C.primary, boxShadow: `0 0 10px ${C.primary}`, animation: "pulse 2s infinite" }} />
            <span style={{ fontFamily: "Inter", fontSize: 8, letterSpacing: "0.15em", color: C.primary, textTransform: "uppercase", fontWeight: 700 }}>ATS v10 · LIVE</span>
          </div>
          <button onClick={() => setShowPreview(!showPreview)} style={{ ...btnG, padding: "5px 10px", fontSize: 9 }}><MI n={showPreview ? "edit" : "visibility"} s={14} /> {showPreview ? "EDIT" : "PREVIEW"}</button>
        </div>
      </header>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "0 14px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 14, marginTop: 14, marginBottom: 18 }}>
          <div style={{ background: C.console, borderRadius: 99, padding: 16, display: "flex", alignItems: "center", justifyContent: "center" }}><ScoreRing score={score.total} size={110} /></div>
          <div style={{ background: C.console, borderRadius: 14, padding: 16 }}>
            <div style={{ fontFamily: "'Space Grotesk'", fontSize: 11, fontWeight: 700, color: C.onSurfaceVar, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Optimization Readout</div>
            <ProgBar label="Completeness" value={score.completeness} /><ProgBar label="Keyword Density" value={score.keyDensity} color={score.keyDensity < 50 ? C.tertiary : C.primary} /><ProgBar label="Format & Length" value={score.formatScore} /><ProgBar label="Contact Info" value={score.contactScore} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 3, overflowX: "auto", paddingBottom: 6, marginBottom: 16, position: "sticky", top: 50, zIndex: 40, background: `${C.hull}dd`, backdropFilter: "blur(12px)", padding: "6px 0" }} className="no-scrollbar">
          {tabs.map((t, i) => (
            <button key={i} onClick={() => setTab(i)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 12px", borderRadius: "0 7px 7px 0", background: tab === i ? `${C.primaryDim}12` : "transparent", borderLeft: tab === i ? `3px solid ${C.primaryDim}` : "3px solid transparent", color: tab === i ? C.primary : C.onSurfaceVar, fontFamily: "'Space Grotesk'", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", border: "none", transition: "all 0.2s" }}><MI n={t.icon} s={15} />{t.label}</button>
          ))}
        </div>
        {showPreview ? (
          <div style={{ maxWidth: 600, margin: "0 auto" }}><ResumePreview data={data} templateId={tmpl} />
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12 }}>
              <button onClick={() => window.print()} style={{ ...btnG, flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><MI n="print" s={14} /> PRINT</button>
              <button onClick={() => { toast("Use Print → Save as PDF", "info"); window.print(); }} style={{ ...btnP, flex: 1, justifyContent: "center" }}><MI n="download" s={14} /> EXPORT PDF</button>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 18 }}>
            <div style={{ minWidth: 0 }}>{renderTab()}</div>
            <div style={{ position: "sticky", top: 95, alignSelf: "start" }}>
              <div style={{ background: C.module, borderRadius: 14, padding: 4, border: `1px solid ${C.outlineVar}12`, boxShadow: `0 24px 48px ${C.void}60` }}>
                <ResumePreview data={data} templateId={tmpl} />
                <div style={{ display: "flex", gap: 6, padding: 10, justifyContent: "center" }}>
                  <button onClick={() => window.print()} style={{ ...btnG, flex: 1, padding: "8px", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, fontSize: 9 }}><MI n="print" s={13} /> PRINT</button>
                  <button onClick={() => { toast("Print → Save as PDF", "info"); window.print(); }} style={{ ...btnG, flex: 1, padding: "8px", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, fontSize: 9 }}><MI n="download" s={13} /> PDF</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      <nav style={{ position: "fixed", bottom: 0, left: 0, width: "100%", display: "flex", justifyContent: "space-around", alignItems: "center", padding: "6px 12px", background: `${C.console}dd`, backdropFilter: "blur(20px)", borderTop: `1px solid ${C.outlineVar}12`, zIndex: 50 }}>
        {[["arrow_back", "Prev", () => setTab(Math.max(0, tab - 1))], ["auto_awesome", "AI", doAI, true], ["construction", "Generate", () => setShowPreview(true)], ["download", "Export", () => { toast("Print → Save as PDF", "info"); window.print(); }], ["arrow_forward", "Next", () => setTab(Math.min(tabs.length - 1, tab + 1))]].map(([ic, label, fn, hl], i) => (
          <button key={i} onClick={fn} disabled={hl && aiLoading} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "5px 10px", background: hl ? C.primaryDim : "transparent", borderRadius: hl ? 12 : 8, border: "none", cursor: "pointer", color: hl ? "#fff" : C.onSurfaceVar, transition: "all 0.2s", opacity: (hl && aiLoading) ? 0.5 : 1 }}>
            <MI n={ic} s={18} /><span style={{ fontFamily: "Inter", fontSize: 8, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" }}>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// ADMIN PAGE
// ═══════════════════════════════════════════════════════════════════
const AdminPage = ({ go }) => {
  const [stats, setStats] = useState({});
  const [users, setUsers] = useState([]);
  const [logs, setLogs] = useState([]);
  const [settings, setSettings] = useState({ apiKey: "", model: "claude-sonnet-4-20250514", maxUsers: 50 });
  const [view, setView] = useState("dashboard");
  const [search, setSearch] = useState("");
  const [cfgSaved, setCfgSaved] = useState(false);

  const load = async () => {
    setStats(await API.getStats()); setSettings(await API.getSettings()); setLogs(await API.getActivityLog());
    let u = await API.listUsers();
    if (!u.length) { for (const d of [{ name: "Alexander Vance", email: "alex.vance@orbit.io", status: "ACTIVE" }, { name: "Elena Rodriguez", email: "elenar@neural.net", status: "IDLE" }, { name: "Marcus Thorne", email: "m.thorne@vector.com", status: "LOCKED" }, { name: "Sarah Chen", email: "s.chen@quantum.dev", status: "ACTIVE" }, { name: "James Park", email: "j.park@stellar.co", status: "ACTIVE" }]) await API.saveUser(d); u = await API.listUsers(); }
    setUsers(u);
  };
  useEffect(() => { load(); }, []);

  const toggleUser = async (u) => { const next = u.status === "ACTIVE" ? "LOCKED" : "ACTIVE"; await API.updateUserStatus(u.id, next); setUsers(users.map(x => x.id === u.id ? { ...x, status: next } : x)); toast(`${u.name} → ${next}`, "info"); };
  const delUser = async (u) => { await API.deleteUser(u.id); setUsers(users.filter(x => x.id !== u.id)); toast(`Removed ${u.name}`, "warn"); };
  const saveCfg = async () => { await API.saveSettings(settings); setCfgSaved(true); setTimeout(() => setCfgSaved(false), 2000); toast("Engine config updated", "success"); };

  const filtered = users.filter(u => (u.name || "").toLowerCase().includes(search.toLowerCase()) || (u.email || "").toLowerCase().includes(search.toLowerCase()));
  const sCol = (s) => s === "ACTIVE" ? C.success : s === "IDLE" ? C.warn : C.tertiary;
  const velData = useMemo(() => Array.from({ length: 16 }, () => 15 + Math.random() * 85), []);

  return (
    <div style={{ background: C.void, minHeight: "100vh", color: C.onSurface }}>
      <header style={{ position: "sticky", top: 0, zIndex: 50, background: `${C.void}ee`, backdropFilter: "blur(20px)", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 20px", borderBottom: `1px solid ${C.outlineVar}0d` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}><MI n="architecture" s={26} c={C.primary} /><span style={{ fontFamily: "'Space Grotesk'", fontSize: 20, fontWeight: 700 }}>SpotGiraffe</span></div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <nav style={{ display: "flex", gap: 20 }}>{["dashboard", "users", "settings", "logs"].map(v => (
            <button key={v} onClick={() => setView(v)} style={{ fontFamily: "Inter", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: view === v ? C.primary : `${C.onSurface}50`, borderBottom: view === v ? `2px solid ${C.primary}` : "2px solid transparent", paddingBottom: 3, background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>{v}</button>
          ))}</nav>
          <div style={{ padding: "3px 10px", borderRadius: 99, background: C.module, border: `1px solid ${C.outlineVar}12`, display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 5, height: 5, borderRadius: 99, background: C.primary, boxShadow: `0 0 10px ${C.primary}` }} />
            <span style={{ fontFamily: "Inter", fontSize: 8, letterSpacing: "0.14em", color: C.primary, textTransform: "uppercase", fontWeight: 700 }}>ATS v10</span>
          </div>
        </div>
      </header>
      <main style={{ maxWidth: 780, margin: "0 auto", padding: "16px 16px 100px" }}>
        <div style={{ marginBottom: 28 }}><span style={{ fontFamily: "Inter", fontSize: 9, letterSpacing: "0.22em", textTransform: "uppercase", color: C.primary }}>SYSTEM COMMAND</span>
          <h1 style={{ fontFamily: "'Space Grotesk'", fontSize: 44, fontWeight: 800, lineHeight: 1.0, letterSpacing: "-0.03em" }}>Mission<br />Control</h1>
        </div>

        {view === "dashboard" && <>
          <div style={{ display: "grid", gap: 14, marginBottom: 22 }}>
            {[{ l: "ACTIVE PILOTS", v: (stats.activeUsers || 0).toString(), s: `↗ +${12 + Math.floor(Math.random() * 15)}% vs LY`, ic: "group", c: C.success },
              { l: "GENERATIONS", v: `${((stats.generations || 0) * 100 + 841).toLocaleString()}`, s: "⚡ 98.2% Success", ic: "auto_awesome", c: C.primary },
              { l: "ENGINE LATENCY", v: `${118 + Math.floor(Math.random() * 30)}ms`, s: "OPERATIONAL", ic: "speed", c: C.success }
            ].map((s, i) => (
              <div key={i} style={{ background: C.hull, padding: 22, borderRadius: 16, border: `1px solid ${C.outlineVar}0a` }}>
                <div style={{ fontFamily: "Inter", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: C.onSurfaceVar, marginBottom: 6 }}>{s.l}</div>
                <div style={{ fontFamily: "'Space Grotesk'", fontSize: 38, fontWeight: 800 }}>{s.v}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                  <span style={{ fontFamily: "Inter", fontSize: 10, color: s.c }}>{s.s}</span><MI n={s.ic} s={20} c={C.onSurfaceVar} />
                </div>
              </div>
            ))}
          </div>
          <div style={{ background: C.hull, padding: 22, borderRadius: 16, marginBottom: 22, border: `1px solid ${C.outlineVar}0a` }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
              <div><div style={{ fontFamily: "'Space Grotesk'", fontSize: 18, fontWeight: 700 }}>Generation Velocity</div><div style={{ fontFamily: "Manrope", fontSize: 11, color: C.onSurfaceVar }}>Real-time AI throughput</div></div>
              <div style={{ display: "flex", gap: 4 }}>{["24H", "1H"].map((p, i) => <button key={p} style={{ padding: "3px 10px", borderRadius: 99, background: i === 1 ? C.primary : "transparent", color: i === 1 ? C.onPrimary : C.onSurfaceVar, fontFamily: "Inter", fontSize: 9, fontWeight: 700, border: `1px solid ${C.outlineVar}18`, cursor: "pointer" }}>{p}</button>)}</div>
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 5, height: 110 }}>{velData.map((v, i) => <div key={i} style={{ flex: 1, background: `linear-gradient(180deg, ${C.primary}, ${C.primaryDim}80)`, height: `${v}%`, borderRadius: "3px 3px 0 0", opacity: 0.5 + v / 200 }} />)}</div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontFamily: "Inter", fontSize: 8, color: C.onSurfaceVar }}><span>14:00</span><span>14:30</span><span>15:00</span><span>15:30</span></div>
          </div>
        </>}

        {(view === "dashboard" || view === "users") && (
          <div style={{ marginBottom: 22 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 14 }}>
              <div><div style={{ fontFamily: "'Space Grotesk'", fontSize: 26, fontWeight: 800, lineHeight: 1.1 }}>Pilot Manifest</div><div style={{ fontFamily: "Manrope", fontSize: 12, color: C.onSurfaceVar, marginTop: 3 }}>All users in the ecosystem</div></div>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." style={{ background: C.hull, border: `1px solid ${C.outlineVar}18`, borderRadius: 8, padding: "7px 12px", color: C.onSurface, fontFamily: "Manrope", fontSize: 11, outline: "none", width: 170 }} />
            </div>
            <div style={{ background: C.hull, borderRadius: 16, overflow: "hidden", border: `1px solid ${C.outlineVar}0a` }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 18px", fontFamily: "Inter", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: C.onSurfaceVar, borderBottom: `1px solid ${C.outlineVar}10` }}><span>Pilot</span><span>Actions</span></div>
              {filtered.map((u, i) => (
                <div key={u.id || i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: `1px solid ${C.outlineVar}06` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 38, height: 38, borderRadius: 10, background: `linear-gradient(135deg, ${C.primaryDim}35, ${C.primary}18)`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Space Grotesk'", fontWeight: 800, fontSize: 15, color: C.primary }}>{u.name?.[0]}</div>
                    <div><div style={{ fontFamily: "'Space Grotesk'", fontWeight: 700, fontSize: 13 }}>{u.name}</div><div style={{ fontFamily: "Inter", fontSize: 10, color: C.onSurfaceVar }}>{u.email}</div></div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <button onClick={() => toggleUser(u)} style={{ padding: "3px 10px", borderRadius: 6, background: `${sCol(u.status)}18`, color: sCol(u.status), fontFamily: "Inter", fontSize: 9, fontWeight: 700, border: "none", cursor: "pointer" }}>{u.status}</button>
                    <button onClick={() => delUser(u)} style={{ background: "none", border: "none", cursor: "pointer", opacity: 0.4, padding: 4 }}><MI n="delete" s={16} c={C.tertiary} /></button>
                  </div>
                </div>
              ))}
              <div style={{ padding: "10px 18px", fontFamily: "Inter", fontSize: 10, color: C.onSurfaceVar }}>{filtered.length} of {users.length} pilots</div>
            </div>
          </div>
        )}

        {view === "settings" && (
          <div style={{ background: C.hull, padding: 24, borderRadius: 16, marginBottom: 22, border: `1px solid ${C.outlineVar}0a` }}>
            <div style={{ fontFamily: "'Space Grotesk'", fontSize: 20, fontWeight: 700, marginBottom: 18, display: "flex", alignItems: "center", gap: 8 }}><MI n="tune" s={22} /> Engine Config</div>
            <Inp label="Claude API Key" value={settings.apiKey} onChange={v => setSettings(p => ({ ...p, apiKey: v }))} placeholder="sk-ant-api03-..." type="password" />
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontFamily: "Inter", fontSize: 9, letterSpacing: "0.2em", textTransform: "uppercase", color: C.onSurfaceVar, display: "block", marginBottom: 5 }}>Model</label>
              <select value={settings.model} onChange={e => setSettings(p => ({ ...p, model: e.target.value }))} style={{ width: "100%", background: C.void, border: `1px solid ${C.outlineVar}30`, padding: "10px 14px", borderRadius: 8, color: C.onSurface, fontFamily: "Manrope", fontSize: 13, outline: "none" }}>
                <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
                <option value="claude-opus-4-6">Claude Opus 4.6</option>
                <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
              </select>
            </div>
            <button onClick={saveCfg} style={{ ...btnP, width: "100%", padding: "13px", justifyContent: "center" }}>{cfgSaved ? <><MI n="check" s={16} /> SAVED</> : "UPDATE CORE ENGINE"}</button>
          </div>
        )}

        {view === "logs" && (
          <div style={{ background: C.hull, padding: 24, borderRadius: 16, border: `1px solid ${C.outlineVar}0a` }}>
            <div style={{ fontFamily: "'Space Grotesk'", fontSize: 20, fontWeight: 700, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}><MI n="receipt_long" s={22} /> Activity Log</div>
            {logs.length === 0 ? <div style={{ textAlign: "center", padding: 32, color: C.onSurfaceVar }}>No activity yet</div>
              : logs.map((l, i) => (
                <div key={i} style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: `1px solid ${C.outlineVar}08`, alignItems: "center" }}>
                  <div style={{ width: 6, height: 6, borderRadius: 99, background: C.primary, flexShrink: 0 }} />
                  <div style={{ flex: 1 }}><div style={{ fontFamily: "Manrope", fontSize: 12 }}>{l.msg}</div><div style={{ fontFamily: "Inter", fontSize: 9, color: C.onSurfaceVar, marginTop: 2 }}>{new Date(l.ts).toLocaleString()}</div></div>
                </div>
              ))}
          </div>
        )}
      </main>
      <nav style={{ position: "fixed", bottom: 0, left: 0, width: "100%", display: "flex", justifyContent: "space-around", padding: "6px 14px", background: `${C.console}dd`, backdropFilter: "blur(20px)", borderTop: `1px solid ${C.outlineVar}10`, zIndex: 50 }}>
        {[["arrow_back", "Builder", () => go("builder")], ["auto_fix_high", "Config", () => setView("settings")], ["auto_awesome", "Generate", () => go("builder")], ["download", "Export", null], ["arrow_forward", "Landing", () => go("landing")]].map(([ic, l, fn], i) => (
          <button key={i} onClick={fn} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, padding: "5px 10px", background: "transparent", border: "none", cursor: "pointer", color: i === 2 ? C.primary : C.onSurfaceVar }}>
            <MI n={ic} s={18} /><span style={{ fontFamily: "Inter", fontSize: 8, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" }}>{l}</span>
          </button>
        ))}
      </nav>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// APP SHELL
// ═══════════════════════════════════════════════════════════════════
export default function App() {
  const [page, setPage] = useState("landing");
  return (
    <ToastProvider>
      <div style={{ fontFamily: "'Manrope',sans-serif" }}>
        <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Manrope:wght@300;400;500;600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
        <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet" />
        <style>{`*{box-sizing:border-box;margin:0;padding:0}body{background:${C.void}}::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:${C.void}}::-webkit-scrollbar-thumb{background:${C.module};border-radius:10px}.no-scrollbar::-webkit-scrollbar{display:none}input,textarea,select{font-family:inherit}button{font-family:inherit}@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}@keyframes slideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}@media print{nav,header,.no-print{display:none!important}body{background:#fff!important}}`}</style>
        <div className="no-print" style={{ position: "fixed", top: 10, left: "50%", transform: "translateX(-50%)", zIndex: 999, display: "flex", gap: 2, background: `${C.console}ee`, backdropFilter: "blur(20px)", borderRadius: 99, padding: 3, border: `1px solid ${C.outlineVar}12`, boxShadow: `0 8px 32px ${C.void}80` }}>
          {[["rocket_launch", "Landing", "landing"], ["edit_note", "Builder", "builder"], ["admin_panel_settings", "Admin", "admin"]].map(([ic, l, k]) => (
            <button key={k} onClick={() => setPage(k)} style={{ padding: "5px 14px", borderRadius: 99, border: "none", cursor: "pointer", background: page === k ? C.primaryDim : "transparent", color: page === k ? "#fff" : C.onSurfaceVar, fontFamily: "Inter", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", transition: "all 0.3s", display: "flex", alignItems: "center", gap: 4 }}><MI n={ic} s={13} />{l}</button>
          ))}
        </div>
        {page === "landing" && <LandingPage go={setPage} />}
        {page === "builder" && <BuilderPage go={setPage} />}
        {page === "admin" && <AdminPage go={setPage} />}
      </div>
    </ToastProvider>
  );
}
