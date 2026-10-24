/**
 * IRL TAG - Complete Authoritative Server
 * Full mechanics: shrinking safe zone, multi-stage quests, vision buffs,
 * custom team size, Extra Health, Ghost Mode, Danger/Buff zones, etc.
 */
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
function genId() { return crypto.randomBytes(6).toString('hex'); }
function genCode(len=6) {
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s='';
  for(let i=0;i<len;i++) s+=c[Math.floor(Math.random()*c.length)]; return s;
}
function genTeamCode(){
  // Short, human-shareable team code. Never expose this to Taggers until a physical catch.
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s='';
  for(let i=0;i<3;i++) s+=c[Math.floor(Math.random()*c.length)];
  return s;
}
function teamColor(number){
  const palette=['#ef4444','#22c55e','#3b82f6','#a855f7','#f59e0b','#06b6d4','#ec4899','#84cc16','#f97316','#14b8a6','#8b5cf6','#eab308'];
  return palette[(Math.max(1,number)-1)%palette.length];
}
function haversine(a,b,c,d){
  const R=6371000,toR=x=>x*Math.PI/180;
  const dLat=toR(c-a),dLng=toR(d-b);
  const x=Math.sin(dLat/2)**2+Math.cos(toR(a))*Math.cos(toR(c))*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function isInside(lat,lng,cLat,cLng,r){ return haversine(lat,lng,cLat,cLng)<=r; }
function randomPointInCircle(cLat,cLng,radiusMeters){
  const u=Math.random(), v=Math.random();
  const dist=Math.sqrt(u)*radiusMeters, angle=2*Math.PI*v;
  const lat=cLat+(dist*Math.cos(angle))/111320;
  const lng=cLng+(dist*Math.sin(angle))/(111320*Math.max(0.2,Math.cos(cLat*Math.PI/180)));
  return {lat,lng};
}
function clampNumber(v,min,max,fallback){
  const n=Number(v); return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;
}

class Game {
  constructor(settings={}){
    this.id=genId(); this.code=genCode(6); this.status='lobby'; this.createdAt=Date.now();
    this.durationSeconds=clampNumber(settings.durationSeconds,300,10800,1800);
    this.snapshotIntervalSeconds=clampNumber(settings.snapshotIntervalSeconds,30,1800,300);
    this.headStartSeconds=clampNumber(settings.headStartSeconds,0,1800,300);
    this.centerLat=Number.isFinite(Number(settings.centerLat))?Number(settings.centerLat):28.6139;
    this.centerLng=Number.isFinite(Number(settings.centerLng))?Number(settings.centerLng):77.2090;
    this.initialRadiusMeters=clampNumber(settings.initialRadiusMeters,500,20000,3000);
    // Host-selected team size. Supported: 1–8 players per team.
    this.teamSize=Math.floor(clampNumber(settings.teamSize,1,8,2));
    this.teamFormation=settings.teamFormation==='choose'?'choose':'random';
    // Custom mode: host sets how many Runners and Taggers play (runners are solo teams, taggers are one team)
    this.teamMode=settings.teamMode==='custom'?'custom':'standard';
    this.customRunners=Math.floor(clampNumber(settings.customRunners,1,60,3));
    this.customTaggers=Math.floor(clampNumber(settings.customTaggers,1,60,1));
    if(this.teamMode==='custom') this.teamFormation='random';
    this.safePeriodSeconds=Math.min(clampNumber(settings.safePeriodSeconds,60,3600,900), Math.max(60, Math.floor(this.durationSeconds*0.4)));
    // Relocation warnings can never be shorter than the baseline 2 minutes.
    this.zoneTransitionSeconds=Math.max(120,clampNumber(settings.zoneTransitionSeconds,120,900,120));
    this.zoneMinIntervalSeconds=clampNumber(settings.zoneMinIntervalSeconds,60,3600,600);
    this.zoneMaxIntervalSeconds=clampNumber(settings.zoneMaxIntervalSeconds,this.zoneMinIntervalSeconds,7200,1200);
    this.zoneDifficulty=settings.zoneDifficulty||'hard';
    this.buffSpawnChance=clampNumber(settings.buffSpawnChance,0,1,0.15);
    this.maxBuffZonesPerGame=Math.floor(clampNumber(settings.maxBuffZonesPerGame,0,10,1));
    this.buffZonesSpawned=0;
    this.players=new Map(); this.teams=new Map();
    this.chat=[]; this.snapshots=[]; this.tags=[]; this.quests=[]; this.zones=[];
    this.startedAt=null; this.endsAt=null; this.headStartEndsAt=null;
    this.nextSnapshotAt=null; this.nextZoneAt=null; this.nextShrinkAt=null;
    this.winner=null; this.forfeit=null; this.hostPlayerId=null;
    this.safeZone={ centerLat:this.centerLat, centerLng:this.centerLng, radiusMeters:this.initialRadiusMeters, phase:'stable' };
    this.pendingSafeZone=null; // {centerLat,centerLng,radiusMeters,relocEndsAt}
    this.visionEffects=[]; // temporary hunter/runner vision
    this.finalCircleTriggered=false;
    this.shrinkCount=0;
    this.matchStats={ teams:{}, tags:0, questsCompleted:0, startedAt:null };
    this.callouts=[]; this.playerStats=new Map(); this.mvp=null;
  }

  addPlayer(name){
    const id=genId();
    const p={ id, sessionToken:crypto.randomBytes(32).toString('hex'), name:(name||'Player').slice(0,20), teamId:null, teammateId:null, isReady:false, isOnline:true,
      lat:this.centerLat, lng:this.centerLng, accuracyMeters:null, lastLocationAt:Date.now(), lastSeen:Date.now(), suspiciousLocation:false, chatTimes:[] };
    this.players.set(id,p);
    if(!this.hostPlayerId) this.hostPlayerId=id;
    return p;
  }

  removePlayer(targetId,byId){
    if(this.status!=='lobby') return {error:'Game already started'};
    if(!this.players.has(targetId)) return {error:'Player not found'};
    if(targetId!==byId&&byId!==this.hostPlayerId) return {error:'Only the host can remove players'};
    this.players.delete(targetId);
    for(const p of this.players.values()) if(p.teammateId===targetId) p.teammateId=null;
    if(this.hostPlayerId===targetId){ const next=this.players.values().next().value; this.hostPlayerId=next?next.id:null; }
    return {ok:true};
  }

  formTeams(){
    if(this.teamMode==='custom') return this._formCustomTeams();
    const list=Array.from(this.players.values());
    for(const p of list) p.teamId=null;
    const size=this.teamSize||2;

    if(this.teamFormation==='random') {
      for(let i=list.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [list[i],list[j]]=[list[j],list[i]]; }
    } else {
      // Choose-teammates mode: mutually selected pairs are atomic units and
      // must never be split across teams. Remaining players are then placed
      // into the remaining team slots. This works for team sizes 2–8.
      const byId=new Map(list.map(p=>[p.id,p]));
      const locked=new Set();
      const pairUnits=[];
      const singles=[];

      for(const p of list){
        if(locked.has(p.id)) continue;
        const other=p.teammateId ? byId.get(p.teammateId) : null;
        if(other && other.id!==p.id && other.teammateId===p.id && !locked.has(other.id) && size>=2){
          pairUnits.push([p,other]);
          locked.add(p.id); locked.add(other.id);
        } else {
          singles.push(p);
        }
      }

      // Randomize only the order of complete units. Never flatten and shuffle
      // them, because doing that can separate a chosen pair.
      for(let i=pairUnits.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [pairUnits[i],pairUnits[j]]=[pairUnits[j],pairUnits[i]]; }
      for(let i=singles.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [singles[i],singles[j]]=[singles[j],singles[i]]; }

      const teamBuckets=[];
      const teamCount=list.length/size;
      for(let i=0;i<teamCount;i++) teamBuckets.push([]);

      // Put each preserved pair into a team with enough free capacity.
      for(const pair of pairUnits){
        const candidates=teamBuckets.filter(b=>b.length+2<=size);
        if(!candidates.length){
          // This should only be reachable for an impossible packing case.
          // Fall back to singles rather than ever silently splitting the pair.
          singles.push(...pair);
          continue;
        }
        const bucket=candidates[Math.floor(Math.random()*candidates.length)];
        bucket.push(...pair);
      }

      // Fill all remaining slots with unpaired players.
      for(const p of singles){
        const candidates=teamBuckets.filter(b=>b.length<size);
        if(!candidates.length) throw new Error('Team formation capacity error');
        const bucket=candidates[Math.floor(Math.random()*candidates.length)];
        bucket.push(p);
      }

      list.splice(0,list.length,...teamBuckets.flat());
    }

    this.teams.clear();
    const usedCodes=new Set();
    const uniqueTeamCode=()=>{ let code; do code=genTeamCode(); while(usedCodes.has(code)); usedCodes.add(code); return code; };
    let num=1;
    for(let i=0;i+size-1<list.length;i+=size){
      const teamId=genId(); const pids=[];
      for(let k=0;k<size;k++) pids.push(list[i+k].id);
      const team={ id:teamId, number:num++, name:'Team '+(num-1), color:teamColor(num-1), secretCode:uniqueTeamCode(),
        role:'runner', health:1, hasExtraHealth:false, isGhostMode:false, ghostUntil:null,
        status:'active', playerIds:pids, penaltyUntil:null, powerups:[], ghostCharges:0, smokeCharges:0, visionCharges:0, snapshotCharges:0, pingCharges:1, pingCooldownUntil:null,
        hunterVisionUntil:null, runnerVisionUntil:null, usedBuffZoneIds:[] };
      this.teams.set(teamId,team);
      for(const pid of pids) this.players.get(pid).teamId=teamId;
    }
  }

  _formCustomTeams(){
    const list=Array.from(this.players.values());
    for(const p of list) p.teamId=null;
    for(let i=list.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [list[i],list[j]]=[list[j],list[i]]; }
    this.teams.clear();
    const used=new Set(); const code=()=>{ let c; do c=genTeamCode(); while(used.has(c)); used.add(c); return c; };
    let num=1;
    const add=(members,role)=>{
      const teamId=genId();
      const team={ id:teamId, number:num, name:'Team '+num, color:teamColor(num), secretCode:code(),
        role, health:1, hasExtraHealth:false, isGhostMode:false, ghostUntil:null,
        status:'active', playerIds:members.map(p=>p.id), penaltyUntil:null, powerups:[], ghostCharges:0, smokeCharges:0, visionCharges:0, snapshotCharges:0, pingCharges:1, pingCooldownUntil:null,
        hunterVisionUntil:null, runnerVisionUntil:null, usedBuffZoneIds:[] };
      num++; this.teams.set(teamId,team); for(const p of members) p.teamId=teamId;
    };
    add(list.slice(0,this.customTaggers),'tagger');            // all taggers hunt together as ONE team
    for(const p of list.slice(this.customTaggers)) add([p],'runner'); // every runner plays solo
  }

  assignTagger(){
    if(this.teamMode==='custom') return;
    const ids=Array.from(this.teams.keys());
    if(!ids.length) return;
    this.teams.get(ids[Math.floor(Math.random()*ids.length)]).role='tagger';
  }

  generateQuests(){
    this.quests=[];
    for(const team of this.teams.values()){
      if(team.role==='runner'){
        // Extra Health is intentionally rare: only one extreme, timed, multi-stage quest.
        this._addMultiStage(team);
        this._addQuest(team,['checkpoint','hold','distance'][Math.floor(Math.random()*3)]); // earns ONE Ghost charge
      } else {
        this._addTaggerQuest(team);
      }
    }
  }

  _pointNear(lat,lng,minD,maxD){
    const d=minD+Math.random()*(maxD-minD), b=Math.random()*2*Math.PI;
    return {lat:lat+d*Math.cos(b)/111320, lng:lng+d*Math.sin(b)/(111320*Math.cos(lat*Math.PI/180))};
  }

  _addQuest(team,type){
    let point=randomPointInCircle(this.centerLat,this.centerLng,Math.max(100,this.initialRadiusMeters-120));
    const fixed=team.playerIds.map(id=>this.players.get(id)).filter(p=>p&&p.hasFix);
    if(fixed.length){ // put the easy quest close to where the team actually is
      const a=fixed[0]; const c=this._pointNear(a.lat,a.lng,150,Math.min(600,this.initialRadiusMeters*0.4));
      if(haversine(c.lat,c.lng,this.centerLat,this.centerLng)<=this.initialRadiusMeters-120) point=c;
    }
    const q={ id:genId(), teamId:team.id, type, status:'available',
      title:'', description:'', targetLat:point.lat, targetLng:point.lng,
      radiusMeters:70, holdSeconds:40, distanceRequired:350, distanceTravelled:0,
      stages:[], currentStage:0, startedAt:null, holdStart:null,
      reward: (()=>{ const r=Math.random(); if(r<0.25) return 'smoke'; if(r<0.5) return 'vision_burst'; return 'ghost_mode'; })(), completedAt:null };
    if(type==='checkpoint'){ q.title='Checkpoint'; q.description='Reach the marked location.'; }
    else if(type==='hold'){ q.title='Hold Position'; q.description=`Stay at the point for ${q.holdSeconds}s.`; }
    else { q.title='Distance Run'; q.description=`Travel ${q.distanceRequired}m.`; q.type='distance'; }
    this.quests.push(q);
  }

  _addMultiStage(team){
    const stages=[];
    const questRadius=Math.max(100,this.initialRadiusMeters-150);
    let prev=randomPointInCircle(this.centerLat,this.centerLng,questRadius);
    const fx=team.playerIds.map(id=>this.players.get(id)).find(p=>p&&p.hasFix);
    if(fx){ for(let k=0;k<30;k++){ const c=this._pointNear(fx.lat,fx.lng,250,Math.min(900,questRadius*0.5)); if(haversine(c.lat,c.lng,this.centerLat,this.centerLng)<=questRadius){prev=c;break;} } }
    stages.push({lat:prev.lat,lng:prev.lng,radius:60});
    for(let i=1;i<3;i++){
      const leg=Math.min(800,Math.max(150,questRadius*0.4)); let pt=null;
      for(let k=0;k<40&&!pt;k++){ const c=this._pointNear(prev.lat,prev.lng,leg*0.55,leg); if(haversine(c.lat,c.lng,this.centerLat,this.centerLng)<=questRadius) pt=c; }
      if(!pt) pt=randomPointInCircle(this.centerLat,this.centerLng,questRadius);
      stages.push({lat:pt.lat,lng:pt.lng,radius:60}); prev=pt;
    }
    this.quests.push({
      id:genId(), teamId:team.id, type:'multi_stage', status:'available',
      title:'EXTREME: Three-Point Extraction',
      description:'Go to checkpoint 1 (no rush). Your 12-minute clock starts there: reach checkpoints 2 and 3 in order, then hold the last point for 2 minutes.',
      stages, currentStage:0, holdSeconds:120, holdStart:null,
      targetLat:stages[0].lat, targetLng:stages[0].lng, radiusMeters:60,
      reward:'extra_health', questTimeLimitSeconds:720, startedAt:null, completedAt:null, distanceTravelled:0
    });
  }

  _addTaggerQuest(team){
    const point=randomPointInCircle(this.centerLat,this.centerLng,Math.max(100,this.initialRadiusMeters-150));
    this.quests.push({
      id:genId(), teamId:team.id, type:'checkpoint', status:'available',
      title:'Hunter Mark', description:'Reach the marked point to gain a bonus snapshot.',
      targetLat:point.lat, targetLng:point.lng, radiusMeters:80,
      reward:'bonus_snapshot', startedAt:null, completedAt:null, holdStart:null, distanceTravelled:0, stages:[], currentStage:0
    });
  }

  setTeammate(playerId, teammateId){
    if(this.status!=='lobby') return {error:'Team selection is locked after the game starts'};
    const player=this.players.get(playerId);
    if(!player) return {error:'Player not found'};
    if(this.teamFormation!=='choose') return {error:'Choose-teammates mode is not enabled'};
    if(teammateId===null||teammateId===undefined||String(teammateId)==='') {
      player.teammateId=null;
      return {ok:true,teammateId:null};
    }
    teammateId=String(teammateId);
    const teammate=this.players.get(teammateId);
    if(!teammate||teammate.id===player.id) return {error:'Invalid teammate'};
    player.teammateId=teammate.id;
    return {ok:true,teammateId:teammate.id};
  }

  start(){
    if(this.status!=='lobby') return {error:'Already started'};
    const custom=this.teamMode==='custom';
    if(custom){ const need=this.customRunners+this.customTaggers; if(this.players.size!==need) return {error:`Custom game needs exactly ${need} players (${this.customRunners} runners + ${this.customTaggers} taggers). You have ${this.players.size}.`}; }
    const size=this.teamSize||2;
    if(this.players.size<2) return {error:'Need at least 2 players'};
    if(!custom && this.players.size % size !==0) return {error:`Team size is ${size}. You need a total number of players divisible by ${size}.`};
    const teamCount=this.players.size/size;
    if(!custom && teamCount<2) return {error:`Need at least 2 teams. With ${size} players per team, add more players before starting.`};
    if(!custom && this.teamFormation==='choose' && size>=2){
      const seen=new Set(); let mutualPairs=0;
      for(const p of this.players.values()){
        if(seen.has(p.id)||!p.teammateId) continue;
        const other=this.players.get(p.teammateId);
        if(other && other.teammateId===p.id && other.id!==p.id){ mutualPairs++; seen.add(p.id); seen.add(other.id); }
      }
      const maxPairs=Math.floor(size/2)*teamCount;
      if(mutualPairs>maxPairs){
        return {error:`Too many selected teammate pairs for the configured team size. ${mutualPairs} pairs were selected, but only ${maxPairs} can fit without splitting pairs. Remove ${mutualPairs-maxPairs} pair selection(s) or increase the team size.`};
      }
    }
    this.formTeams(); this.assignTagger(); this.generateQuests();
    this.matchStats.startedAt=Date.now();
    for(const t of this.teams.values()){
      this.matchStats.teams[t.id]={ number:t.number, role:t.role, distanceM:0, quests:0, tagsMade:0, survived:true, eliminatedAt:null };
    }
    this.status='head_start';
    this.startedAt=Date.now();
    this.headStartEndsAt=this.startedAt+this.headStartSeconds*1000;
    this.endsAt=this.headStartEndsAt+this.durationSeconds*1000;
    this.nextSnapshotAt=this.headStartEndsAt+this.snapshotIntervalSeconds*1000;
    this.nextZoneAt=this.headStartEndsAt+this.randomZoneDelayMs();
    this.nextShrinkAt=this.headStartEndsAt+this.safePeriodSeconds*1000;
    return {ok:true};
  }

  randomZoneDelayMs(){
    const min=this.zoneMinIntervalSeconds*1000, max=this.zoneMaxIntervalSeconds*1000;
    return min+Math.random()*Math.max(0,max-min);
  }

  nextShrinkDelayMs(){
    // Zone progression scales with total game duration: short games move quickly,
    // long games move deliberately slowly. Jitter prevents predictable timing.
    const base=Math.max(60000, Math.min(600000, this.durationSeconds*1000/10));
    const jitter=0.85+Math.random()*0.30;
    return base*jitter;
  }

  tick(){
    const now=Date.now();
    for(const p of this.players.values()) p.isOnline=(now-p.lastSeen)<15000;

    if(this.status==='head_start' && now>=this.headStartEndsAt) this.status='active';

    if(this.status==='active'){
      if(now>=this.nextSnapshotAt){ this.takeSnapshot(); this.nextSnapshotAt=now+this.snapshotIntervalSeconds*1000; }
      if(now>=this.nextZoneAt){ this.spawnZone(); this.nextZoneAt=now+this.randomZoneDelayMs(); }
      this.zones=this.zones.filter(z=>z.expiresAt>now);

      // Ghost expire
      for(const t of this.teams.values()){
        if(t.isGhostMode && t.ghostUntil && now>=t.ghostUntil){ t.isGhostMode=false; t.ghostUntil=null; }
        if(t.hunterVisionUntil && now>=t.hunterVisionUntil) t.hunterVisionUntil=null;
        if(t.runnerVisionUntil && now>=t.runnerVisionUntil) t.runnerVisionUntil=null;
      }

      // Safe zone shrink
      if(this.pendingSafeZone && now>=this.pendingSafeZone.relocEndsAt){
        this.safeZone={ ...this.pendingSafeZone, phase:'active' };
        this.pendingSafeZone=null;
        // Eliminate players still outside
        for(const t of this.teams.values()){
          if(t.status!=='active' || t.role!=='runner') continue;
          let inside=false;
          for(const pid of t.playerIds){
            const p=this.players.get(pid);
            if(p && isInside(p.lat,p.lng,this.safeZone.centerLat,this.safeZone.centerLng,this.safeZone.radiusMeters)) inside=true;
          }
          if(!inside){ t.status='eliminated'; t.health=0; }
        }
      }
      // Final circle: last ~18% of game forces a small end zone once
      const timeLeft = this.endsAt - now;
      const finalWindow = Math.max(180000, this.durationSeconds * 1000 * 0.18);
      if(!this.finalCircleTriggered && !this.pendingSafeZone && timeLeft > 0 && timeLeft <= finalWindow){
        this.finalCircleTriggered=true;
        this.startShrink(true);
      } else if(!this.pendingSafeZone && this.nextShrinkAt && now>=this.nextShrinkAt){
        this.startShrink(false);
        this.nextShrinkAt=now+this.nextShrinkDelayMs();
      }

      this.processQuests(now);
      this.checkBuffVision(now);

      if(now>=this.endsAt) this.endGame('runners');
      else {
        const active=[...this.teams.values()].filter(t=>t.role==='runner'&&t.status==='active');
        if(active.length===0) this.endGame('taggers');
      }
    }
  }

  startShrink(isFinal=false){
    const cur=this.safeZone;
    this.shrinkCount=(this.shrinkCount||0)+1;
    const newRadius=isFinal
      ? Math.max(180, Math.min(cur.radiusMeters*0.45, this.initialRadiusMeters*0.22))
      : Math.max(250, cur.radiusMeters*0.75);
    // New safe zone is chosen anywhere in the ORIGINAL playable circle, not around the host/current center.
    // Keep the entire new circle inside the original boundary.
    const maxCenterDistance=Math.max(0,this.initialRadiusMeters-newRadius);
    let point=null;
    for(let i=0;i<60&&!point;i++){
      const c=randomPointInCircle(this.centerLat,this.centerLng,maxCenterDistance);
      if(haversine(c.lat,c.lng,cur.centerLat,cur.centerLng)<=cur.radiusMeters*0.75) point=c; // always reachable from the old zone
    }
    if(!point) point={lat:cur.centerLat,lng:cur.centerLng};
    this.pendingSafeZone={
      centerLat: point.lat,
      centerLng: point.lng,
      radiusMeters: newRadius,
      relocEndsAt: Date.now()+this.zoneTransitionSeconds*1000,
      phase:'relocating'
    };
    if(!isFinal) this._spawnBaitQuests('edge',this.pendingSafeZone);
  }

  takeSnapshot(){
    const positions=[];
    for(const team of this.teams.values()){
      if(team.role!=='runner'||team.status!=='active') continue;
      let lat=0,lng=0,count=0;
      for(const pid of team.playerIds){ const p=this.players.get(pid); if(p&&p.isOnline&&p.hasFix){lat+=p.lat;lng+=p.lng;count++;} }
      if(count) positions.push({teamId:team.id,teamNumber:team.number,teamColor:team.color,lat:lat/count,lng:lng/count});
    }
    this.snapshots.push({takenAt:Date.now(),positions});
    if(this.snapshots.length>8) this.snapshots.shift();
  }

  spawnZone(){
    // Buffs are rare and capped. Danger zones remain the more common event.
    const canBuff=this.buffZonesSpawned<this.maxBuffZonesPerGame;
    const type=(canBuff && Math.random()<this.buffSpawnChance)?'buff':'danger';
    if(type==='buff') this.buffZonesSpawned++;
    // Keep zones well inside the original boundary so the full zone is reachable.
    const radius=type==='buff'?120:140;
    const maxCenterDistance=Math.max(0,this.initialRadiusMeters-radius-50);
    if(maxCenterDistance<50) return;
    const point=randomPointInCircle(this.centerLat,this.centerLng,maxCenterDistance);
    const zone={
      id:genId(), type, centerLat:point.lat, centerLng:point.lng,
      radiusMeters:radius,
      expiresAt:Date.now()+(type==='buff'?90:120)*1000
    };
    this.zones.push(zone);
    if(type==='danger') this._spawnBaitQuests('danger',zone);
  }

  checkBuffVision(now){
    for(const z of this.zones){
      if(z.type!=='buff') continue;
      for(const t of this.teams.values()){
        if(t.status!=='active' || (t.usedBuffZoneIds||[]).includes(z.id)) continue;
        let inside=false;
        for(const pid of t.playerIds){
          const p=this.players.get(pid);
          if(p && isInside(p.lat,p.lng,z.centerLat,z.centerLng,z.radiusMeters)){ inside=true; break; }
        }
        if(inside){
          t.usedBuffZoneIds.push(z.id);
          if(t.role==='runner') t.hunterVisionUntil=now+12000;
          if(t.role==='tagger') t.runnerVisionUntil=now+12000;
        }
      }
    }
  }

  updateLocation(playerId,lat,lng,accuracyMeters,timestamp){
    const p=this.players.get(playerId);
    if(!p){ console.warn('[GPS REJECT] player_not_found', {playerId}); return {error:'Player not found', reason:'player_not_found'}; }
    const raw={lat,lng,accuracyMeters,timestamp};
    lat=Number(lat); lng=Number(lng); accuracyMeters=Number(accuracyMeters); timestamp=Number(timestamp);
    if(!Number.isFinite(lat)||!Number.isFinite(lng)||lat<-90||lat>90||lng<-180||lng>180){
      console.warn('[GPS REJECT] invalid_coordinates', raw);
      return {error:'Invalid GPS coordinates', reason:'invalid_coordinates'};
    }
    if(!Number.isFinite(accuracyMeters)||accuracyMeters<0||accuracyMeters>500){
      console.warn('[GPS REJECT] accuracy_out_of_range', {playerId,accuracyMeters,lat,lng,timestamp});
      return {error:'GPS accuracy is too poor', reason:'accuracy_out_of_range', accuracyMeters};
    }
    if(!Number.isFinite(timestamp)){
      console.warn('[GPS REJECT] invalid_timestamp', {playerId,timestamp});
      return {error:'Invalid GPS timestamp', reason:'invalid_timestamp'};
    }
    const now=Date.now();
    if(timestamp<now-30000 || timestamp>now+5000){
      console.warn('[GPS REJECT] stale_timestamp', {playerId,timestamp,serverNow:now,ageMs:now-timestamp});
      return {error:'Stale GPS sample', reason:'stale_timestamp', serverNow:now, sampleTimestamp:timestamp};
    }
    const team=p.teamId?this.teams.get(p.teamId):null;
    // Extra Health creates a real movement lock for the Tagger team.
    // GPS samples received during the penalty are rejected, so the authoritative
    // player position remains frozen at the position where the penalty began.
    if(team && team.role==='tagger' && team.penaltyUntil && now < team.penaltyUntil){
      return {error:'MOVEMENT_PENALTY', message:"Sorry, you are under penalty, you can\'t move right now.", penaltyUntil:team.penaltyUntil};
    }
    {
      const el0=Math.max(1,(now-p.lastLocationAt)/1000);
      if(p.hasFix&&(p.accuracyMeters||0)<=100&&accuracyMeters<=100){
        const jump0=haversine(p.lat,p.lng,lat,lng);
        if(jump0>Math.max(200,30*el0)){
          console.warn('[GPS REJECT] impossible_movement',{playerId,jump0,el0});
          return {error:'Impossible movement (GPS jump)', reason:'impossible_movement'};
        }
      }
    }
    if(team){
      const quest=this.quests.find(q=>q.teamId===team.id&&q.status==='active'&&q.type==='distance');
      if(quest){ const d=haversine(p.lat,p.lng,lat,lng); if(d<250) quest.distanceTravelled+=d; }
      const d2=haversine(p.lat,p.lng,lat,lng);
      if(d2<250 && this.matchStats.teams[team.id]) this.matchStats.teams[team.id].distanceM += d2;
      if(d2<250) this._ps(playerId).distanceM += d2;
    }
    const elapsed=Math.max(1,(now-p.lastLocationAt)/1000);
    const jump=haversine(p.lat,p.lng,lat,lng);
    const speed=jump/elapsed;
    // GPS can drift, so do not hard-reject ordinary movement. Flag physically implausible jumps for review.
    p.suspiciousLocation=speed>80 || (accuracyMeters>150 && jump>200);
    p.lat=lat; p.lng=lng; p.accuracyMeters=accuracyMeters; p.lastLocationAt=now; p.lastSeen=now; p.hasFix=true;
    return {ok:true,suspicious:p.suspiciousLocation};
  }

  activateQuest(playerId,questId){
    const p=this.players.get(playerId); if(!p||!p.teamId) return {error:'No team'};
    const team=this.teams.get(p.teamId);
    if(!team||team.status!=='active') return {error:'Not active'};
    const quest=this.quests.find(q=>q.id===questId&&q.teamId===team.id);
    if(!quest||quest.status!=='available') return {error:'Quest not available'};
    if(this.quests.some(q=>q.teamId===team.id&&q.status==='active')) return {error:'Already have active quest'};
    quest.status='active'; quest.startedAt=Date.now(); quest.holdStart=null; quest.distanceTravelled=0; quest.currentStage=0; quest.activatedBy=playerId;
    if(quest.type==='multi_stage'&&quest.stages.length){
      quest.targetLat=quest.stages[0].lat; quest.targetLng=quest.stages[0].lng;
    }
    return {ok:true};
  }

  processQuests(now){
    for(const q of this.quests) if(q.isBait&&q.status==='available'&&q.expiresAt&&now>q.expiresAt) q.status='expired';
    for(const quest of this.quests){
      if(quest.status!=='active') continue;
      const team=this.teams.get(quest.teamId);
      if(!team||team.status!=='active'){ quest.status='failed'; continue; }
      if(quest.questTimeLimitSeconds && quest.startedAt && quest.currentStage>0 && now-quest.startedAt>quest.questTimeLimitSeconds*1000){ quest.status='failed'; continue; }
      const members=team.playerIds.map(pid=>this.players.get(pid)).filter(p=>p&&p.isOnline);
      if(!members.length) continue;

      // Team quests are shared: ANY ONE team member can progress or complete the quest.
      // The reward belongs to the team, not to the individual who happened to finish it.
      if(quest.type==='checkpoint'){
        if(members.some(p=>isInside(p.lat,p.lng,quest.targetLat,quest.targetLng,quest.radiusMeters))) this.completeQuest(quest,team);
      } else if(quest.type==='hold'){
        const memberInside=members.some(p=>isInside(p.lat,p.lng,quest.targetLat,quest.targetLng,quest.radiusMeters));
        if(memberInside){
          if(!quest.holdStart) quest.holdStart=now;
          else if(now-quest.holdStart>=quest.holdSeconds*1000) this.completeQuest(quest,team);
        } else quest.holdStart=null;
      } else if(quest.type==='distance'){
        if(quest.distanceTravelled>=quest.distanceRequired) this.completeQuest(quest,team);
      } else if(quest.type==='multi_stage'){
        const stage=quest.stages[quest.currentStage];
        if(!stage) continue;
        const memberInside=members.some(p=>isInside(p.lat,p.lng,stage.lat,stage.lng,stage.radius));
        if(memberInside){
          if(quest.currentStage < quest.stages.length-1){
            quest.currentStage++; if(quest.currentStage===1) quest.startedAt=now; // 12-min clock starts at checkpoint 1
            quest.targetLat=quest.stages[quest.currentStage].lat;
            quest.targetLng=quest.stages[quest.currentStage].lng;
            quest.holdStart=null;
          } else {
            // Any one team member may perform the final hold. At least one member must remain inside.
            if(!quest.holdStart) quest.holdStart=now;
            else if(now-quest.holdStart>=(quest.holdSeconds||30)*1000) this.completeQuest(quest,team);
          }
        } else if(quest.currentStage===quest.stages.length-1) quest.holdStart=null;
      }
    }
  }

  completeQuest(quest,team){
    quest.status='completed'; quest.completedAt=Date.now();
    if(quest.reward==='extra_health'){
      // Extra Health is a TEAM reward. Rotate the secret code immediately so the next
      // Tagger entry uses the new code and can trigger the server-side health protection.
      if(!team.hasExtraHealth){
        team.hasExtraHealth=true;
        let nextCode;
        const used=new Set([...this.teams.values()].map(t=>t.secretCode));
        do nextCode=genTeamCode(); while(used.has(nextCode));
        team.secretCode=nextCode;
        team.extraHealthAwardedAt=Date.now();
      }
    } else if(quest.reward==='ghost_mode'){
      team.ghostCharges=Math.min(2,(team.ghostCharges||0)+1);
    } else if(quest.reward==='bonus_snapshot'){
      this.takeSnapshot();
      team.snapshotCharges=Math.min(2,(team.snapshotCharges||0)+1);
    } else if(quest.reward==='smoke'){
      team.smokeCharges=Math.min(2,(team.smokeCharges||0)+1);
    } else if(quest.reward==='vision_burst'){
      team.visionCharges=Math.min(2,(team.visionCharges||0)+1);
    } else if(quest.reward==='vision_burst_x2'){
      // bait quest reward: TWO Vision Bursts (better than any normal quest, which gives one)
      team.visionCharges=Math.min(3,(team.visionCharges||0)+2);
    }
    if(this.matchStats.teams[team.id]) this.matchStats.teams[team.id].quests += 1;
    if(quest.activatedBy){ const qs=this._ps(quest.activatedBy); qs.quests+=1; if(quest.isBait) qs.baitQuests+=1; }
    this.matchStats.questsCompleted = (this.matchStats.questsCompleted||0)+1;
  }

  extraHealthPenaltySeconds(){
    // Scale with game length: 10 min -> 1 min, 60 min -> 5 min.
    return Math.round(Math.min(300,Math.max(60,this.durationSeconds/12)));
  }

  tagTeam(taggerPlayerId,code){
    const tagger=this.players.get(taggerPlayerId);
    if(!tagger||!tagger.teamId) return {error:'Not in a team'};
    const taggerTeam=this.teams.get(tagger.teamId);
    if(!taggerTeam||taggerTeam.role!=='tagger') return {error:'Only Taggers can tag'};
    if(this.status!=='active') return {error:'Tagging is locked until Taggers are released'};
    if(taggerTeam.penaltyUntil&&Date.now()<taggerTeam.penaltyUntil) return {error:'Under movement penalty'};
    const nowT=Date.now();
    if(taggerTeam.tagLockUntil&&nowT<taggerTeam.tagLockUntil) return {error:`Too many wrong codes. Wait ${Math.ceil((taggerTeam.tagLockUntil-nowT)/1000)}s`,locked:true};
    const codeStr=String(code||'').trim().toUpperCase();
    let target=null;
    for(const t of this.teams.values()){
      if(t.secretCode&&t.secretCode.toUpperCase()===codeStr&&t.role==='runner'&&t.status==='active'){ target=t; break; }
    }
    if(!target){
      taggerTeam.tagFails=(taggerTeam.tagFails||[]).filter(x=>nowT-x<60000); taggerTeam.tagFails.push(nowT);
      if(taggerTeam.tagFails.length>=3){ taggerTeam.tagLockUntil=nowT+60000; taggerTeam.tagFails=[]; return {error:'Wrong code 3 times. Tagging locked for 60s.',locked:true}; }
      return {error:`Invalid or eliminated Team Code (${3-taggerTeam.tagFails.length} tries left)`};
    }
    taggerTeam.tagFails=[];
    if(target.hasExtraHealth){
      target.hasExtraHealth=false;
      const penaltySeconds=this.extraHealthPenaltySeconds();
      taggerTeam.penaltyUntil=Date.now()+penaltySeconds*1000;
      const minutes=Math.floor(penaltySeconds/60), seconds=penaltySeconds%60;
      const penaltyLabel=minutes?`${minutes}:${String(seconds).padStart(2,'0')}`:`0:${String(seconds).padStart(2,'0')}`;
      if(this.matchStats.teams[taggerTeam.id]) this.matchStats.teams[taggerTeam.id].tagsMade += 1;
      this.matchStats.tags = (this.matchStats.tags||0)+1;
      this._ps(taggerPlayerId).absorbed+=1;
      this.tags.push({at:Date.now(),taggerTeamId:taggerTeam.id,runnerTeamId:target.id,result:'extra_health',penaltySeconds});
      return {ok:true,result:'extra_health',penaltySeconds,message:`EXTRA HEALTH ACTIVATED — TAG ABSORBED. STOP FOR ${penaltyLabel} AND LET THE RUNNERS ESCAPE.`};
    } else {
      target.status='eliminated'; target.health=0;
      if(this.matchStats.teams[target.id]){ this.matchStats.teams[target.id].survived=false; this.matchStats.teams[target.id].eliminatedAt=Date.now(); }
      if(this.matchStats.teams[taggerTeam.id]) this.matchStats.teams[taggerTeam.id].tagsMade += 1;
      this.matchStats.tags = (this.matchStats.tags||0)+1;
      // Post-tag pressure tool: brief Runner Vision for the Tagger team
      taggerTeam.runnerVisionUntil = Date.now() + 15000;
      this._ps(taggerPlayerId).tags+=1;
      this.tags.push({at:Date.now(),taggerTeamId:taggerTeam.id,runnerTeamId:target.id,result:'eliminated'});
      return {ok:true,result:'eliminated',message:`Team ${target.number} eliminated! 15s Runner Vision granted.`};
    }
  }

  activateGhost(playerId){
    const p=this.players.get(playerId); if(!p||!p.teamId) return {error:'No team'};
    const team=this.teams.get(p.teamId);
    if(!team||team.role!=='runner'||team.status!=='active') return {error:'Not active runner'};
    if(team.isGhostMode) return {error:'Already ghost'};
    if((team.ghostCharges||0)<=0) return {error:'No Ghost Mode charge available. Earn one from a quest.'};
    team.ghostCharges--; team.isGhostMode=true; team.ghostUntil=Date.now()+60*1000;
    return {ok:true};
  }

  hostEndGame(playerId){
    if(playerId!==this.hostPlayerId) return {error:'Only lobby creator can end the game'};
    if(this.status==='ended') return {error:'Game already ended'};
    this.endGame('host');
    return {ok:true};
  }

  _ps(playerId){
    let s=this.playerStats.get(playerId);
    if(!s){ s={distanceM:0,tags:0,absorbed:0,quests:0,baitQuests:0,callouts:0}; this.playerStats.set(playerId,s); }
    return s;
  }

  // ---- Bait quests: same look as normal quests, but the target sits next to danger on purpose ----
  _spawnBaitQuests(kind,ref){
    if(this.status!=='head_start'&&this.status!=='active') return;
    const teams=[...this.teams.values()].filter(t=>t.role==='runner'&&t.status==='active'&&(t.baitCount||0)<3&&!this.quests.some(q=>q.teamId===t.id&&q.isBait&&(q.status==='available'||q.status==='active')));
    for(let i=teams.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [teams[i],teams[j]]=[teams[j],teams[i]]; }
    const howMany=Math.max(1,Math.ceil(teams.length/3));
    for(const team of teams.slice(0,howMany)){
      if(Math.random()>0.75) continue;
      let pt=null;
      for(let k=0;k<40&&!pt;k++){
        // danger bait: at the rim of the Danger Zone (partly inside it). edge bait: right at the rim of the new safe zone.
        const c=kind==='danger' ? this._pointNear(ref.centerLat,ref.centerLng,ref.radiusMeters*0.7,ref.radiusMeters*1.1)
                                : this._pointNear(ref.centerLat,ref.centerLng,Math.max(30,ref.radiusMeters-40),ref.radiusMeters+25);
        if(haversine(c.lat,c.lng,this.centerLat,this.centerLng)<=this.initialRadiusMeters-70) pt=c; // always inside the playable area
      }
      if(!pt) continue;
      const type=Math.random()<0.5?'checkpoint':'hold';
      this.quests.push({ id:genId(), teamId:team.id, type, status:'available', isBait:true, baitKind:kind,
        title:type==='hold'?'Hold the Drop':'Supply Drop',
        description:type==='hold'?'Reach the marked drop and stay for 30s. Big reward.':'Reach the marked drop. Big reward.',
        targetLat:pt.lat, targetLng:pt.lng, radiusMeters:70, holdSeconds:30, distanceRequired:0, distanceTravelled:0,
        stages:[], currentStage:0, startedAt:null, holdStart:null, reward:'vision_burst_x2', completedAt:null,
        expiresAt:(kind==='danger'?ref.expiresAt:ref.relocEndsAt)+30000 });
      team.baitCount=(team.baitCount||0)+1;
    }
  }

  // ---- Team callouts: quick team-only signals (not chat) ----
  sendCallout(playerId,type){
    const TYPES={help:'Help!',north:'Go North',south:'Go South',east:'Go East',west:'Go West',hide:'Hide!',split:'Split up'};
    const p=this.players.get(playerId); if(!p||!p.teamId) return {error:'No team'};
    const team=this.teams.get(p.teamId); if(!team||team.status!=='active') return {error:'Your team is not active'};
    if(this.status!=='head_start'&&this.status!=='active') return {error:'Game is not running'};
    const label=TYPES[type]; if(!label) return {error:'Unknown callout'};
    const now=Date.now(), wait=6000-(now-(p.lastCalloutAt||0));
    if(wait>0) return {error:`Wait ${Math.ceil(wait/1000)}s before the next callout`,retryAfter:Math.ceil(wait/1000),limited:true};
    p.lastCalloutAt=now;
    this.callouts.push({id:genId(),teamId:team.id,fromId:p.id,fromName:p.name,type,label,lat:p.hasFix?p.lat:null,lng:p.hasFix?p.lng:null,at:now,expiresAt:now+10000});
    this.callouts=this.callouts.filter(c=>c.expiresAt>now-5000).slice(-40);
    this._ps(p.id).callouts+=1;
    return {ok:true,label,type};
  }

  // ---- Post-game MVP ----
  computeMvp(){
    const started=this.matchStats.startedAt||Date.now(), total=Math.max(1,Math.floor(((this.matchStats.endedAt||Date.now())-started)/1000));
    const rows=[];
    for(const p of this.players.values()){
      const t=p.teamId?this.teams.get(p.teamId):null; if(!t) continue;
      const ps=this._ps(p.id), st=this.matchStats.teams[t.id]||{}, surv=st.surviveSeconds||0, alive=t.status==='active';
      const km=ps.distanceM/1000, kmPts=Math.min(30,Math.round(km*3)), coPts=Math.min(5,ps.callouts);
      let score, hl=[];
      if(t.role==='runner'){
        score=Math.round(Math.min(1,surv/total)*40)+(alive?25:0)+ps.quests*15+ps.baitQuests*10+kmPts+coPts;
        hl.push(alive?'🏁 survived to the end':`⏱ lasted ${Math.floor(surv/60)}:${String(surv%60).padStart(2,'0')}`);
      } else {
        score=ps.tags*40+ps.absorbed*10+ps.quests*15+kmPts+coPts;
        if(ps.tags) hl.push(`🎯 ${ps.tags} tag${ps.tags>1?'s':''}`);
        if(ps.absorbed) hl.push(`🛡 ${ps.absorbed} absorbed`);
      }
      if(ps.quests) hl.push(`⭐ ${ps.quests} quest${ps.quests>1?'s':''}`);
      if(ps.baitQuests) hl.push(`⚠ ${ps.baitQuests} risky`);
      hl.push(`🏃 ${km.toFixed(1)} km`);
      if(ps.callouts) hl.push(`📣 ${ps.callouts} callout${ps.callouts>1?'s':''}`);
      rows.push({playerId:p.id,name:p.name,teamNumber:t.number,role:t.role,score,distanceM:Math.round(ps.distanceM),highlights:hl});
    }
    rows.sort((a,b)=>b.score-a.score||b.distanceM-a.distanceM);
    return rows.length?{mvp:rows[0],podium:rows.slice(0,3)}:null;
  }

  endGame(side){
    this.status='ended'; this.winner=side;
    const forfeits=['Do 20 push-ups','Sing for 30 seconds','Tell an embarrassing story','Buy snacks for winners','Dance for 1 minute','Speak in accent for 10 minutes'];
    this.forfeit=forfeits[Math.floor(Math.random()*forfeits.length)];
    const now=Date.now();
    for(const t of this.teams.values()){
      const st=this.matchStats.teams[t.id];
      if(!st) continue;
      st.role=t.role; st.status=t.status; st.number=t.number;
      if(st.survived && t.status==='active') st.surviveSeconds = Math.floor((now-(this.matchStats.startedAt||now))/1000);
      else if(st.eliminatedAt) st.surviveSeconds = Math.floor((st.eliminatedAt-(this.matchStats.startedAt||now))/1000);
      st.distanceM = Math.round(st.distanceM||0);
    }
    this.matchStats.endedAt=now;
    try{ this.mvp=this.computeMvp(); }catch(e){ console.error('[MVP ERROR]',e); this.mvp=null; }
  }

  activateSmoke(playerId){
    const p=this.players.get(playerId); if(!p||!p.teamId) return {error:'No team'};
    const team=this.teams.get(p.teamId);
    if(!team||team.role!=='runner'||team.status!=='active') return {error:'Not active runner'};
    if((team.smokeCharges||0)<=0) return {error:'No Smoke charge. Earn one from a quest.'};
    team.smokeCharges--;
    team.isGhostMode=true; team.ghostUntil=Date.now()+45*1000; // smoke acts as short ghost from other runners
    return {ok:true,message:'Smoke deployed — hidden from other Runners for 45s'};
  }

  activateVisionBurst(playerId){
    const p=this.players.get(playerId); if(!p||!p.teamId) return {error:'No team'};
    const team=this.teams.get(p.teamId);
    if(!team||team.status!=='active') return {error:'Not active'};
    if((team.visionCharges||0)<=0) return {error:'No Vision charge. Earn one from a quest.'};
    team.visionCharges--;
    if(team.role==='runner') team.hunterVisionUntil=Date.now()+18000;
    else team.runnerVisionUntil=Date.now()+18000;
    return {ok:true,message:'Vision burst active for 18s'};
  }

  usePing(playerId){
    const p=this.players.get(playerId); if(!p||!p.teamId) return {error:'No team'};
    const team=this.teams.get(p.teamId);
    if(!team||team.role!=='tagger'||team.status!=='active') return {error:'Only active Taggers can ping'};
    const now=Date.now();
    if(team.pingCooldownUntil && now < team.pingCooldownUntil) return {error:'Ping cooling down', secondsLeft:Math.ceil((team.pingCooldownUntil-now)/1000)};
    if((team.pingCharges||0)<=0 && !(team.snapshotCharges>0)) {
      // free ping recharges slowly via cooldown only after first use
    }
    // Find nearest active runner team centroid
    let best=null, bestD=1e15;
    for(const t of this.teams.values()){
      if(t.role!=='runner'||t.status!=='active') continue;
      let lat=0,lng=0,c=0;
      for(const pid of t.playerIds){ const q=this.players.get(pid); if(q&&q.hasFix){ lat+=q.lat; lng+=q.lng; c++; } }
      if(!c) continue; lat/=c; lng/=c;
      const d=haversine(p.lat,p.lng,lat,lng);
      if(d<bestD){ bestD=d; best={ teamNumber:t.number, lat, lng, meters:Math.round(d) }; }
    }
    team.pingCooldownUntil = now + 90000; // 90s cooldown
    if(!best) return {ok:true, message:'No active Runners found', ping:null};
    const rad=Math.PI/180;
    const dl=(best.lng-p.lng)*rad;
    const y=Math.sin(dl)*Math.cos(best.lat*rad);
    const x=Math.cos(p.lat*rad)*Math.sin(best.lat*rad)-Math.sin(p.lat*rad)*Math.cos(best.lat*rad)*Math.cos(dl);
    const bearing=(Math.atan2(y,x)/rad+360)%360;
    return {ok:true, ping:{ teamNumber:best.teamNumber, meters:best.meters, bearing:Math.round(bearing) }, message:`Nearest Runner ~${best.meters}m`};
  }

  useBonusSnapshot(playerId){
    const p=this.players.get(playerId); if(!p||!p.teamId) return {error:'No team'};
    const team=this.teams.get(p.teamId);
    if(!team||team.role!=='tagger') return {error:'Taggers only'};
    if((team.snapshotCharges||0)<=0) return {error:'No bonus snapshot charge'};
    team.snapshotCharges--;
    this.takeSnapshot();
    return {ok:true, message:'Bonus snapshot taken'};
  }

  _zoneStatus(player){
    const now=Date.now(), cur=this.safeZone, pz=this.pendingSafeZone, out={phase:pz?'relocating':'stable',inCurrent:null,inTarget:null};
    if(pz) out.secondsLeft=Math.max(0,Math.ceil((pz.relocEndsAt-now)/1000));
    if(!player.hasFix||!cur) return out;
    out.inCurrent=isInside(player.lat,player.lng,cur.centerLat,cur.centerLng,cur.radiusMeters);
    if(pz){
      const d=haversine(player.lat,player.lng,pz.centerLat,pz.centerLng), rad=Math.PI/180;
      const dl=(pz.centerLng-player.lng)*rad, y=Math.sin(dl)*Math.cos(pz.centerLat*rad);
      const x=Math.cos(player.lat*rad)*Math.sin(pz.centerLat*rad)-Math.sin(player.lat*rad)*Math.cos(pz.centerLat*rad)*Math.cos(dl);
      out.inTarget=d<=pz.radiusMeters; out.metersToTarget=Math.max(0,Math.round(d-pz.radiusMeters)); out.bearing=(Math.atan2(y,x)/rad+360)%360;
      const team=this.teams.get(player.teamId); out.teamSafe=false; // same rule as the elimination check
      if(team) for(const pid of team.playerIds){ const q=this.players.get(pid); if(q&&isInside(q.lat,q.lng,pz.centerLat,pz.centerLng,pz.radiusMeters)) out.teamSafe=true; }
    }
    return out;
  }

  getStateFor(playerId){
    const player=this.players.get(playerId); if(!player) return null;
    const myTeam=player.teamId?this.teams.get(player.teamId):null;
    const isTagger=myTeam&&myTeam.role==='tagger';
    const isRunner=myTeam&&myTeam.role==='runner';
    const now=Date.now();

    const state={
      gameId:this.id, code:this.code, status:this.status,
      durationSeconds:this.durationSeconds, snapshotIntervalSeconds:this.snapshotIntervalSeconds,
      headStartSeconds:this.headStartSeconds, safePeriodSeconds:this.safePeriodSeconds, zoneTransitionSeconds:this.zoneTransitionSeconds,
      zoneMinIntervalSeconds:this.zoneMinIntervalSeconds, zoneMaxIntervalSeconds:this.zoneMaxIntervalSeconds, buffSpawnChance:this.buffSpawnChance,
      headStartSeconds:this.headStartSeconds, centerLat:this.centerLat, centerLng:this.centerLng,
      initialRadiusMeters:this.initialRadiusMeters, teamSize:this.teamSize, teamFormation:this.teamFormation, teamMode:this.teamMode, customRunners:this.customRunners, customTaggers:this.customTaggers,
      safeZone:this.safeZone, pendingSafeZone:this.pendingSafeZone, zoneStatus:this._zoneStatus(player),
      startedAt:this.startedAt, endsAt:this.endsAt, headStartEndsAt:this.headStartEndsAt,
      nextSnapshotAt:this.nextSnapshotAt, nextShrinkAt:(this.pendingSafeZone?null:this.nextShrinkAt), now, winner:this.winner, forfeit:this.forfeit, hostPlayerId:this.hostPlayerId, isHost:player.id===this.hostPlayerId,
      zoneTransitionSeconds:this.zoneTransitionSeconds, nextShrinkAt:this.nextShrinkAt,
      me:{ id:player.id, name:player.name, teamId:player.teamId, teammateId:player.teammateId, isHost:player.id===this.hostPlayerId,
        lat:player.lat, lng:player.lng, hasFix:!!player.hasFix, accuracyMeters:player.accuracyMeters, lastLocationAt:player.lastLocationAt, isOnline:player.isOnline, isReady:player.isReady },
      myTeam:null, teams:[], players:[], visibleLocations:[], latestSnapshot:null,
      zones:this.zones.map(z=>({id:z.id,type:z.type,centerLat:z.centerLat,centerLng:z.centerLng,radiusMeters:z.radiusMeters,expiresAt:z.expiresAt})),
      quests:[], chat:this.chat.slice(-40),
      matchStats: this.status==='ended' ? this.matchStats : null,
      mvp: this.status==='ended' ? this.mvp : null, callouts: [],
      isSpectator: !!(myTeam && myTeam.status==='eliminated'),
      previousSnapshot: this.snapshots.length>1 ? this.snapshots[this.snapshots.length-2] : null
    };

    if(myTeam){
      state.myTeam={
        id:myTeam.id, number:myTeam.number, name:myTeam.name, color:myTeam.color,
        ...(myTeam.role==='runner' ? {secretCode:myTeam.secretCode} : {}),
        role:myTeam.role, health:myTeam.health, hasExtraHealth:myTeam.hasExtraHealth,
        isGhostMode:myTeam.isGhostMode, ghostUntil:myTeam.ghostUntil, status:myTeam.status,
        penaltyUntil:myTeam.penaltyUntil, ghostCharges:myTeam.ghostCharges||0,
        smokeCharges:myTeam.smokeCharges||0, visionCharges:myTeam.visionCharges||0,
        snapshotCharges:myTeam.snapshotCharges||0, pingCharges:myTeam.pingCharges||0,
        pingCooldownUntil:myTeam.pingCooldownUntil||null,
        hunterVisionUntil:myTeam.hunterVisionUntil, runnerVisionUntil:myTeam.runnerVisionUntil
      };
      state.quests=this.quests.filter(q=>q.teamId===myTeam.id&&q.status!=='expired').map(q=>{
        const base={ id:q.id, type:q.type, status:q.status, title:q.title, description:q.description,
          targetLat:q.targetLat, targetLng:q.targetLng, radiusMeters:q.radiusMeters,
          holdSeconds:q.holdSeconds, distanceRequired:q.distanceRequired,
          distanceTravelled:Math.floor(q.distanceTravelled||0),
          holdProgress:q.holdStart?Math.min(100,Math.floor((now-q.holdStart)/(q.holdSeconds*10))):0,
          reward:q.reward, isBait:!!q.isBait, expiresIn:(q.status==='available'&&q.expiresAt)?Math.max(0,Math.ceil((q.expiresAt-now)/1000)):null, currentStage:q.currentStage||0, totalStages:(q.stages||[]).length,
          timeLeft:(q.status==='active'&&q.questTimeLimitSeconds&&q.startedAt&&(q.currentStage||0)>0)?Math.max(0,Math.ceil(q.questTimeLimitSeconds-(now-q.startedAt)/1000)):null };
        return base;
      });
      state.callouts=this.callouts.filter(c=>c.teamId===myTeam.id&&c.expiresAt>now).map(c=>({id:c.id,type:c.type,label:c.label,fromId:c.fromId,fromName:c.fromName,lat:c.lat,lng:c.lng,at:c.at,expiresAt:c.expiresAt}));
    }

    for(const t of this.teams.values()){
      state.teams.push({
        id:t.id, number:t.number, name:t.name,
        role:t.role, color:t.color,
        status:t.status, hasExtraHealth:t.hasExtraHealth, isGhostMode:t.isGhostMode
      });
    }
    for(const p of this.players.values()){
      const pt=p.teamId?this.teams.get(p.teamId):null;
      const pidx=pt?pt.playerIds.indexOf(p.id)+1:0;
      state.players.push({id:p.id,name:p.name,teammateId:p.teammateId,teamId:p.teamId,teamNumber:pt?.number||null,teamColor:pt?.color||null,teamRole:pt?.role||null,playerIndex:pidx,isReady:p.isReady,isOnline:p.isOnline,isMe:p.id===playerId});
    }

    // ===== ASYMMETRIC LOCATIONS + VISION BUFFS =====
    if(['lobby','head_start','active'].includes(this.status)){
      // Own + teammate always
      if(myTeam){
        for(const pid of myTeam.playerIds){
          const p=this.players.get(pid);
          if(p&&p.hasFix) state.visibleLocations.push({playerId:p.id,name:p.name,teamId:p.teamId,teamNumber:myTeam.number,teamColor:myTeam.color,playerIndex:myTeam.playerIds.indexOf(p.id)+1,lat:p.lat,lng:p.lng,isTeammate:true,isLive:(now-p.lastLocationAt)<20000,ageSeconds:Math.round((now-p.lastLocationAt)/1000)});
        }
      }

      if(isRunner){
        // Other runners live (except ghost)
        for(const t of this.teams.values()){
          if(t.role!=='runner'||t.id===myTeam.id||t.status!=='active'||t.isGhostMode) continue;
          for(const pid of t.playerIds){
            const p=this.players.get(pid);
            if(p&&p.hasFix&&(now-p.lastLocationAt)<90000) state.visibleLocations.push({playerId:p.id,name:p.name,teamId:t.id,teamNumber:t.number,teamColor:t.color,playerIndex:t.playerIds.indexOf(p.id)+1,lat:p.lat,lng:p.lng,isLive:(now-p.lastLocationAt)<20000,ageSeconds:Math.round((now-p.lastLocationAt)/1000),isRunner:true});
          }
        }
        // Hunter Vision: see Taggers live
        if(myTeam.hunterVisionUntil && now < myTeam.hunterVisionUntil){
          for(const t of this.teams.values()){
            if(t.role!=='tagger'||t.status!=='active') continue;
            for(const pid of t.playerIds){
              const p=this.players.get(pid);
              if(p&&p.isOnline) state.visibleLocations.push({playerId:p.id,name:p.name,teamId:t.id,teamNumber:t.number,teamColor:t.color,playerIndex:t.playerIds.indexOf(p.id)+1,lat:p.lat,lng:p.lng,isLive:true,isHunterVision:true});
            }
          }
        }
      }

      if(isTagger){
        // Snapshots
        if(this.snapshots.length){
          const latest=this.snapshots[this.snapshots.length-1];
          state.latestSnapshot={takenAt:latest.takenAt,positions:latest.positions};
          for(const pos of latest.positions) state.visibleLocations.push({teamId:pos.teamId,teamNumber:pos.teamNumber,teamColor:pos.teamColor,lat:pos.lat,lng:pos.lng,isLive:false,isSnapshot:true});
        }
        // Danger zone live override
        for(const z of this.zones){
          if(z.type!=='danger') continue;
          for(const t of this.teams.values()){
            if(t.role!=='runner'||t.status!=='active') continue;
            for(const pid of t.playerIds){
              const p=this.players.get(pid);
              if(p&&p.isOnline&&isInside(p.lat,p.lng,z.centerLat,z.centerLng,z.radiusMeters)){
                state.visibleLocations.push({playerId:p.id,name:p.name,teamId:t.id,teamNumber:t.number,teamColor:t.color,playerIndex:t.playerIds.indexOf(p.id)+1,lat:p.lat,lng:p.lng,isLive:true,isDanger:true});
              }
            }
          }
        }
        // Runner Vision from buff
        if(myTeam.runnerVisionUntil && now < myTeam.runnerVisionUntil){
          for(const t of this.teams.values()){
            if(t.role!=='runner'||t.status!=='active') continue;
            for(const pid of t.playerIds){
              const p=this.players.get(pid);
              if(p&&p.isOnline) state.visibleLocations.push({playerId:p.id,name:p.name,teamId:t.id,teamNumber:t.number,teamColor:t.color,playerIndex:t.playerIds.indexOf(p.id)+1,lat:p.lat,lng:p.lng,isLive:true,isRunnerVision:true});
            }
          }
        }
      }
    }

    // Spectators (eliminated) get limited view: latest snapshot positions only
    if(myTeam && myTeam.status==='eliminated' && this.snapshots.length){
      const latest=this.snapshots[this.snapshots.length-1];
      for(const pos of latest.positions||[]){
        state.visibleLocations.push({teamId:pos.teamId,teamNumber:pos.teamNumber,lat:pos.lat,lng:pos.lng,isLive:false,isSnapshot:true,isSpectatorView:true});
      }
    }

    return state;
  }
}

/** Preset mode: host only picks duration, radius, teams, center. Server fills in the rest.
 *  Same math as the frontend preview (computePresetSettings in index.html) so what the host
 *  sees in the preview is what the game actually uses. Takes SECONDS in, gives SECONDS out. */
function computePresetSettings(durationSeconds, radiusMeters){
  const durationMin = Math.max(5, (Number(durationSeconds) || 3600) / 60);
  const radiusM = Number(radiusMeters) || 3000;
  const scale = Math.max(0.15, durationMin / 60);
  const headStartMin = Math.max(1, Math.round(5 * scale * 2) / 2);
  const snapshotMin = Math.max(1, Math.round(5 * scale * 2) / 2);
  const radiusFactor = Math.min(1.35, Math.max(0.75, radiusM / 3000));
  let safePeriodMin = Math.round(durationMin * 0.22 * radiusFactor);
  safePeriodMin = Math.max(2, Math.min(Math.floor(durationMin * 0.4), safePeriodMin));
  const transitionSec = Math.max(120, Math.min(900, Math.round(90 + radiusM * 0.06)));
  const minInterval = Math.max(90, Math.round(durationMin * 60 * 0.12));
  const maxInterval = Math.max(minInterval + 60, Math.round(durationMin * 60 * 0.22));
  return {
    headStartSeconds: headStartMin * 60,
    snapshotIntervalSeconds: snapshotMin * 60,
    safePeriodSeconds: safePeriodMin * 60,
    zoneTransitionSeconds: transitionSec,
    zoneMinIntervalSeconds: minInterval,
    zoneMaxIntervalSeconds: maxInterval,
    // zone rarity: same as the "hard" difficulty in custom mode
    buffSpawnChance: 0.15,
    maxBuffZonesPerGame: 1,
    zoneDifficulty: 'hard'
  };
}

const games=new Map();
const server=http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){ res.writeHead(204); res.end(); return; }
  const url=new URL(req.url,`http://localhost:${PORT}`);
  const pth=url.pathname;

  if(pth==='/'||pth==='/index.html'){
    try{ const html=fs.readFileSync(path.join(__dirname,'../frontend/index.html'),'utf8');
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(html); }
    catch(e){ res.writeHead(500); res.end('Frontend missing'); }
    return;
  }

  function json(data,code=200){ res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(data)); }
  function body(cb){
    let b='',over=false;
    req.on('data',c=>{ if(over)return; b+=c; if(b.length>100000){ over=true; json({error:'Request too large'},413); } });
    req.on('end',()=>{
      if(over)return;
      let d; try{ d=b?JSON.parse(b):{}; }catch{ return json({error:'Bad JSON'},400); }
      try{ cb(d); }catch(e){ console.error('[ROUTE ERROR]',pth,e&&e.stack||e); if(!res.headersSent) json({error:'Server error'},500); }
    });
  }
  function auth(game,data){ const player=game.players.get(data.playerId); if(!player||!data.sessionToken||data.sessionToken!==player.sessionToken) return null; return player; }

  if(pth==='/api/create'&&req.method==='POST'){
    body(data=>{
      const durationSeconds = data.durationSeconds;
      const initialRadiusMeters = data.initialRadiusMeters;
      let settings = {
        durationSeconds,
        snapshotIntervalSeconds:data.snapshotIntervalSeconds,
        headStartSeconds:data.headStartSeconds,
        centerLat:data.centerLat, centerLng:data.centerLng,
        initialRadiusMeters, teamSize:data.teamSize, teamFormation:data.teamFormation, teamMode:data.teamMode, customRunners:data.customRunners, customTaggers:data.customTaggers,
        safePeriodSeconds:data.safePeriodSeconds, zoneTransitionSeconds:data.zoneTransitionSeconds,
        zoneMinIntervalSeconds:data.zoneMinIntervalSeconds, zoneMaxIntervalSeconds:data.zoneMaxIntervalSeconds,
        buffSpawnChance:data.buffSpawnChance, maxBuffZonesPerGame:data.maxBuffZonesPerGame, zoneDifficulty:data.zoneDifficulty
      };
      // Preset mode: host only chose duration, radius, teams, center — server fills the rest.
      if(data.preset === true || data.preset === 'true' || data.preset === 1){
        const auto = computePresetSettings(durationSeconds, initialRadiusMeters);
        settings = Object.assign(settings, auto);
      }
      const game=new Game(settings);
      const player=game.addPlayer(data.name||'Host');
      games.set(game.id,game);
      json({gameId:game.id,code:game.code,playerId:player.id,playerName:player.name,sessionToken:player.sessionToken});
    }); return;
  }
  if((pth==='/api/leave'||pth==='/api/kick')&&req.method==='POST'){
    body(data=>{
      const game=games.get(data.gameId); if(!game) return json({error:'Game not found'},404);
      const me=auth(game,data); if(!me) return json({error:'Unauthorized'},401);
      const r=game.removePlayer(pth==='/api/kick'?data.targetId:me.id,me.id);
      json(r.error?r:{ok:true},r.error?400:200);
    }); return;
  }

  if(pth==='/api/join'&&req.method==='POST'){
    body(data=>{
      const code=(data.code||'').toUpperCase().trim();
      let game=null; for(const g of games.values()) if(g.code===code){game=g;break;}
      if(!game) return json({error:'Game not found'},404);
      if(game.status!=='lobby') return json({error:'Game already started'},400);
      if(game.teamMode==='custom'&&game.players.size>=game.customRunners+game.customTaggers) return json({error:`Lobby is full (${game.players.size}/${game.customRunners+game.customTaggers} players for this custom game)`},400);
      if(game.players.size>=60) return json({error:'Lobby is full (60 players max)'},400);
      const player=game.addPlayer(data.name||'Player');
      json({gameId:game.id,code:game.code,playerId:player.id,playerName:player.name,sessionToken:player.sessionToken});
    }); return;
  }
  if(pth==='/api/team-choice'&&req.method==='POST'){
    body(data=>{ const game=games.get(data.gameId); if(!game) return json({error:'Not found'},404);
      const player=auth(game,data); if(!player) return json({error:'Unauthorized'},401);
      const result=game.setTeammate(player.id,data.teammateId); if(result.error) return json(result,400); json(result); }); return;
  }
  if(pth==='/api/ready'&&req.method==='POST'){
    body(data=>{ const game=games.get(data.gameId); if(!game) return json({error:'Not found'},404);
      const player=auth(game,data); if(!player) return json({error:'Unauthorized'},401);
      player.isReady=!!data.ready; player.lastSeen=Date.now(); json({ok:true}); }); return;
  }
  if(pth==='/api/start'&&req.method==='POST'){
    body(data=>{ const game=games.get(data.gameId); if(!game) return json({error:'Not found'},404);
      const player=auth(game,data); if(!player) return json({error:'Unauthorized'},401);
      if(game.hostPlayerId!==player.id) return json({error:'Only lobby creator can start'},403);
      const result=game.start(); if(result.error) return json(result,400); json({ok:true}); }); return;
  }
  if(pth==='/api/location'&&req.method==='POST'){
    body(data=>{ const game=games.get(data.gameId); if(!game) return json({error:'Not found'},404);
      const player=auth(game,data); if(!player) return json({error:'Unauthorized'},401);
      const result=game.updateLocation(player.id,data.latitude ?? data.lat,data.longitude ?? data.lng,data.accuracyMeters ?? data.accuracy,(Number.isFinite(Number(data.sampleAgeMs))?Date.now()-Math.max(0,Number(data.sampleAgeMs)):data.timestamp));
      if(result.error) return json(result,400); json(result); }); return;
  }
  if(pth==='/api/tag'&&req.method==='POST'){
    body(data=>{ const game=games.get(data.gameId); if(!game) return json({error:'Not found'},404);
      const player=auth(game,data); if(!player) return json({error:'Unauthorized'},401);
      const result=game.tagTeam(player.id,data.code); if(result.error) return json(result,result.locked?429:400); json(result); }); return;
  }
  if(pth==='/api/quest/activate'&&req.method==='POST'){
    body(data=>{ const game=games.get(data.gameId); if(!game) return json({error:'Not found'},404);
      const player=auth(game,data); if(!player) return json({error:'Unauthorized'},401);
      const result=game.activateQuest(player.id,data.questId); if(result.error) return json(result,400); json(result); }); return;
  }
  if(pth==='/api/ghost'&&req.method==='POST'){
    body(data=>{ const game=games.get(data.gameId); if(!game) return json({error:'Not found'},404);
      const player=auth(game,data); if(!player) return json({error:'Unauthorized'},401);
      const result=game.activateGhost(player.id); if(result.error) return json(result,400); json(result); }); return;
  }
  if(pth==='/api/smoke'&&req.method==='POST'){
    body(data=>{ const game=games.get(data.gameId); if(!game) return json({error:'Not found'},404);
      const player=auth(game,data); if(!player) return json({error:'Unauthorized'},401);
      const result=game.activateSmoke(player.id); if(result.error) return json(result,400); json(result); }); return;
  }
  if(pth==='/api/vision'&&req.method==='POST'){
    body(data=>{ const game=games.get(data.gameId); if(!game) return json({error:'Not found'},404);
      const player=auth(game,data); if(!player) return json({error:'Unauthorized'},401);
      const result=game.activateVisionBurst(player.id); if(result.error) return json(result,400); json(result); }); return;
  }
  if(pth==='/api/ping'&&req.method==='POST'){
    body(data=>{ const game=games.get(data.gameId); if(!game) return json({error:'Not found'},404);
      const player=auth(game,data); if(!player) return json({error:'Unauthorized'},401);
      const result=game.usePing(player.id); if(result.error) return json(result,400); json(result); }); return;
  }
  if(pth==='/api/bonus-snapshot'&&req.method==='POST'){
    body(data=>{ const game=games.get(data.gameId); if(!game) return json({error:'Not found'},404);
      const player=auth(game,data); if(!player) return json({error:'Unauthorized'},401);
      const result=game.useBonusSnapshot(player.id); if(result.error) return json(result,400); json(result); }); return;
  }
  if(pth==='/api/end'&&req.method==='POST'){
    body(data=>{ const game=games.get(data.gameId); if(!game) return json({error:'Not found'},404);
      const player=auth(game,data); if(!player) return json({error:'Unauthorized'},401);
      const result=game.hostEndGame(player.id); if(result.error) return json(result,403); json(result); }); return;
  }
  if(pth==='/api/callout'&&req.method==='POST'){
    body(data=>{ const game=games.get(data.gameId); if(!game) return json({error:'Not found'},404);
      const player=auth(game,data); if(!player) return json({error:'Unauthorized'},401);
      const r=game.sendCallout(player.id,String(data.type||''));
      if(r.error) return json(r,r.limited?429:400); json(r); }); return;
  }
  if(pth==='/api/chat'&&req.method==='POST'){
    body(data=>{ const game=games.get(data.gameId); if(!game) return json({error:'Not found'},404);
      const player=auth(game,data); if(!player) return json({error:'Unauthorized'},401);
      const now=Date.now(); player.chatTimes=(player.chatTimes||[]).filter(t=>now-t<10000);
      if(player.chatTimes.length>=5) return json({error:'Chat rate limit: please wait a few seconds'},429);
      const text=String(data.text||'').trim(); if(!text) return json({error:'Message is empty'},400);
      player.chatTimes.push(now);
      game.chat.push({id:genId(),playerId:player.id,playerName:player.name,teamId:player.teamId,text:text.slice(0,250),at:now});
      if(game.chat.length>150) game.chat.shift(); json({ok:true}); }); return;
  }
  if(pth==='/api/state'&&req.method==='GET'){
    const gameId=url.searchParams.get('gameId'), playerId=url.searchParams.get('playerId');
    const game=games.get(gameId); if(!game) return json({error:'Not found'},404);
    const sessionToken=url.searchParams.get('sessionToken');
    const p=game.players.get(playerId); if(!p||p.sessionToken!==sessionToken) return json({error:'Unauthorized'},401);
    const state=game.getStateFor(playerId); if(!state) return json({error:'Player not found'},404);
    p.lastSeen=Date.now();
    json(state); return;
  }
  if(pth==='/api/games'&&req.method==='GET'){
    json({count:games.size}); return;
  }
  json({error:'Not found'},404);
});

if(require.main===module){
  // one broken game must never take the whole server down
  process.on('uncaughtException',e=>console.error('[UNCAUGHT]',e&&e.stack||e));
  process.on('unhandledRejection',e=>console.error('[UNHANDLED]',e&&e.stack||e));
  setInterval(()=>{ for(const g of games.values()){ try{ g.tick(); }catch(e){ console.error('[TICK ERROR] game',g.code,e&&e.stack||e); } } },1000);
  setInterval(()=>{ const cut=Date.now()-4*3600*1000; for(const [id,g] of games) if(g.createdAt<cut) games.delete(id); },600000);

  server.listen(PORT,'0.0.0.0',()=>{
    console.log('\n=============================================');
    console.log('  IRL TAG - Complete Server');
    console.log('  http://localhost:'+PORT);
    console.log('=============================================\n');
  });
}

module.exports={Game,genTeamCode,haversine,isInside,computePresetSettings};
