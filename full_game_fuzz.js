// FULL-GAME FUZZ TEST. Plays whole games by itself (random players, team modes, presets/custom, tagging, quests,
// zone shrinks, power-ups, callouts, host ending early) on a fake clock and checks the rules after every step.
// Run:  node full_game_fuzz.js 500        (500 games, takes a few seconds)   or   node full_game_fuzz.js 2000 777
// Full-game fuzz: plays complete games on a fake clock and checks rules after every step.
const SERVER=process.env.SERVER||require('path').join(__dirname,'backend','server.js');
let T=1_800_000_000_000; Date.now=()=>T;
process.env.ROAD_RETRY_MS='0'; // no waiting between road-load retries in the test
const https=require('https'); const {EventEmitter}=require('events');
https.request=function(o,cb){const req=new EventEmitter();req.write=()=>{};req.destroy=()=>{};req.end=()=>setTimeout(()=>req.emit('error',new Error('offline (test)')),0);return req;};
function mulberry(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
let rnd=mulberry(1); Math.random=()=>rnd();
const realLog=console.log, realWarn=console.warn, realErr=console.error;
let serverErrors=[]; console.log=()=>{}; console.warn=()=>{}; console.error=(...a)=>{serverErrors.push(a.map(x=>x&&x.stack||String(x)).join(' '))};
const {Game,haversine,isInside,computePresetSettings}=require(SERVER);
const pick=a=>a[Math.floor(rnd()*a.length)], chance=p=>rnd()<p, between=(a,b)=>a+rnd()*(b-a);

function makeRoads(g){
  const pts=[],R=g.initialRadiusMeters*0.92,step=40,spacing=Math.max(250,R/6);
  const mLat=1/111320,mLng=1/(111320*Math.cos(g.centerLat*Math.PI/180));
  for(let a=-R;a<=R;a+=spacing) for(let b=-R;b<=R;b+=step){
    pts.push({lat:g.centerLat+a*mLat,lng:g.centerLng+b*mLng},{lat:g.centerLat+b*mLat,lng:g.centerLng+a*mLng});
  }
  return pts.filter(p=>haversine(g.centerLat,g.centerLng,p.lat,p.lng)<=R);
}
function nonFinite(o,path,out,depth=0){
  if(depth>8||o===null) return;
  if(typeof o==='number'){ if(!Number.isFinite(o)) out.push(path); return; }
  if(Array.isArray(o)){ o.forEach((v,i)=>nonFinite(v,path+'['+i+']',out,depth+1)); return; }
  if(typeof o==='object') for(const k of Object.keys(o)) nonFinite(o[k],path+'.'+k,out,depth+1);
}

function playOneGame(seed,verbose){
  rnd=mulberry(seed); serverErrors=[]; T=1_800_000_000_000+seed*1000;
  const problems=[]; const bad=(m)=>{ if(problems.length<12) problems.push(m); };
  // ---------- config ----------
  const R=pick([400,500,800,1500,3000,8000,20000]), durationMin=pick([5,8,15,30,60,120]);
  const mode=pick(['standard','standard','standard','custom','my_rules']); const preset=chance(.5);
  const settings={centerLat:between(-60,60),centerLng:between(-170,170),initialRadiusMeters:R,durationSeconds:durationMin*60,teamMode:mode};
  let nPlayers, size=1;
  if(mode==='standard'){ size=pick([1,2,3,4]); const teams=pick([2,3,4,6]); settings.teamSize=size; nPlayers=size*teams; settings.teamFormation=(size===2&&chance(.5))?'choose':'random'; }
  else if(mode==='custom'){ settings.customRunners=pick([1,2,3,5,8]); settings.customTaggers=pick([1,2,3]); nPlayers=settings.customRunners+settings.customTaggers; settings.teamSize=1; }
  else { nPlayers=pick([2,3,5,7]); settings.teamSize=1; }
  if(preset) Object.assign(settings,computePresetSettings(settings.durationSeconds,R));
  else Object.assign(settings,{headStartSeconds:pick([0,60,300]),snapshotIntervalSeconds:pick([30,60,300]),safePeriodSeconds:pick([60,300,900]),zoneTransitionSeconds:pick([120,240,600]),
     zoneMinIntervalSeconds:pick([60,300,600]),zoneMaxIntervalSeconds:pick([120,600,1200]),buffSpawnChance:pick([0.08,0.15,0.3]),maxBuffZonesPerGame:pick([1,2]),zoneDifficulty:pick(['hard','normal','veryhard'])});
  const cfg=`seed=${seed} mode=${mode}${mode==='standard'?'/'+size+'x/'+settings.teamFormation:''} players=${nPlayers} R=${R} dur=${durationMin}m ${preset?'preset':'custom'}`;
  const g=new Game(settings);
  const players=[]; for(let i=0;i<nPlayers;i++) players.push(g.addPlayer('P'+(i+1)));
  const host=players[0];
  if(mode==='my_rules'){ const roles=players.map((_,i)=>i===0?'tagger':(i===1?'runner':pick(['runner','tagger']))); players.forEach((p,i)=>{const r=g.setPlayerRole(host.id,p.id,roles[i]); if(r.error) bad('setPlayerRole: '+r.error);}); }
  if(settings.teamFormation==='choose') for(let i=0;i+1<players.length;i+=2){ g.setTeammate(players[i].id,players[i+1].id); g.setTeammate(players[i+1].id,players[i].id); }
  const haveRoads=chance(.8); let roadsLateAt=haveRoads?null:T+between(60,400)*1000; const fakeRoads=makeRoads(g);
  if(haveRoads){ g.roadPoints=fakeRoads; g.roadsLoaded=true; }
  const st=g.start(); if(st.error){ bad('start() refused a valid lobby: '+st.error); return {cfg,problems,ended:false,serverErrors}; }
  const onRoad=(la,lo)=>g.roadPoints.some(p=>p.lat===la&&p.lng===lo);
  // ---------- players ----------
  const ps=new Map(); const mLat=1/111320,mLng=1/(111320*Math.cos(g.centerLat*Math.PI/180));
  for(const p of players){ const d=between(0,R*0.8),a=between(0,6.28); ps.set(p.id,{lat:g.centerLat+d*Math.cos(a)*mLat,lng:g.centerLng+d*Math.sin(a)*mLng,speed:between(1.2,4.5),offUntil:0,wander:between(0,6.28),rebel:chance(.15)}); }
  let lastStatus=g.status, elimSeen=new Set(), prevR=g.safeZone.radiusMeters, steps=0, hostEndAt=chance(.04)?T+between(30,durationMin*60)*1000:null;
  const questsAt=new Map(); const zonesSeen=new Map(); const endLimit=g.endsAt+120000;
  const calloutTimes=[];
  // ---------- loop ----------
  while(T<endLimit && g.status!=='ended'){
    const dt=pick([1,1,2,2,3,5]); T+=dt*1000; steps++;
    if(roadsLateAt&&T>=roadsLateAt){ g.roadPoints=fakeRoads; g.roadsLoaded=true; roadsLateAt=null; }
    for(const p of players){
      const s=ps.get(p.id); if(T<s.offUntil) continue; if(chance(.004)){ s.offUntil=T+between(10,50)*1000; continue; }
      const team=p.teamId?g.teams.get(p.teamId):null; let tx=null,ty=null,speed=s.speed;
      if(team){
        if(team.role==='tagger'){
          let best=null,bd=1e15; for(const t of g.teams.values()){ if(t.role!=='runner'||t.status!=='active') continue; for(const pid of t.playerIds){ const q=g.players.get(pid); const d=haversine(s.lat,s.lng,q.lat,q.lng); if(d<bd){bd=d;best={q,t};} } }
          if(best){ tx=best.q.lat; ty=best.q.lng; if(bd<25&&g.status==='active'&&chance(.5)){ const r=g.tagTeam(p.id,chance(.9)?best.t.secretCode:'ZZZZZZ'); if(r.error&&!/Invalid|Wrong|locked|penalty|Wait/i.test(r.error)) bad('tagTeam odd error: '+r.error); } }
        } else {
          const q=g.quests.find(x=>x.teamId===team.id&&x.status==='active');
          if(q&&q.type!=='distance'){ tx=q.targetLat; ty=q.targetLng; }
          else if(q&&q.type==='distance'){ tx=s.lat+Math.cos(s.wander)*100*mLat; ty=s.lng+Math.sin(s.wander)*100*mLng; }
          else { const z=g.pendingSafeZone||g.safeZone; if(!s.rebel){ tx=z.centerLat; ty=z.centerLng; } }
        }
      }
      if(tx==null){ s.wander+=between(-.6,.6); tx=s.lat+Math.cos(s.wander)*50*mLat; ty=s.lng+Math.sin(s.wander)*50*mLng; }
      const dy=(tx-s.lat)/mLat, dx=(ty-s.lng)/mLng, dist=Math.hypot(dx,dy);
      if(dist>3){ const step=Math.min(dist,speed*dt); s.lat+=dy/dist*step*mLat; s.lng+=dx/dist*step*mLng; }
      if(haversine(g.centerLat,g.centerLng,s.lat,s.lng)>R*1.02){ s.lat+=(g.centerLat-s.lat)*0.05; s.lng+=(g.centerLng-s.lng)*0.05; }
      const noise=()=>(rnd()-.5)*10*mLat;
      const res=g.updateLocation(p.id,s.lat+noise(),s.lng+noise(),between(4,40),T);
      if(res.error&&res.reason==='impossible_movement') bad('legit move rejected as GPS jump');
      if(chance(.002)){ const r=g.updateLocation(p.id,s.lat+0.05,s.lng+0.05,10,T); /* GPS glitch must be rejected, never crash */ }
      // actions
      if(team&&team.status==='active'){
        if(team.role==='runner'){
          const av=g.quests.find(x=>x.teamId===team.id&&x.status==='available'); if(av&&chance(.25)) g.activateQuest(p.id,av.id);
          if(chance(.03)){ if(team.ghostCharges>0) g.activateGhost(p.id); else if(team.smokeCharges>0) g.activateSmoke(p.id); else if(team.visionCharges>0) g.activateVisionBurst(p.id); }
        } else { if(chance(.02)) g.usePing(p.id); if(chance(.02)) g.useBonusSnapshot(p.id); if(chance(.02)&&team.visionCharges>0) g.activateVisionBurst(p.id); }
        if(chance(.03)){ const before=(g.callouts||[]).length; const r1=g.sendCallout(p.id,pick(['help','north','south','east','west','hide','split','bogus'])); if(chance(.5)){ const r2=g.sendCallout(p.id,'help'); if(r1.ok&&r2.ok) bad('callout rate-limit did not block a spam callout'); } }
      }
    }
    if(hostEndAt&&T>=hostEndAt){ const r=g.hostEndGame(host.id); hostEndAt=null; if(r.error) bad('hostEndGame: '+r.error); }
    try{ g.tick(); }catch(e){ bad('tick() threw: '+(e&&e.stack||e).toString().split('\n').slice(0,3).join(' | ')); break; }
    // ----- invariants every step -----
    if(g.status==='lobby') bad('status went back to lobby');
    if(lastStatus==='active'&&g.status==='head_start') bad('status went backwards');
    lastStatus=g.status;
    if(!g.roadPoints.length && g.quests.length) bad('quests exist with no road data');
    for(const t of g.teams.values()){ if(t.status==='eliminated') elimSeen.add(t.id); else if(elimSeen.has(t.id)) bad('eliminated team came back to life'); if(t.health<0||!Number.isFinite(t.health)) bad('bad health'); }
    const sz=g.safeZone; if(sz.radiusMeters>prevR+1e-6) bad('safe zone grew '+prevR+' -> '+sz.radiusMeters); prevR=Math.min(prevR,sz.radiusMeters);
    if(haversine(g.centerLat,g.centerLng,sz.centerLat,sz.centerLng)+sz.radiusMeters>R+0.5) bad('safe zone outside original zone');
    const pz=g.pendingSafeZone; if(pz){ if(!(pz.radiusMeters<sz.radiusMeters)) bad('pending zone not smaller'); if(haversine(g.centerLat,g.centerLng,pz.centerLat,pz.centerLng)+pz.radiusMeters>R+0.5) bad('pending zone outside original'); if(haversine(sz.centerLat,sz.centerLng,pz.centerLat,pz.centerLng)>sz.radiusMeters+0.5) bad('pending zone centre unreachable'); }
    for(const z of g.zones) zonesSeen.set(z.id,z.type);
    for(const q of g.quests){ if(!questsAt.has(q.id)){ questsAt.set(q.id,1);
        if(!Number.isFinite(q.targetLat)||!Number.isFinite(q.targetLng)) bad('quest with bad coordinates: '+q.type);
        else if(g.roadPoints.length&&!onRoad(q.targetLat,q.targetLng)) bad('quest NOT on a road: '+q.type+(q.isBait?' (bait)':''));
        for(const stg of q.stages||[]) if(g.roadPoints.length&&!onRoad(stg.lat,stg.lng)) bad('quest stage NOT on a road');
        if(haversine(g.centerLat,g.centerLng,q.targetLat,q.targetLng)>R+1) bad('quest outside the game area: '+q.type+(q.isBait?' (bait)':''));
    } }
    if(steps%20===0){ for(const p of players){ let s; try{ s=g.getStateFor(p.id); JSON.stringify(s); }catch(e){ bad('getStateFor threw: '+(e&&e.message)); break; } const nf=[]; nonFinite(s,'state',nf); if(nf.length) bad('non-finite number in state: '+nf.slice(0,2).join(',')); } }
  }
  // ---------- end of game checks ----------
  const ended=g.status==='ended';
  if(!ended) bad('game never ended (status '+g.status+', T-ends='+Math.round((T-g.endsAt)/1000)+'s)');
  if(ended){
    const total=Math.floor((g.matchStats.endedAt-g.matchStats.startedAt)/1000);
    for(const t of g.teams.values()){ const s=g.matchStats.teams[t.id]; if(!s){ bad('no stats for team '+t.number); continue; }
      if(t.status==='eliminated'){
        if(s.survived!==false) bad(`team #${t.number} (${t.role}) was eliminated but stats say survived=${s.survived}`);
        if(!s.eliminatedAt) bad(`team #${t.number} eliminated but has no eliminatedAt time`);
        if(!(s.surviveSeconds>0)&&s.eliminatedAt&&s.eliminatedAt>g.matchStats.startedAt+1500) bad(`team #${t.number} eliminated after ${Math.round((s.eliminatedAt-g.matchStats.startedAt)/1000)}s but surviveSeconds=${s.surviveSeconds}`);
      } else if(s.survived!==true) bad('active team marked not survived'); 
      if(s.surviveSeconds>total+2) bad('surviveSeconds longer than the game');
    }
    const fin=g.getStateFor(players[0].id);
    if(!fin.battleCards||fin.battleCards.length!==g.teams.size) bad('battleCards missing/wrong count');
    else for(const c of fin.battleCards){ if(c.status==='eliminated'&&c.survived) bad('battle card shows eliminated team #'+c.number+' as survived'); for(const pt of c.path) if(!Number.isFinite(pt.lat)||!Number.isFinite(pt.lng)) bad('battle card path has bad point'); if(c.path.length>200) bad('battle card path too long'); }
    if(!fin.mvp||!fin.mvp.mvp) bad('no MVP at end'); else { if((fin.mvp.podium||[]).length>3) bad('podium > 3'); const sc=fin.mvp.podium.map(x=>x.score); for(let i=1;i<sc.length;i++) if(sc[i]>sc[i-1]) bad('podium not sorted'); if(fin.mvp.podium.some(x=>!Number.isFinite(x.score))) bad('MVP score NaN'); }
    const nf=[]; nonFinite(fin,'final',nf); if(nf.length) bad('non-finite number in final state '+nf[0]);
  }
  for(const e of serverErrors) bad('server logged error: '+e.split('\n')[0].slice(0,160));
  const tagged=new Set(g.tags.filter(t=>t.result==='eliminated').map(t=>t.runnerTeamId));
  const cov={ tags:g.tags.filter(t=>t.result==='eliminated').length, absorbed:g.tags.filter(t=>t.result==='extra_health').length,
    zoneElim:[...g.teams.values()].filter(t=>t.status==='eliminated'&&!tagged.has(t.id)).length, questsDone:g.matchStats.questsCompleted||0,
    bait:g.quests.filter(q=>q.isBait).length, baitDone:g.quests.filter(q=>q.isBait&&q.status==='completed').length, shrinks:g.shrinkCount,
    finalCircle:g.finalCircleTriggered?1:0, danger:[...zonesSeen.values()].filter(x=>x==='danger').length, buff:[...zonesSeen.values()].filter(x=>x==='buff').length,
    questTypes:[...new Set(g.quests.map(q=>q.type))], winner:g.winner, snapshots:g.snapshots.length, callouts:(g.callouts||[]).length };
  return {cfg,problems,ended,steps,cov};
}
const N=+process.argv[2]||300, start=+process.argv[3]||1; let failedGames=0, ended=0; const tally={}; const C={games:0,tags:0,absorbed:0,zoneElim:0,questsDone:0,bait:0,baitDone:0,shrinks:0,finalCircle:0,danger:0,buff:0,winner:{},types:{},withTags:0,withZoneElim:0,withBait:0,withBaitDone:0};
for(let s=start;s<start+N;s++){
  let r; try{ r=playOneGame(s); }catch(e){ r={cfg:'seed='+s,problems:['HARNESS/GAME CRASH: '+(e&&e.stack||e).toString().split('\n').slice(0,3).join(' | ')],ended:false}; }
  if(r.ended) ended++;
  if(r.cov){ const c=r.cov; C.games++; for(const k of ['tags','absorbed','zoneElim','questsDone','bait','baitDone','shrinks','finalCircle','danger','buff']) C[k]+=c[k]; C.winner[c.winner]=(C.winner[c.winner]||0)+1; for(const t of c.questTypes) C.types[t]=(C.types[t]||0)+1; if(c.tags) C.withTags++; if(c.zoneElim) C.withZoneElim++; if(c.bait) C.withBait++; if(c.baitDone) C.withBaitDone++; }
  if(r.problems.length){ failedGames++; const seen=new Set(); for(const pr of r.problems){ const k=pr.replace(/#\d+/g,'#N').replace(/-?\d+(\.\d+)?s\b/g,'Ns').replace(/\d+(\.\d+)? ->/g,'X ->').replace(/-> \d+(\.\d+)?/g,'-> Y').replace(/survived=\w+/,'survived=?'); if(seen.has(k)) continue; seen.add(k); tally[k]=(tally[k]||{n:0,ex:r.cfg}); tally[k].n++; } }
}
realLog('\nCOVERAGE over '+C.games+' games:', JSON.stringify(C));
realLog(`\nGAMES PLAYED: ${N} | finished normally: ${ended} | games with problems: ${failedGames}`);
for(const [k,v] of Object.entries(tally).sort((a,b)=>b[1].n-a[1].n)) realLog(` ${String(v.n).padStart(4)}x  ${k}\n        e.g. ${v.ex}`);
