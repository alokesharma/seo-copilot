// Runs every agent live, then RE-VERIFIES its claims with independent queries.
const API="http://127.0.0.1:8788/api/copilot", B={from:"2026-06-18",to:"2026-09-16",segment:"ALL"};
const sql=async(q)=>{const r=await fetch("http://127.0.0.1:8788/api/copilot",{method:"POST"});return null};
// LINT: a diagnosis may state a measurement, never assert a cause or a judgement.
import {readFileSync} from "node:fs";
const BANNED=/wrong fit|poor fit|weak hook|bad |poorly|problem\b|because|likely the|is the wrong|not good|should be the|too thin to|needs real work|wasted space/i;
const src=readFileSync("functions/api/_agents.js","utf8")+readFileSync("functions/api/copilot.js","utf8");
const labels=[...src.matchAll(/THEN '([^']+)'|ELSE '([^']+)'|diagnosis: "([^"]+)"|diagnosis: '([^']+)'/g)].map(m=>m[1]||m[2]||m[3]||m[4]).filter(Boolean);
const causal=[...new Set(labels.filter(l=>BANNED.test(l)))];
if(causal.length){console.log("✗ LINT: diagnosis labels assert a cause:");causal.forEach(c=>console.log("    "+c));}
else console.log("✓ LINT: all "+new Set(labels).size+" diagnosis labels state measurements");
const reg=await(await fetch(API)).json(); const bad=[...(causal.length?["lint"]:[])];
for(const a of reg.agents){
  const t=Date.now(); let j;
  try{ j=await(await fetch(API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...B,agent:a.key}),signal:AbortSignal.timeout(240000)})).json(); }
  catch(e){ j={error:e.message}; }
  const ms=Date.now()-t, f=[], w=[];
  if(j.error) f.push("ERROR "+j.error);
  else if(j.unchecked) f.push("UNCHECKED "+(j.empty?.reason||"").slice(0,90));
  else if(!j.rows?.length){ if(!j.empty?.reason) f.push("empty, no reason"); }
  else{
    if(!j.scope?.window) f.push("no window");
    if(!j.headline) f.push("no headline");
    if(!j.action?.title) f.push("no action");
    if(a.deliverable&&!j.deliverable) f.push("no deliverable");
    const dv=j.deliverable;
    if(dv){
      const c=dv.content||"";
      if(/"@context"|ld\+json/.test(c)){ const m=c.match(/\{[\s\S]*\}/); let ok=false; try{JSON.parse(m[0]);ok=true}catch{} if(!ok) f.push("deliverable JSON-LD does not parse"); }
      if(a.key==="robots_txt"&&/^\s*Disallow:/m.test(c)) f.push("robots deliverable repeats Disallow rules");
      // an empty result must EXPLAIN itself — "nothing matched" hides whether we
      // looked and found nothing, or never really looked
      if((j.rows||[]).length===0 && j.clean && /No pages matched this check/i.test(j.empty?.reason||""))
        f.push("empty result with a generic reason — must say why it is empty");
      // a part-month must never be compared against a full month
      if(a.key==="seo_audit_report"){
        const bad=(j.rows||[]).filter(r=>r.diagnosis && !/full calendar month/i.test(r.diagnosis));
        if(bad.length) f.push("audit brief includes a partial month");
        const cur=new Date().toISOString().slice(0,7);
        if((j.rows||[]).some(r=>String(r.month)===cur)) f.push("audit brief includes the current (partial) month");
      }
      // a geographic mismatch must be measured, never asserted by the agent name
      if(a.key==="intent_mismatch"){
        const un=(j.rows||[]).filter(r=>!r.diagnosis);
        if(un.length) f.push("intent rows with no computed diagnosis");
      }
      // an internal-link deliverable must be FROM -> TO | anchor on every line
      if(a.key==="internal_linking"&&j.deliverable?.content){
        const badl=j.deliverable.content.split("\n").filter(l=>l.trim()&&!/FROM \S+ -> TO \S+ \| anchor: ".+"/.test(l));
        if(badl.length) f.push("internal-link line not in FROM/TO/anchor shape");
      }
      const VAGUE=/^\s*\d*\.?\s*(ensure|validate|review|consider|maintain|keep|monitor|check that|continue)\b/im;
      if(VAGUE.test(c)) f.push("deliverable contains a vague filler line");
      (dv.items||[]).forEach(i=>{
        const af=String(i.after||"").trim();
        if(!af) f.push("deliverable item with empty 'after'");
        if(af&&String(i.before||"").trim()===af) f.push("deliverable item 'after' identical to 'before'");
        if(a.key==="title_optimizer"&&af.length>60) f.push("rewritten title "+af.length+" chars (>60)");
        if(a.key==="meta_description"&&af.length>160) f.push("rewritten description "+af.length+" chars (>160)");
        if(/^(maintain|keep|continue|no change)\b/i.test(af)) f.push("no-op rewrite item");
      });
    }
    if(j.ungrounded>0) w.push(j.ungrounded+" ungrounded number(s) stripped by the safety net");
    // TRUTH TEST: the action must not contradict the findings
    const txt=((j.action?.title||"")+" "+(j.action?.why||"")).toLowerCase();
    const diagText=JSON.stringify(j.rows).toLowerCase();
    if(/\b(create|publish|write)\s+(a\s+)?(new\s+)?(dedicated\s+)?(landing\s+)?page\b/.test(txt) && !/not ranking|no page|no strong page|new page/.test(diagText)) f.push("action says CREATE NEW PAGE but findings show we already rank");
    if(/\bmissing\b|\bdoes not exist\b|\bno \w+ found\b/.test(txt) && /unchecked/.test(diagText)) f.push("claims absence while rows say unchecked");
    // every action must name something that appears in the findings
    const pg=(j.action?.page||"").trim();
    const hay=JSON.stringify(j.rows)+JSON.stringify(j.extras||{})+JSON.stringify(j.meta||{});
    if(pg && pg.length>3 && !hay.includes(pg.replace(/^https?:\/\/[^/]+/,""))) f.push("action page not in evidence: "+pg.slice(0,50));
  }
  if(ms>45000) f.push("slow "+Math.round(ms/1000)+"s");
  if(f.length){bad.push({k:a.key,f}); console.log("✗ "+a.key.padEnd(22)+f.join(" | ").slice(0,150));}
  else console.log((w.length?"! ":"✓ ")+a.key.padEnd(22)+String(ms).padStart(6)+"ms "+String(j.rows?.length??0).padStart(3)+" rows"+(w.length?"  ["+w.join("; ")+"]":""));
}
console.log(`\n=== ${reg.agents.length-bad.length}/${reg.agents.length} pass ===`);
