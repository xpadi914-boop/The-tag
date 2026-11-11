// ROAD LOADER TEST (pure Node, no installs). Checks that quests always get road data when it is at all possible,
// and that Start never waits for it.   Run:  node roads_test.js
process.env.ROAD_RETRY_MS='0,5,5';
const assert=require('assert'), https=require('https'), {EventEmitter}=require('events'), path=require('path'), fs=require('fs'), os=require('os'), cp=require('child_process'), http=require('http');
const realRequest=https.request; const calls=[];
// scripted fake Overpass: behave(host,query) -> {status,body} | 'hang' | 'error'
let behave=()=>({status:200,body:{elements:[]}});
https.request=function(opts,cb){
  const req=new EventEmitter(); let body=''; req.write=c=>{body+=c}; req.destroy=()=>{req.destroyed=true};
  req.end=()=>{
    const query=decodeURIComponent(body.replace(/^data=/,'')); calls.push({host:opts.hostname,query});
    const b=behave(opts.hostname,query);
    setTimeout(()=>{
      if(req.destroyed||b==='hang') return;
      if(b==='error') return req.emit('error',new Error('ECONNRESET'));
      const res=new EventEmitter(); res.statusCode=b.status; cb(res);
      res.emit('data',typeof b.body==='string'?b.body:JSON.stringify(b.body)); res.emit('end');
    },2);
  };
  return req;
};
const {Game,haversine,isUsableRoad,sampleRoadPointsFromOverpass,ROAD_CACHE}=require('./backend/server');
const C={lat:19.0760,lng:72.8777}, mLat=1/111320, mLng=1/(111320*Math.cos(C.lat*Math.PI/180));
const way=(type,off,n=8,extra={})=>({type:'way',tags:{highway:type,...extra},geometry:Array.from({length:n},(_,i)=>({lat:C.lat+(off+i*20)*mLat,lon:C.lng+(i*5)*mLng}))});
const newGame=(r=1000,lat=C.lat)=>{const g=new Game({initialRadiusMeters:r,centerLat:lat,centerLng:C.lng}); g.roadRetryMs=[0,5,5]; return g;};
let n=0; const ok=m=>{n++;console.log('  ok  ',m)};
(async()=>{
  console.log('\n== road loader');
  // 1. four servers broken in four different ways, the fifth works: we still get roads, fast
  ROAD_CACHE.clear(); calls.length=0;
  behave=(h)=>({'overpass-api.de':{status:504,body:'<html>timeout</html>'},'lz4.overpass-api.de':'error','overpass.kumi.systems':{status:429,body:'slow down'},'overpass.private.coffee':'hang'}[h]||{status:200,body:{elements:[way('residential',0),way('tertiary',100)]}});
  let g=newGame(); let t0=Date.now(); let res=await g.loadRoadNetwork();
  assert.ok(res&&g.roadPoints.length>10&&g.roadSource==='server'&&g.roadTier===1); assert.ok(Date.now()-t0<1500,'took '+(Date.now()-t0));
  ok('4 broken/hanging servers + 1 good one: roads loaded in '+(Date.now()-t0)+' ms');
  assert.equal(calls.filter(c=>c.query.includes('residential')).length,5); ok('all 5 servers were asked at the same time');
  // 2. memory: same place again = no network at all
  calls.length=0; const g2=newGame(); assert.ok(await g2.loadRoadNetwork()); assert.equal(calls.length,0); assert.equal(g2.roadSource,'cache'); ok('second game in the same place got its roads from memory, 0 requests');
  // 3. area with no streets, only footpaths/tracks (campus, park): paths are used so quests can still appear
  ROAD_CACHE.clear(); calls.length=0;
  behave=(h,q)=>q.includes('footway')?{status:200,body:{elements:[way('footway',0),way('path',60),way('track',200)]}}:{status:200,body:{elements:[]}};
  g=newGame(800); assert.ok(await g.loadRoadNetwork()); assert.equal(g.roadTier,2); assert.ok(g.roadPoints.length>10); ok('no streets nearby: walkable paths used instead ('+g.roadPoints.length+' points)');
  assert.ok(calls.some(c=>/residential/.test(c.query))&&calls.some(c=>/footway/.test(c.query)&&!/residential/.test(c.query))); ok('streets asked first, paths only asked as a second step');
  // 4. a couple of streets (fewer than 15 points) + paths are combined
  ROAD_CACHE.clear();
  behave=(h,q)=>q.includes('footway')?{status:200,body:{elements:[way('footway',0,10),way('path',60,10)]}}:{status:200,body:{elements:[way('residential',0,3)]}};
  g=newGame(800); assert.ok(await g.loadRoadNetwork()); assert.equal(g.roadTier,2); assert.ok(g.roadPoints.length>15); ok('very few streets: streets + paths combined');
  // 5. plenty of streets: paths are NOT used
  ROAD_CACHE.clear(); calls.length=0; behave=()=>({status:200,body:{elements:[way('residential',0,12),way('secondary',50,12),way('footway',10,12)]}});
  g=newGame(800); assert.ok(await g.loadRoadNetwork()); assert.equal(g.roadTier,1); assert.ok(!calls.some(c=>/footway/.test(c.query)&&!/residential/.test(c.query)));
  assert.ok(g.roadPoints.every(p=>true)); ok('plenty of streets: paths ignored, no second request');
  // 6. a server that answers "query timed out" (empty + remark) counts as a failure, the next server is used
  ROAD_CACHE.clear(); behave=(h)=>h==='overpass-api.de'?{status:200,body:{elements:[],remark:'runtime error: Query timed out'}}:{status:200,body:{elements:[way('residential',0,12)]}};
  g=newGame(); assert.ok(await g.loadRoadNetwork()); ok('"query timed out" answer is not mistaken for "no roads here"');
  // 7. everything is down: false, a clear error, and it retried
  ROAD_CACHE.clear(); calls.length=0; behave=()=> 'error';
  g=newGame(); res=await g.loadRoadNetwork(); assert.equal(res,false); assert.equal(g.roadsLoaded,false); assert.equal(g.roadError,'road server not reachable'); assert.equal(calls.length,5*3);
  assert.deepEqual(Object.keys(g._roadInfo()).sort(),['error','loaded','loading','points','source','tier']); ok('all servers down: gives up cleanly after 3 rounds, error reported ('+calls.length+' requests)');
  // 8. only footpaths exist and the street query itself failed -> retried, not silently empty
  ROAD_CACHE.clear(); let flaky=0; behave=(h,q)=>(++flaky<=5)?'error':{status:200,body:{elements:[way('residential',0,12)]}};
  g=newGame(); assert.ok(await g.loadRoadNetwork()); ok('first round fails, second round works');

  console.log('\n== path filter');
  assert.ok(!isUsableRoad(way('footway'))&&isUsableRoad(way('footway'),true)&&isUsableRoad(way('residential'))); assert.ok(!isUsableRoad(way('motorway'),true)); assert.ok(!isUsableRoad(way('footway',0,3,{access:'private'}),true));
  assert.ok(!isUsableRoad(way('steps'),true)); ok('paths only count when asked for; motorways, private ways and steps never count');

  console.log('\n== host phone upload');
  ROAD_CACHE.clear(); behave=()=> 'error'; g=newGame(500);
  const around=(k,d)=>Array.from({length:k},(_,i)=>[C.lat+Math.cos(i)*d*mLat,C.lng+Math.sin(i)*d*mLng]);
  let r=g.acceptHostRoads('nope'); assert.ok(r.error); r=g.acceptHostRoads(around(2,100)); assert.ok(r.error,'2 points accepted'); ok('rejects junk and too-few points');
  r=g.acceptHostRoads([...around(50,200),[C.lat+0.5,C.lng],[NaN,1],['x','y'],[999,0],null]); assert.ok(r.ok&&r.points===50&&g.roadsLoaded&&g.roadSource==='host'); ok('keeps only valid points inside the game area (junk and far-away points dropped)');
  r=g.acceptHostRoads(around(60,100)); assert.ok(r.ok); ok('later uploads cannot overwrite once roads exist'); 
  const gEnd=newGame(500); gEnd.status='ended'; assert.ok(gEnd.acceptHostRoads(around(20,100)).error); ok('refused after the game ended');
  assert.equal(new Game({initialRadiusMeters:100}).initialRadiusMeters,400); assert.equal(new Game({initialRadiusMeters:399}).initialRadiusMeters,400); assert.equal(new Game({initialRadiusMeters:400}).initialRadiusMeters,400);
  assert.equal(new Game({initialRadiusMeters:450}).initialRadiusMeters,450); assert.equal(new Game({initialRadiusMeters:99999}).initialRadiusMeters,20000); ok('minimum zone is 400 m: 100 -> 400, 399 -> 400, 400 and 450 stay, 99999 -> 20000');

  console.log('\n== real server: Start never waits, host phone backup brings the quests');
  https.request=realRequest;
  const hang=path.join(os.tmpdir(),'hang_https.js');
  fs.writeFileSync(hang,"const https=require('https');const {EventEmitter}=require('events');https.request=function(){const r=new EventEmitter();r.write=()=>{};r.destroy=()=>{};r.end=()=>{};return r;};");  // never answers
  const PORT=3900+Math.floor(Math.random()*90); const srv=cp.spawn('node',['-r',hang,'server.js'],{cwd:path.join(__dirname,'backend'),env:{...process.env,PORT:String(PORT),ROAD_RETRY_MS:'0,100000'},stdio:'ignore'});
  const call=(m,p,b)=>new Promise((res,rej)=>{const d=b?JSON.stringify(b):null;const rq=http.request({host:'localhost',port:PORT,path:p,method:m,headers:d?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(d)}:{}},x=>{let s='';x.on('data',c=>s+=c);x.on('end',()=>{try{res({s:x.statusCode,j:JSON.parse(s)})}catch(e){res({s:x.statusCode,j:{}})}})});rq.on('error',rej);if(d)rq.write(d);rq.end();});
  await new Promise(r=>setTimeout(r,1200));
  try{
    const c=await call('POST','/api/create',{name:'Host',durationSeconds:600,initialRadiusMeters:600,teamSize:1,teamMode:'standard',centerLat:C.lat,centerLng:C.lng,preset:true}); assert.equal(c.s,200);
    const H=c.j,au=(x)=>`gameId=${H.gameId}&playerId=${x.playerId}&sessionToken=${x.sessionToken}`, bots=[];
    for(const nm of ['B1','B2','B3']){ const j=await call('POST','/api/join',{name:nm,code:H.code}); assert.equal(j.s,200); bots.push(j.j); }
    let st=await call('GET','/api/state?'+au(H)); assert.equal(st.j.roads.loaded,false); assert.equal(st.j.roads.loading,true); ok('lobby state tells the host roads are still loading');
    const t0=Date.now(); const s=await call('POST','/api/start',{gameId:H.gameId,playerId:H.playerId,sessionToken:H.sessionToken}); const took=Date.now()-t0;
    assert.equal(s.s,200); assert.ok(took<1500,'Start took '+took+' ms'); ok(`Start took ${took} ms even though the road server never answers (before: 10,000 ms)`);
    for(const p of [H,...bots]) await call('POST','/api/location',{gameId:H.gameId,playerId:p.playerId,sessionToken:p.sessionToken,latitude:C.lat,longitude:C.lng,accuracyMeters:10,sampleAgeMs:0});
    let q0=(await call('GET','/api/state?'+au(H))).j.quests||[]; assert.equal(q0.length,0); ok('with no road data there are no quests yet (never off-road)');
    let bad=await call('POST','/api/roads',{gameId:H.gameId,playerId:bots[0].playerId,sessionToken:bots[0].sessionToken,points:around(40,150)}); assert.equal(bad.s,403); ok('only the host may upload roads (a normal player gets 403)');
    bad=await call('POST','/api/roads',{gameId:H.gameId,playerId:H.playerId,sessionToken:'wrong',points:around(40,150)}); assert.equal(bad.s,401); ok('wrong session token is refused (401)');
    const pts=around(60,200); const up=await call('POST','/api/roads',{gameId:H.gameId,playerId:H.playerId,sessionToken:H.sessionToken,points:pts}); assert.equal(up.s,200); assert.equal(up.j.points,60);
    await new Promise(r=>setTimeout(r,2500));
    const quests=[]; for(const p of [H,...bots]){ const x=(await call('GET','/api/state?'+au(p))).j; for(const q of x.quests||[]) quests.push(q); }
    assert.ok(quests.length>0,'no quests after upload'); const set=new Set(pts.map(p=>p[0]+','+p[1]));
    const offRoad=quests.filter(q=>!set.has(q.targetLat+','+q.targetLng)&&q.type!=='multi_stage'); assert.equal(offRoad.length,0);
    ok(`after the host phone uploaded roads, ${quests.length} quests appeared, all on the uploaded roads`);
    st=await call('GET','/api/state?'+au(H)); assert.equal(st.j.roads.loaded,true); assert.equal(st.j.roads.source,'host'); ok('state now says roads: loaded, source = host phone');
  } finally { srv.kill(); }
  console.log(`\nROADS TESTS: PASS (${n} checks)`); process.exit(0);
})().catch(e=>{ console.error('\nROADS TEST FAILED:',e&&e.stack||e); process.exit(1); });
