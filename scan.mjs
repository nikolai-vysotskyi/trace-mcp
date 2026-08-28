import {readdirSync,readFileSync,statSync} from 'fs';
import {join} from 'path';
const pat=new RegExp(process.argv[3]);
function walk(d){for(const e of readdirSync(d)){if(e==='node_modules'||e==='.git'||e==='dist')continue;const p=join(d,e);const s=statSync(p);if(s.isDirectory())walk(p);else if(/\.(ts|js)$/.test(e)){const L=readFileSync(p,'utf8').split('\n');L.forEach((l,i)=>{if(pat.test(l))console.log(`${p}:${i+1}: ${l.trim().slice(0,200)}`)});}}}
walk(process.argv[2]);
