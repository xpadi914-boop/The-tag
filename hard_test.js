const assert=require('assert');
const {Game,isInside,haversine,isUsableRoad,sampleRoadPointsFromOverpass}=require('./backend/server');
function add(g,n){return Array.from({length:n},(_,i)=>g.addPlayer('P'+i));}
// Fake street grid around the game center (quests are road-only, so a game needs road data to make quests).
function makeRoads(g){
  const pts=[], R=g.initialRadiusMeters*0.92, step=40, spacing=Math.max(250,R/6);
  const mLat=1/111320, mLng=1/(111320*Math.cos(g.centerLat*Math.PI/180));
  for(let a=-R;a<=R;a+=spacing) for(let b=-R;b<=R;b+=step){
    pts.push({lat:g.centerLat+a*mLat,lng:g.centerLng+b*mLng});   // east-west street
    pts.push({lat:g.centerLat+b*mLat,lng:g.centerLng+a*mLng});   // north-south street
  }
  return pts.filter(p=>haversine(g.centerLat,g.centerLng,p.lat,p.lng)<=R);
}
function giveRoads(g){ if(!g.roadPoints.length){ g.roadPoints=makeRoads(g); g.roadsLoaded=true; } }
function start(g){giveRoads(g);const r=g.start();assert.ok(r.ok,r.error);for(const p of g.players.values())p.hasFix=true;} // test phones all have a GPS fix
function assertContained(g,z){assert.ok(haversine(g.centerLat,g.centerLng,z.centerLat,z.centerLng)+z.radiusMeters <= g.initialRadiusMeters+0.01,'zone outside original boundary');}

// 1. Team sizes and divisibility
for(const size of [1,2,3,4,5,8]){
  const g=new Game({teamSize:size,durationSeconds:600,headStartSeconds:0,initialRadiusMeters:3000});
  add(g,size*2); start(g);
  assert.equal(g.teams.size,2); assert.ok([...g.teams.values()].every(t=>t.playerIds.length===size));
}
{
 const g=new Game({teamSize:3,durationSeconds:600,headStartSeconds:0}); add(g,4); assert.ok(g.start().error);
}

// 2. Role reveal without location leak
{
 const g=new Game({teamSize:1,durationSeconds:600,headStartSeconds:0,snapshotIntervalSeconds:300}); add(g,4); start(g);
 const runners=[...g.teams.values()].filter(t=>t.role==='runner'); const tag=[...g.teams.values()].find(t=>t.role==='tagger');
 const runnerPlayer=g.players.get(runners[0].playerIds[0]);
 const state=g.getStateFor(runnerPlayer.id);
 assert.equal(state.teams.find(t=>t.id===tag.id).role,'tagger');
 assert.ok(!state.visibleLocations.some(x=>x.teamId===tag.id),'runner received tagger location');
}

// 3. Snapshot asymmetry
{
 const g=new Game({teamSize:1,durationSeconds:600,headStartSeconds:0,snapshotIntervalSeconds:300}); add(g,4); start(g);
 const tag=[...g.teams.values()].find(t=>t.role==='tagger'); const tp=g.players.get(tag.playerIds[0]);
 assert.ok(!g.getStateFor(tp.id).visibleLocations.some(x=>x.isRunner),'tagger got live runner');
 g.takeSnapshot(); assert.ok(g.getStateFor(tp.id).visibleLocations.some(x=>x.isSnapshot));
}

// 4. Head-start tag lock
{
 const g=new Game({teamSize:1,durationSeconds:600,headStartSeconds:300}); add(g,4); start(g);
 const tag=[...g.teams.values()].find(t=>t.role==='tagger'); const runner=[...g.teams.values()].find(t=>t.role==='runner');
 assert.ok(g.tagTeam(tag.playerIds[0],runner.secretCode).error);
}

// 5. Extra health: one member completes team quest, code rotates, old code fails, new code triggers penalty
{
 const g=new Game({teamSize:2,durationSeconds:600,headStartSeconds:0}); add(g,4); start(g);
 const runner=[...g.teams.values()].find(t=>t.role==='runner'); const tag=[...g.teams.values()].find(t=>t.role==='tagger');
 const q=g.quests.find(q=>q.teamId===runner.id&&q.reward==='extra_health');
 const member=g.players.get(runner.playerIds[0]); assert.ok(g.activateQuest(member.id,q.id).ok);
 for(let i=0;i<3;i++){
   const st=q.stages[i]; member.lat=st.lat; member.lng=st.lng;
   if(i===2) q.holdStart=Date.now()-121000;
   g.processQuests(Date.now());
 }
 assert.equal(runner.hasExtraHealth,true); const newCode=runner.secretCode; assert.notEqual(newCode,q._oldCode);
 assert.ok(g.tagTeam(tag.playerIds[0], 'ZZZ').error);
 g.status='active'; const result=g.tagTeam(tag.playerIds[0],newCode); assert.equal(result.result,'extra_health'); assert.equal(result.penaltySeconds,50+10); // 600/12 = 50, clamped to 60
 assert.equal(runner.status,'active'); assert.ok(tag.penaltyUntil>Date.now());
 // Movement is locked during the penalty: the authoritative position must not move.
 const tp=g.players.get(tag.playerIds[0]); tp.lat=10; tp.lng=10; tp.lastLocationAt=Date.now();
 const blocked=g.updateLocation(tp.id,10.01,10.01,10,Date.now());
 assert.equal(blocked.error,'MOVEMENT_PENALTY');
 assert.equal(tp.lat,10); assert.equal(tp.lng,10);
}

// 6. Zone containment and timing rules
{
 const short=new Game({durationSeconds:600,zoneTransitionSeconds:30,initialRadiusMeters:3000}); assert.equal(short.zoneTransitionSeconds,120); assert.ok(short.safePeriodSeconds<=240);
 const long=new Game({durationSeconds:3600,zoneTransitionSeconds:120,initialRadiusMeters:5000}); assert.ok(long.safePeriodSeconds<=1440);
 for(let i=0;i<10;i++){short.startShrink(); assertContained(short,short.pendingSafeZone); short.pendingSafeZone=null;}
 for(let i=0;i<20;i++){short.spawnZone(); for(const z of short.zones) assertContained(short,z);}
}

// 7. Ghost is charge-limited
{
 const g=new Game({teamSize:1,durationSeconds:600,headStartSeconds:0}); add(g,4); start(g);
 const r=[...g.teams.values()].find(t=>t.role==='runner'); const p=r.playerIds[0]; assert.ok(g.activateGhost(p).error);
 r.ghostCharges=1; assert.ok(g.activateGhost(p).ok); assert.ok(g.activateGhost(p).error);
}


// 8. Buff zone triggers only once per zone (no repeated vision farming while standing inside)
{
 const g=new Game({teamSize:1,durationSeconds:600,headStartSeconds:0,initialRadiusMeters:3000}); add(g,4); start(g); g.status='active';
 const r=[...g.teams.values()].find(t=>t.role==='runner'); const p=g.players.get(r.playerIds[0]);
 const z={id:'buff-test',type:'buff',centerLat:p.lat,centerLng:p.lng,radiusMeters:200,expiresAt:Date.now()+60000}; g.zones=[z];
 g.checkBuffVision(Date.now()); assert.ok(r.hunterVisionUntil); const first=r.hunterVisionUntil; r.hunterVisionUntil=Date.now()-1; g.checkBuffVision(Date.now()); assert.ok(r.hunterVisionUntil <= Date.now()-1);
}


// 9. Quests are ROAD-ONLY: every quest target (and every stage) sits exactly on a road point
function onRoad(g,lat,lng){ return g.roadPoints.some(p=>p.lat===lat&&p.lng===lng); }
for(const [size,radius] of [[1,1000],[2,3000],[1,8000],[3,5000]]){
  for(let n=0;n<5;n++){
    const g=new Game({teamSize:size,durationSeconds:600,headStartSeconds:0,initialRadiusMeters:radius}); add(g,size*2+(size===1?2:0)); start(g);
    assert.ok(g.quests.length>0,'no quests were made');
    for(const q of g.quests){
      assert.ok(onRoad(g,q.targetLat,q.targetLng),`quest "${q.title}" is off-road`);
      for(const st of q.stages||[]) assert.ok(onRoad(g,st.lat,st.lng),'quest stage is off-road');
    }
    assert.ok(g.quests.some(q=>q.type==='multi_stage'),'runner multi-stage quest missing');
  }
}
// bait quests are road-only too
{
  let baitSeen=0;
  const g=new Game({teamSize:1,durationSeconds:1800,headStartSeconds:0,initialRadiusMeters:3000}); add(g,6); start(g); g.status='active';
  for(let i=0;i<40;i++){
    g.quests=g.quests.filter(q=>!q.isBait); for(const t of g.teams.values()) t.baitCount=0;
    const ref={centerLat:g.centerLat+(Math.random()-0.5)*0.02,centerLng:g.centerLng+(Math.random()-0.5)*0.02,radiusMeters:300+Math.random()*900,expiresAt:Date.now()+120000,relocEndsAt:Date.now()+120000};
    g._spawnBaitQuests(i%2?'danger':'edge',ref);
    for(const q of g.quests.filter(q=>q.isBait)){ baitSeen++; assert.ok(onRoad(g,q.targetLat,q.targetLng),'bait quest is off-road'); }
  }
  assert.ok(baitSeen>0,'no bait quests were ever made, test proves nothing');
}
// no road data = NO quests (never a random off-road spot); they appear once roads load
{
  const g=new Game({teamSize:1,durationSeconds:600,headStartSeconds:0,initialRadiusMeters:3000}); add(g,4);
  const r=g.start(); assert.ok(r.ok,r.error); for(const p of g.players.values())p.hasFix=true;
  assert.equal(g.quests.length,0,'quests were made with no road data'); assert.equal(g.questsPending,true);
  g.status='active'; g._spawnBaitQuests('danger',{centerLat:g.centerLat,centerLng:g.centerLng,radiusMeters:500,expiresAt:Date.now()+60000});
  assert.equal(g.quests.length,0,'bait quest made with no road data');
  g.roadPoints=makeRoads(g); g.roadsLoaded=true; g.tick();
  assert.ok(g.quests.length>0,'quests did not appear after roads loaded'); assert.equal(g.questsPending,false);
  for(const q of g.quests) assert.ok(onRoad(g,q.targetLat,q.targetLng),'late quest is off-road');
}
// only real streets count as roads
{
  const line=[{lat:28.61,lon:77.2},{lat:28.611,lon:77.201},{lat:28.612,lon:77.202}];
  const way=(tags)=>({type:'way',tags,geometry:line});
  for(const h of ['residential','tertiary','secondary','primary','unclassified','living_street','service']) assert.ok(isUsableRoad(way({highway:h})),h+' should count');
  for(const h of ['footway','path','track','cycleway','pedestrian','steps','bridleway','motorway','motorway_link']) assert.ok(!isUsableRoad(way({highway:h})),h+' should NOT count');
  assert.ok(!isUsableRoad(way({highway:'residential',access:'private'})),'private road');
  assert.ok(!isUsableRoad(way({highway:'residential',tunnel:'yes'})),'tunnel');
  assert.ok(!isUsableRoad(way({highway:'service',service:'driveway'})),'driveway');
  assert.ok(!isUsableRoad(way({highway:'service',service:'parking_aisle'})),'parking aisle');
  assert.ok(!isUsableRoad(way({highway:'pedestrian',area:'yes'})),'plaza');
  const pts=sampleRoadPointsFromOverpass([way({highway:'footway'}),way({highway:'track'})],28.611,77.201,5000,100);
  assert.equal(pts.length,0,'footway/track points leaked into road points');
  assert.ok(sampleRoadPointsFromOverpass([way({highway:'residential'})],28.611,77.201,5000,100).length>0);
}


// 10. Zone shrinking: every zone is SMALLER than the one before it, stays fully inside the ORIGINAL zone, and may relocate within it
let relocated=0; // how many new zones stuck out of the previous zone (relocating while shrinking is allowed)
function promote(g){ g.safeZone={...g.pendingSafeZone,phase:'active'}; g.pendingSafeZone=null; }
function checkShrinkRun(g,label){
  const orig={lat:g.centerLat,lng:g.centerLng,r:g.initialRadiusMeters};
  let shrinks=0, prev=g.safeZone.radiusMeters;
  for(let i=0;i<60;i++){
    const cur=g.safeZone;
    if(!g.startShrink(i===59)) break;         // false = already as small as allowed
    const n=g.pendingSafeZone; shrinks++;
    assert.ok(n.radiusMeters<cur.radiusMeters,label+': zone did not get smaller ('+cur.radiusMeters+' -> '+n.radiusMeters+')');
    const off=haversine(cur.centerLat,cur.centerLng,n.centerLat,n.centerLng);
    assert.ok(off<=cur.radiusMeters,label+': new zone centre is outside the current zone (teams could not reach it)');
    if(off+n.radiusMeters>cur.radiusMeters+0.01) relocated++;
    assert.ok(haversine(orig.lat,orig.lng,n.centerLat,n.centerLng)+n.radiusMeters<=orig.r+0.01,label+': new zone is outside the original zone');
    prev=n.radiusMeters; promote(g);
  }
  return shrinks;
}
for(const r of [500,1000,3000,8000,20000]){
  const g=new Game({teamSize:1,durationSeconds:3600,initialRadiusMeters:r}); add(g,4); start(g);
  const n=checkShrinkRun(g,'radius '+r); assert.ok(n>=3,'radius '+r+' only shrank '+n+' times');
}
assert.ok(relocated>0,'zones never relocated, they only ever shrank in place');
{ // tiny game (e.g. an 80m zone): the same rules must hold at that scale
  const g=new Game({teamSize:1,durationSeconds:3600,initialRadiusMeters:3000}); add(g,4); start(g);
  g.initialRadiusMeters=80; g.safeZone={centerLat:g.centerLat,centerLng:g.centerLng,radiusMeters:80,phase:'stable'};
  const n=checkShrinkRun(g,'80m'); assert.ok(n>=3,'80m zone only shrank '+n+' times'); assert.ok(g.safeZone.radiusMeters<80);
}
{ // final circle is smaller than the zone before it, and a normal shrink after it can never make the zone bigger again
  const g=new Game({teamSize:1,durationSeconds:3600,initialRadiusMeters:3000}); add(g,4); start(g);
  assert.ok(g.startShrink(false)); promote(g); const before=g.safeZone.radiusMeters;
  assert.ok(g.startShrink(true)); assert.ok(g.pendingSafeZone.radiusMeters<before); promote(g);
  const fin=g.safeZone.radiusMeters; g.startShrink(false); if(g.pendingSafeZone) assert.ok(g.pendingSafeZone.radiusMeters<fin,'zone grew after the final circle');
}
{ // through the real game loop: shrink starts, then the zone is replaced by the smaller one
  const g=new Game({teamSize:1,durationSeconds:3600,headStartSeconds:0,initialRadiusMeters:3000}); add(g,4); start(g); g.status='active';
  for(const p of g.players.values()){p.lat=g.centerLat;p.lng=g.centerLng;p.hasFix=true;p.isOnline=true;p.lastSeen=Date.now();}
  const r0=g.safeZone.radiusMeters; g.nextShrinkAt=Date.now()-1; g.finalCircleTriggered=true; g.tick();
  assert.ok(g.pendingSafeZone,'tick did not start a shrink'); assert.ok(g.pendingSafeZone.radiusMeters<r0);
  const target=g.pendingSafeZone; g.pendingSafeZone.relocEndsAt=Date.now()-1; g.tick();
  assert.equal(g.pendingSafeZone,null); assert.equal(g.safeZone.radiusMeters,target.radiusMeters);
}


// 11. A team knocked out by the shrinking zone must be recorded as NOT surviving (MVP + Battle Cards depend on it)
{
  const g=new Game({teamSize:1,durationSeconds:3600,headStartSeconds:0,initialRadiusMeters:3000}); add(g,4); start(g); g.status='active';
  const runners=[...g.teams.values()].filter(t=>t.role==='runner');
  const victim=runners[0], safe=runners.slice(1);
  const pl=t=>g.players.get(t.playerIds[0]);
  for(const p of g.players.values()){ p.lat=g.centerLat; p.lng=g.centerLng; p.hasFix=true; p.isOnline=true; p.lastSeen=Date.now(); }
  const v=pl(victim); v.lat=g.centerLat+1500/111320; // 1.5 km out, will be outside a 500 m zone
  g.matchStats.startedAt-=90000; // pretend the game has run for 90 s
  g.pendingSafeZone={centerLat:g.centerLat,centerLng:g.centerLng,radiusMeters:500,relocEndsAt:Date.now()-1,phase:'relocating'};
  g.tick();
  assert.equal(victim.status,'eliminated','runner outside the new zone was not eliminated');
  const ms=g.matchStats.teams[victim.id];
  assert.equal(ms.survived,false,'zone-eliminated team still marked survived'); assert.ok(ms.eliminatedAt>0,'no eliminatedAt for zone-eliminated team');
  for(const t of safe) assert.equal(g.matchStats.teams[t.id].survived,true);
  g.endGame('host');
  assert.ok(g.matchStats.teams[victim.id].surviveSeconds>=89&&g.matchStats.teams[victim.id].surviveSeconds<=95,'survive time wrong: '+g.matchStats.teams[victim.id].surviveSeconds);
  const card=g.getStateFor(v.id).battleCards.find(c=>c.teamId===victim.id);
  assert.equal(card.survived,false,'battle card says the eliminated team survived'); assert.equal(card.status,'eliminated');
}

console.log('BACKEND HARD TESTS: PASS');
