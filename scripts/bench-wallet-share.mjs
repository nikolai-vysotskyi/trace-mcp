#!/usr/bin/env node
// Where does the money in a Claude Code session actually go? (TRA-wallet-share)
//
//   node scripts/bench-wallet-share.mjs ~/.claude/projects
//
// Every published trace-mcp saving is a share of TOOL OUTPUT. A subscription is
// billed on the whole prompt, re-sent on every request. This script measures the
// gap between those two things on real transcripts, so no one has to guess it.
//
// Method: for each API request take its REAL billed input
// (input + 2x cache_creation + 0.1x cache_read, the $3/M Sonnet mix) and split it
// across the classes actually present in that request's context, in proportion to
// their token mass. Message mass is estimated from characters with a per-class
// chars/token ratio calibrated against gpt-tokenizer o200k on a 15% sample.
// Whatever the prompt bills beyond the message mass is the fixed surface: system
// prompt plus tool definitions. That residual is an UPPER bound (it absorbs every
// estimation error), so the tool-output shares below are a LOWER bound.
//
// Two things are easy to get wrong, both inflate the residual by an order of
// magnitude: one API request is logged as several records (dedupe by requestId),
// and injected context (skill listings, tool-list deltas, CLAUDE.md, hook output)
// lives in `attachment` records, not in message.content.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const root=process.argv[2]; const files=[];
(function walk(d){for(const e of readdirSync(d,{withFileTypes:true})){const p=join(d,e.name); if(e.isDirectory())walk(p); else if(e.name.endsWith('.jsonl'))files.push(p);}})(root);
const rt=JSON.parse(readFileSync('docs/_data/response_tokens.json','utf8'));
const ratio={}; for(const r of rt.rows) ratio[r.tool]= r.measured_per_call>0 ? r.baseline_per_call/r.measured_per_call : 1;
const CH={native_read:3.39,other_mcp:3.23,trace:3.70,other_tool:3.65,task:3.65,tool_use_args:3.27,assistant_text:3.16,thinking:4.39,user_text:4.13};
const IMG=1500; const NATIVE=new Set(['Read','Bash','Grep','Glob','NotebookRead','LS']);
const cls=n=>!n?'other_tool':n.startsWith('mcp__trace-mcp__')?'trace':NATIVE.has(n)?'native_read':n.startsWith('mcp__')?'other_mcp':n==='Task'?'task':'other_tool';
const KEYS=Object.keys(CH);
let billedIn=0,billedOut=0,reqs=0,sysTok=0,sysCost=0;
const cost={}, callTok={}, calls={};
for(const f of files){
  let raw; try{raw=readFileSync(f,'utf8')}catch{continue}
  const recs=[]; for(const l of raw.split('\n')){if(!l)continue; try{recs.push(JSON.parse(l))}catch{}}
  const byUuid=new Map(); for(const d of recs) if(d.uuid) byUuid.set(d.uuid,d);
  const tn=new Map(); for(const d of recs){const c=d.message?.content; if(Array.isArray(c))for(const b of c)if(b.type==='tool_use')tn.set(b.id,b.name);}
  const own=new Map();
  for(const d of recs){
    const c=d.message?.content; const v={}; const blocks=Array.isArray(c)?c:typeof c==='string'?[{type:'text',text:c}]:[];
    const put=(k,t)=>{v[k]=(v[k]||0)+t;};
    for(const b of blocks){
      if(b.type==='tool_result'){ const name=tn.get(b.tool_use_id); const g=cls(name);
        const key = g==='trace' ? 'trace:'+name.replace('mcp__trace-mcp__','') : g==='native_read' ? 'native:'+name : g;
        let t=0;
        if(Array.isArray(b.content)){ for(const x of b.content){ if(x.type==='image') t+=IMG; else if(x.type==='text') t+=(x.text||'').length/CH[g]; } }
        else t=String(b.content??'').length/CH[g];
        put(key,t); if(g==='trace'){calls[key]=(calls[key]||0)+1;}
      }
      else if(b.type==='text'){const k=d.type==='user'?'user_text':'assistant_text'; put(k,(b.text||'').length/CH[k]);}
      else if(b.type==='thinking') put('thinking',(b.thinking||'').length/CH.thinking);
      else if(b.type==='tool_use') put('tool_use_args',JSON.stringify(b.input??'').length/CH.tool_use_args);
    }
    if(d.attachment){ const t=d.attachment.type||'?'; const s=JSON.stringify(d.attachment).length/3.6;
      const g = (t==='skill_listing'||t==='deferred_tools_delta'||t==='mcp_instructions_delta'||t==='agent_listing_delta'||t==='mcp_dropped_tools_delta') ? 'inj:tool_and_skill_listings'
        : (t==='nested_memory'||t==='file'||t==='edited_text_file'||t==='compact_file_reference') ? 'inj:files_and_memory'
        : t.startsWith('hook') ? 'inj:hooks' : 'inj:reminders_other';
      put(g,s); }
    own.set(d,v);
  }
  const cum=new Map();
  const cumOf=(d,depth=0)=>{ if(!d||depth>10000) return {};
    if(cum.has(d))return cum.get(d); const p=cumOf(byUuid.get(d.parentUuid),depth+1); const o=own.get(d)||{};
    const v={...p}; for(const k in o) v[k]=(v[k]||0)+o[k]; cum.set(d,v); return v; };
  const seen=new Set();
  for(const d of recs){
    if(d.type!=='assistant'||!d.requestId||seen.has(d.requestId))continue;
    const u=d.message?.usage; if(!u||typeof u.cache_read_input_tokens!=='number')continue;
    seen.add(d.requestId); reqs++;
    const prefix=(u.input_tokens||0)+(u.cache_creation_input_tokens||0)+(u.cache_read_input_tokens||0);
    const c$=((u.input_tokens||0)+2*(u.cache_creation_input_tokens||0)+0.1*(u.cache_read_input_tokens||0))*3/1e6;
    billedIn+=c$; billedOut+=(u.output_tokens||0)*15/1e6;
    const c=cumOf(byUuid.get(d.parentUuid)); let msg=0; for(const k in c) msg+=c[k];
    const sys=Math.max(0,prefix-msg); const tot=msg+sys; if(tot<=0)continue;
    for(const k in c){ cost[k]=(cost[k]||0)+c$*c[k]/tot; callTok[k]=(callTok[k]||0)+c[k]; }
    sysCost+=c$*sys/tot; sysTok+=sys;
  }
}
const traceCost=Object.entries(cost).filter(([k])=>k.startsWith('trace:')).reduce((a,[,v])=>a+v,0);
const total=Object.values(cost).reduce((a,b)=>a+b,0)+sysCost;
console.log(`requests ${reqs} billedInput $${billedIn.toFixed(0)} output $${billedOut.toFixed(0)}`);
console.log(`avg system+tooldefs prefix per request: ${(sysTok/reqs).toFixed(0)} tokens, cost $${sysCost.toFixed(0)} (${(sysCost/total*100).toFixed(1)}% of input)`);
console.log(`trace tool results: cost $${traceCost.toFixed(2)} (${(traceCost/total*100).toFixed(2)}% of input)`);
const grouped={};
for(const [k,v] of Object.entries(cost)) grouped[k.startsWith('trace:')?'trace_mcp_results':k]=(grouped[k.startsWith('trace:')?'trace_mcp_results':k]||0)+v;
grouped['system_prompt_and_tool_defs']=sysCost;
console.log('\nclass                            cost$   %input  %in+out');
for(const [k,v] of Object.entries(grouped).sort((a,b)=>b[1]-a[1]))
  console.log(' ',k.padEnd(30), v.toFixed(0).padStart(6), ((v/total)*100).toFixed(1).padStart(6)+'%', ((v/(total+billedOut))*100).toFixed(1).padStart(7)+'%');
console.log(' ','output'.padEnd(30), billedOut.toFixed(0).padStart(6),'      -',((billedOut/(total+billedOut))*100).toFixed(1).padStart(7)+'%');
console.log('\nper trace tool: calls, attributed $, baseline/measured ratio');
let cfExtra=0, unknown=0;
for(const [k,v] of Object.entries(cost).filter(([k])=>k.startsWith('trace:')).sort((a,b)=>b[1]-a[1])){
  const t=k.slice(6); const r=ratio[t]; if(r===undefined) unknown+=v;
  const rr=r??1; cfExtra+=v*(rr-1);
  console.log('  ',t.padEnd(28), String(calls[k]||0).padStart(5), v.toFixed(2).padStart(7), (r!==undefined?rr.toFixed(2):'n/a').padStart(6));
}
console.log(`\ncounterfactual extra if those calls were file reads instead: +$${cfExtra.toFixed(0)} (unpriced tools $${unknown.toFixed(2)})`);
for(const DEF of [45000,25000,12000]){
  const share=Math.min(1,DEF/(sysTok/reqs));
  const defCost=sysCost*share;
  const without=total - traceCost - defCost + traceCost + cfExtra;
  console.log(`tool-defs ${DEF} tok -> defs cost $${defCost.toFixed(0)}; without trace-mcp input would be $${without.toFixed(0)} vs $${total.toFixed(0)}  => saving ${(100*(without-total)/without).toFixed(1)}% of input, ${(100*(without-total)/(without+billedOut)).toFixed(1)}% of input+output`);
}
