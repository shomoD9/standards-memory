import { createServer, type Server } from "node:http";
import { Store, validateId } from "./store.js";

/** Start the local view. Port 0 lets the OS choose an available port. */
export async function startWeb(store: Store = new Store(), port = 4747): Promise<Server> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port (use 0–65535)");
  const server = createServer((req, res) => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (path === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(page);
        return;
      }
      const match = /^\/api\/(facts|history|undo)\/([^/]+)$/.exec(path);
      const expected = match?.[1] === "undo" ? "POST" : "GET";
      const known = !!match || ["/api/facts", "/api/graph", "/api/log"].includes(path);
      if (!known) return json(404, { error: "Not found" });
      if (req.method !== expected) {
        res.setHeader("Allow", expected);
        return json(405, { error: "Method not allowed" });
      }
      if (match) {
        const id = decodeURIComponent(match[2]);
        if (match[1] === "undo") {
          if (!/^[0-9a-f]{4,64}$/i.test(id)) return json(400, { error: "Invalid change id" });
          // A cross-origin form must not be able to mutate the local store.
          if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
            return json(403, { error: "Cross-origin undo is forbidden" });
          }
          try { return json(200, { change: store.undo(id) }); }
          catch (e) { return json(409, { error: (e as Error).message }); }
        }
        validateId(id);
        if (match[1] === "history") return json(200, store.history(id));
        const fact = store.get(id);
        return fact ? json(200, { ...fact, backlinks: store.links(id).incoming }) : json(404, { error: `No such fact: ${id}` });
      }
      if (path === "/api/facts") {
        const q = url.searchParams.get("q")?.trim();
        return json(200, q ? store.recall(q).map((hit) => hit.fact) : store.list());
      }
      if (path === "/api/graph") return json(200, store.graph());
      return json(200, store.log());
    } catch (e) {
      const message = (e as Error).message;
      json(e instanceof URIError || message.startsWith("Invalid fact id") ? 400 : 500, { error: message });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  return server;
}

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Memory</title>
<style>
body{font:16px system-ui;margin:0;background:#f5f7fa;color:#172334}header{padding:20px;background:#172334;color:white}main{display:grid;grid-template-columns:280px 1fr;gap:20px;padding:20px}section,aside{background:white;padding:20px;border-radius:8px;margin-bottom:20px}input{box-sizing:border-box;width:100%;padding:10px}button{cursor:pointer;padding:7px 12px;margin:4px}a{color:#2463b5;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}li{margin:10px 0}svg{width:100%;max-height:600px}#error{color:#b02020;padding:0 20px}small{color:#596879} @media(max-width:700px){main{grid-template-columns:1fr}}
</style></head><body><header><h1>Memory</h1></header><p id="error" role="alert"></p><main><aside><h2>Facts</h2><input id="search" aria-label="Search facts" placeholder="Search facts"><ul id="facts"></ul></aside><div><section id="detail"><h2>Select a fact</h2></section><section><h2>Graph</h2><svg id="graph" viewBox="0 0 700 700" role="img" aria-label="Fact links graph"></svg></section><section><h2>Recent changes</h2><div id="log"></div></section></div></main>
<script>
const $=id=>document.getElementById(id); let selected=null,searchVersion=0;
function el(tag,text){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;}
async function api(path,method='GET'){const r=await fetch(path,{method});const data=await r.json();if(!r.ok)throw Error(data.error);return data;}
function report(e){$('error').textContent=e.message;}
function stamp(f){if(f.kind!=='score')return null;try{const s=JSON.parse(f.content);return({pass:'pass',fail:'FAIL',na:'-'}[s.verdict]||s.verdict)+' v'+s.standardVersion+' · judge='+s.judge;}catch(e){return null;}}
function link(id){const a=el('a',id);a.href='#'+encodeURIComponent(id);a.onclick=e=>{e.preventDefault();show(id).catch(report);};return a;}
async function facts(){const version=++searchVersion;const data=await api('/api/facts?q='+encodeURIComponent($('search').value));if(version!==searchVersion)return;$('facts').replaceChildren();for(const f of data){const li=el('li');li.append(link(f.id));const st=stamp(f);if(st)li.append(document.createElement('br'),el('small',st));$('facts').append(li);}if(!data.length)$('facts').append(el('li','No facts found'));}
async function show(id){selected=id;const detail=$('detail');detail.replaceChildren(el('h2',id));const [f,h]=await Promise.all([api('/api/facts/'+encodeURIComponent(id)).catch(e=>({error:e.message})),api('/api/history/'+encodeURIComponent(id))]);if(selected!==id)return;if(f.error)detail.append(el('p',f.error));else{const st=stamp(f);if(st){const b=el('p',st);b.id='stamp';b.style.fontWeight='bold';detail.append(b);}detail.append(el('small','v'+(f.version||1)+' · '+f.author+' · '+f.timestamp),el('pre',f.content),el('p','Source: '+f.source),el('p','Tags: '+(f.tags||[]).join(', ')));for(const [label,ids] of [['Links',f.links],['Backlinks',f.backlinks]]){detail.append(el('h3',label));const p=el('p');for(const target of ids){p.append(link(target),document.createTextNode(' '));}if(!ids.length)p.textContent='None';detail.append(p);}}detail.append(el('h3','History'));for(const entry of h){const d=el('details');d.append(el('summary',entry.message+' · '+entry.author+' · '+entry.timestamp),el('pre',entry.fact?entry.fact.content:'Deleted'),el('small',entry.change));detail.append(d);}if(!h.length)detail.append(el('p','No history'));}
function svg(tag,attrs){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);return n;}
async function graph(){const g=await api('/api/graph'),root=$('graph');root.replaceChildren();const positions=new Map(g.nodes.map((n,i)=>{const a=2*Math.PI*i/g.nodes.length-Math.PI/2;return[n.id,{x:350+260*Math.cos(a),y:350+260*Math.sin(a)}];}));for(const edge of g.edges){const a=positions.get(edge.from),b=positions.get(edge.to);root.append(svg('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:'#aab8ca'}));}for(const n of g.nodes){const p=positions.get(n.id),a=svg('a',{href:'#'+encodeURIComponent(n.id)});a.onclick=e=>{e.preventDefault();show(n.id).catch(report);};a.append(svg('circle',{cx:p.x,cy:p.y,r:18,fill:n.exists?'#2463b5':'#aab8ca'}));const label=svg('text',{x:p.x,y:p.y+35,'text-anchor':'middle','font-size':13});label.textContent=n.id;a.append(label);root.append(a);}if(!g.nodes.length){const label=svg('text',{x:350,y:350,'text-anchor':'middle'});label.textContent='No facts yet';root.append(label);}}
async function log(){const entries=await api('/api/log');$('log').replaceChildren();for(const entry of entries){const row=el('p');row.append(el('span',entry.message+' · '+entry.author+' · '+entry.timestamp+' '),el('small',entry.change.slice(0,12)));const b=el('button','Undo');b.onclick=async()=>{b.disabled=true;try{await api('/api/undo/'+entry.change,'POST');$('error').textContent='';await refresh();}catch(e){report(e);b.disabled=false;}};row.append(b);$('log').append(row);}if(!entries.length)$('log').append(el('p','No changes yet'));}
async function refresh(){await Promise.all([facts(),graph(),log(),selected?show(selected):Promise.resolve()]);}
$('search').oninput=()=>facts().catch(report);refresh().catch(report);
</script></body></html>`;
