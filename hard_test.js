const assert=require('assert');
const {Game,isInside,haversine}=require('./backend/server');
function add(g,n){return Array.from({length:n},(_,i)=>g.addPlayer('P'+i));}
function start(g){const r=g.start();assert.ok(r.ok,r.error);for(const p of g.players.values())p.hasFix=true;} // test phones all have a GPS fix
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

console.log('BACKEND HARD TESTS: PASS');
