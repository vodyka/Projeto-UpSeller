import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';

const app=express();
app.disable('x-powered-by');
app.use(express.json({limit:'4mb'}));
const pool=process.env.DATABASE_URL?new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:5}):null;
const ACCOUNT='30945';
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
function auth(req,res,next){
 const h=req.headers.authorization||'';
 const isBridge=req.path.startsWith('/api/bridge/');
 const wanted=isBridge?process.env.BRIDGE_TOKEN:process.env.ADMIN_TOKEN;
 if(!wanted||!equal(h.replace(/^Bearer /i,''),wanted))return res.status(401).json({error:'Não autorizado'});
 next();
}
app.get('/health',async(req,res)=>{try{if(!pool)throw Error('Banco não configurado');await pool.query('SELECT 1');res.json({ok:true,mode:'read-only-upseller'});}catch(e){res.status(503).json({ok:false,error:'Banco indisponível'});}});
app.get('/',(req,res)=>res.type('html').send(PAGE));
app.use('/api',auth);
app.get('/api/dashboard',async(req,res)=>{try{
 const [products,rules,logs]=await Promise.all([
 pool.query('SELECT p.sku,p.title,p.sku_id,p.desired_rule_id,m.rule_id AS actual_rule_id,r.name AS actual_rule_name FROM ups_products p LEFT JOIN ups_rule_members m ON m.account_id=p.account_id AND m.sku=p.sku LEFT JOIN ups_rules r ON r.account_id=m.account_id AND r.rule_id=m.rule_id WHERE p.account_id=$1 ORDER BY p.sku LIMIT 3000',[ACCOUNT]),
 pool.query('SELECT r.rule_id,r.name,r.enabled,r.priority,r.capacity,COUNT(m.sku)::int AS occupied FROM ups_rules r LEFT JOIN ups_rule_members m ON m.account_id=r.account_id AND m.rule_id=r.rule_id WHERE r.account_id=$1 GROUP BY r.account_id,r.rule_id ORDER BY r.priority NULLS LAST,r.name',[ACCOUNT]),
 pool.query('SELECT action,created_at FROM ups_audit WHERE account_id=$1 ORDER BY id DESC LIMIT 15',[ACCOUNT])
 ]);res.json({products:products.rows,rules:rules.rows,logs:logs.rows,readOnly:true});
 }catch(e){console.error(e);res.status(500).json({error:'Falha ao carregar painel'});}});
app.post('/api/bridge/catalog',async(req,res)=>{
 const rows=req.body?.rows;
 if(!Array.isArray(rows)||rows.length>5000||!rows.length)return res.status(400).json({error:'Lista inválida'});
 const uniq=new Set();
 for(const x of rows){if(!x||typeof x.sku!=='string'||!x.sku.trim()||x.sku.length>120||uniq.has(x.sku))return res.status(400).json({error:'SKU inválido ou duplicado'});uniq.add(x.sku);}
 const c=await pool.connect();try{await c.query('BEGIN');
 for(const x of rows)await c.query("INSERT INTO ups_products(account_id,sku,sku_id,title) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,sku) DO UPDATE SET sku_id=EXCLUDED.sku_id,title=EXCLUDED.title,updated_at=now()",[ACCOUNT,x.sku,String(x.id??x.skuId??''),String(x.title??'').slice(0,500)]);
 await c.query("INSERT INTO ups_audit(account_id,action,details) VALUES($1,'catalog_import',$2)",[ACCOUNT,JSON.stringify({count:rows.length})]);await c.query('COMMIT');res.json({ok:true,count:rows.length});
 }catch(e){await c.query('ROLLBACK');console.error(e);res.status(500).json({error:'Falha na importação'});}finally{c.release();}
});
app.post('/api/bridge/rules',async(req,res)=>{
 const rules=req.body?.rules;
 if(!Array.isArray(rules)||rules.length>100||rules.some(r=>!r||!r.id||!r.ruleName||!Array.isArray(r.inventorySkuValueVoList??[])))return res.status(400).json({error:'Regras inválidas'});
 const seen=new Set();
 for(const r of rules){const l=r.inventorySkuValueVoList??[];if(l.length>500)return res.status(422).json({error:'Regra acima de 500',rule:r.ruleName});const local=new Set();for(const x of l){const sku=String(x.skuName??'');if(!sku||local.has(sku)||seen.has(sku))return res.status(422).json({error:'SKU duplicado em uma ou mais regras',sku});local.add(sku);seen.add(sku);}}
 const c=await pool.connect();try{await c.query('BEGIN');
 await c.query('SELECT pg_advisory_xact_lock(30945)');
 for(const r of rules)await c.query("INSERT INTO ups_rules(account_id,rule_id,name,priority,enabled) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,rule_id) DO UPDATE SET name=EXCLUDED.name,priority=EXCLUDED.priority,enabled=EXCLUDED.enabled,synced_at=now()",[ACCOUNT,String(r.id),String(r.ruleName),r.priority??null,r.status===1]);
 await c.query('DELETE FROM ups_rule_members WHERE account_id=$1',[ACCOUNT]);
 for(const r of rules)for(const x of r.inventorySkuValueVoList??[]){
 const sku=String(x.skuName),id=String(x.skuId??'');
 await c.query("INSERT INTO ups_products(account_id,sku,sku_id) VALUES($1,$2,$3) ON CONFLICT(account_id,sku) DO UPDATE SET sku_id=CASE WHEN EXCLUDED.sku_id='' THEN ups_products.sku_id ELSE EXCLUDED.sku_id END",[ACCOUNT,sku,id]);
 await c.query('INSERT INTO ups_rule_members(account_id,rule_id,sku,sku_id) VALUES($1,$2,$3,$4)',[ACCOUNT,String(r.id),sku,id]);
 }
 await c.query("INSERT INTO ups_audit(account_id,action,details) VALUES($1,'rules_snapshot',$2)",[ACCOUNT,JSON.stringify({rules:rules.length,members:seen.size})]);
 await c.query('COMMIT');res.json({ok:true,rules:rules.length,members:seen.size});
 }catch(e){await c.query('ROLLBACK');console.error(e);res.status(500).json({error:'Falha ao salvar regras'});}finally{c.release();}
});
app.post('/api/products/:sku/desired',async(req,res)=>{
 const rule=req.body?.ruleId===null?null:String(req.body?.ruleId??'');
 if(rule==='')return res.status(400).json({error:'Regra inválida'});
 const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(30945)');
 const p=await c.query('SELECT desired_rule_id FROM ups_products WHERE account_id=$1 AND sku=$2 FOR UPDATE',[ACCOUNT,req.params.sku]);
 if(!p.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'SKU não encontrado'});}
 if(rule){const r=await c.query('SELECT r.rule_id,r.capacity,COUNT(m.sku)::int AS occupied FROM ups_rules r LEFT JOIN ups_rule_members m ON m.account_id=r.account_id AND m.rule_id=r.rule_id WHERE r.account_id=$1 AND r.rule_id=$2 GROUP BY r.account_id,r.rule_id',[ACCOUNT,rule]);
 if(!r.rowCount){await c.query('ROLLBACK');return res.status(400).json({error:'Regra inexistente'});}
 const existing=await c.query('SELECT 1 FROM ups_rule_members WHERE account_id=$1 AND rule_id=$2 AND sku=$3',[ACCOUNT,rule,req.params.sku]);
 const reserved=await c.query('SELECT COUNT(*)::int AS n FROM ups_products WHERE account_id=$1 AND desired_rule_id=$2 AND sku<>$3 AND NOT EXISTS(SELECT 1 FROM ups_rule_members WHERE account_id=$1 AND rule_id=$2 AND sku=ups_products.sku)',[ACCOUNT,rule,req.params.sku]);
 if(!existing.rowCount&&Number(r.rows[0].occupied)+Number(reserved.rows[0].n)>=Number(r.rows[0].capacity)){await c.query('ROLLBACK');return res.status(409).json({error:'Regra lotada (considerando reservas pendentes)'});}
 }
 await c.query('UPDATE ups_products SET desired_rule_id=$3,updated_at=now() WHERE account_id=$1 AND sku=$2',[ACCOUNT,req.params.sku,rule]);
 await c.query("INSERT INTO ups_audit(account_id,action,details) VALUES($1,'desired_changed',$2)",[ACCOUNT,JSON.stringify({sku:req.params.sku,rule})]);await c.query('COMMIT');res.json({ok:true,writeToUpseller:false});
 }catch(e){await c.query('ROLLBACK');console.error(e);res.status(500).json({error:'Falha ao salvar preferência'});}finally{c.release();}
});
const PAGE=`<!doctype html><html lang="pt-br"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Projeto UpSeller</title><style>body{font:14px system-ui;background:#f4f6fa;color:#172338;margin:0}header{background:#14243f;color:white;padding:20px 4vw}main{max-width:1260px;margin:30px auto;padding:0 20px}.box{background:white;padding:20px;border:1px solid #dfe5ef;border-radius:13px;margin:18px 0}.cards{display:flex;flex-wrap:wrap;gap:12px}.card{flex:1;min-width:140px;background:#edf4ff;padding:17px;border-radius:10px}b.big{display:block;font-size:24px}table{border-collapse:collapse;width:100%}td,th{padding:11px;border-bottom:1px solid #e5eaf1;text-align:left}input,button,select{padding:10px;border-radius:8px;border:1px solid #c6d1df}button{cursor:pointer;background:#2563eb;color:white}small{color:#56677a}.overflow{overflow:auto;max-height:65vh}</style><header><h2>Projeto UpSeller · Controle de Regras</h2><small style="color:#c8d9f5">Chic Seek · Somente leitura e planejamento — escrita no UpSeller desligada</small></header><main><div class="box"><input id="token" type="password" placeholder="Token do painel"><button onclick="load()">Entrar / Atualizar</button> <span id="state"></span></div><div id="view" hidden><div id="cards" class="cards"></div><div class="box"><h3>Regras e capacidade</h3><div id="rules"></div></div><div class="box"><h3>Produtos</h3><input id="filter" placeholder="Buscar SKU ou título" oninput="draw()"><div class="overflow"><table><thead><tr><th>SKU</th><th>Produto</th><th>Regra atual</th><th>Regra desejada</th><th>Alterar preferência</th></tr></thead><tbody id="rows"></tbody></table></div></div></div></main><script>let data={products:[],rules:[]};const $=id=>document.getElementById(id);const safe=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));async function load(){const r=await fetch('/api/dashboard',{headers:{Authorization:'Bearer '+$('token').value}});if(!r.ok){$('state').textContent='Acesso negado ou servidor indisponível';return;}data=await r.json();$('view').hidden=false;$('state').textContent='Dados carregados';$('cards').innerHTML='<div class="card"><b class="big">'+data.products.length+'</b>SKUs</div><div class="card"><b class="big">'+data.rules.length+'</b>Regras</div><div class="card"><b class="big">'+data.rules.reduce((n,r)=>n+Number(r.occupied),0)+'</b>Vínculos atuais</div>'; $('rules').innerHTML=data.rules.map(r=>'<p><b>'+safe(r.name)+'</b> — '+r.occupied+'/'+r.capacity+' · '+(r.enabled?'Ativa':'Desativada')+'</p>').join('');draw();}function draw(){const q=$('filter').value.toLowerCase();$('rows').innerHTML=data.products.filter(p=>(p.sku+' '+p.title).toLowerCase().includes(q)).slice(0,500).map(p=>'<tr><td>'+safe(p.sku)+'</td><td>'+safe(p.title)+'</td><td>'+safe(p.actual_rule_name||'Sem regra')+'</td><td>'+safe(data.rules.find(r=>r.rule_id===p.desired_rule_id)?.name||'Não definida')+'</td><td><select onchange="save(this,\''+safe(p.sku).replace(/'/g,'&#39;')+'\')"><option value="">Escolher...</option><option value="none">Desativado</option>'+data.rules.map(r=>'<option value="'+safe(r.rule_id)+'" '+(r.occupied>=r.capacity?'disabled':'')+'>'+safe(r.name)+' ('+(r.capacity-r.occupied)+' vagas)</option>').join('')+'</select></td></tr>').join('');}async function save(el,sku){const ruleId=el.value==='none'?null:el.value;if(ruleId===null&&!confirm('Registrar intenção de remover o SKU das regras?'))return;const r=await fetch('/api/products/'+encodeURIComponent(sku)+'/desired',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+$('token').value},body:JSON.stringify({ruleId})});const j=await r.json();alert(j.ok?'Preferência salva; nenhuma alteração feita no UpSeller':j.error);if(j.ok)load();}</script></html>`;
const port=process.env.PORT||3000;app.listen(port,'0.0.0.0',()=>console.log('UpSeller dashboard listening on',port));