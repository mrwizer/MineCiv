/*
 * bot_host.js — long-lived Node process that owns ONE Mineflayer bot.
 *
 * Protocol: newline-delimited JSON on stdin/stdout.
 *   IN:  {"id":n,"cmd":"get_state"}
 *        {"id":n,"cmd":"run_skill","code":"<js>","timeout_ms":60000}
 *        {"id":n,"cmd":"chat","text":"hi"}
 *   OUT: {"id":n,"type":"state","data":{...}}
 *        {"id":n,"type":"result","data":{...}}
 *        {"type":"log","text":"..."}  {"type":"ready"}
 *
 * Skill code is an async function body receiving (bot, mcData, Vec3, log, helpers, goals).
 * It should RETURN a small JSON-serializable summary.
 */
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

const HOST = process.env.MC_HOST || 'localhost';
const PORT = parseInt(process.env.MC_PORT || '25565', 10);
const USERNAME = process.env.MC_USERNAME || 'SidBot';
const AUTH = process.env.MC_AUTH || 'offline';
const VERSION = process.env.MC_VERSION || false;

function send(obj){ process.stdout.write(JSON.stringify(obj) + '\n'); }
let _logBuffer = null;  // when non-null, log() also captures into it (per-run)
// Spam circuit-breaker state: a generated skill stuck in a tight while-loop can
// print the same line thousands of times/second, flooding the log (seen: a 19MB
// Mason.log) and pinning a CPU core until the 90s timeout. Detect a rapidly-
// repeating identical line and throw to abort the skill NOW rather than waiting.
let _lastLogLine = null, _lastLogRepeat = 0, _lastLogFirstTs = 0;
const _SPAM_REPEAT_LIMIT = 200;      // same line this many times...
const _SPAM_WINDOW_MS = 3000;        // ...within this window == runaway loop
let _spamTripped = false;            // set so the skill runner can surface a reason

function log(text){
  const s = String(text);
  // runaway-loop detection
  const now = Date.now();
  if (s === _lastLogLine){
    if (_lastLogRepeat === 0) _lastLogFirstTs = now;
    _lastLogRepeat++;
    if (_lastLogRepeat >= _SPAM_REPEAT_LIMIT && (now - _lastLogFirstTs) <= _SPAM_WINDOW_MS){
      _spamTripped = true;
      _lastLogLine = null; _lastLogRepeat = 0;
      // Emit one diagnostic, then throw to break the skill's loop immediately.
      send({ type:'log', text:`⛔ runaway log loop detected ("${s.slice(0,60)}" ×${_SPAM_REPEAT_LIMIT}); aborting skill` });
      throw new Error('runaway log loop: skill aborted by spam circuit-breaker');
    }
  } else {
    _lastLogLine = s; _lastLogRepeat = 1; _lastLogFirstTs = now;
  }
  if (_logBuffer) _logBuffer.push(s);
  send({ type:'log', text:s });
}

let bot = null;
let mcData = null, ready = false;
let reconnectAttempts = 0;
let intentionalClose = false;
// World context pushed from the orchestrator each run_skill (see handle()): the
// community workshop/home site and decider flag. Helpers read this to route shared
// infrastructure to home instead of scattering it. Null until first run_skill.
let _worldContext = { workshop: null, isDecider: false };
// Set true by craftItem when it had to drop a TEMPORARY table (home unreachable or
// not yet sited). Surfaced in the run result purely for OBSERVABILITY, so you can
// watch how often bots resort to stopgap tables — a high rate means home routing is
// failing (unreachable home, or no workshop sited yet). The registry still records
// any real table honestly; the cure for scattering is routing to home, not hiding.
let _lastCraftPlacedTempTable = false;
let _lastPlaceFail = null;   // why the last placeAt failed, surfaced to help the LLM self-correct

// --- survival watchdog state ------------------------------------------------
// _skillRunning is true ONLY while a skill body executes (set in runSkill). The
// watchdog reads it and stays completely hands-off whenever a skill is driving,
// so it never fights the skill's pathfinder for movement controls. It acts only
// in the DEAD TIME — the slow propose call and between-cycle gaps — which is
// exactly where Flint drowned. _watchdogBusy prevents overlapping reflex actions.
let _skillRunning = false;
let _watchdogBusy = false;
let _watchdogInstalled = false;
// Water-escape state: the bot must get OUT of water before any cycle runs, and it
// swims toward the last DRY ground it stood on (the way it came) rather than a
// scanned heading that could point deeper into an ocean. Bounded so a bot can
// never march off thousands of blocks.
let _lastDryPos = null;          // {x,y,z} last position the bot stood on solid ground
let _waterEpisode = null;        // {startedAt, startPos, lastLog} while escaping water
let _inWaterNow = false;         // read by handle(): block skills while true
let _skillInterruptedByDrowning = false;  // set by watchdog when it takes over a drowning skill
let _skillInterruptedByMob = false;       // set by watchdog when it takes over due to mob damage
let _lastHealth = 20;                      // to detect active damage (health falling)
const MAX_RECONNECT = 10;

function connect(){
  ready = false;
  bot = mineflayer.createBot({
    host: HOST, port: PORT, username: USERNAME, auth: AUTH,
    version: VERSION || undefined,
  });
  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    mcData = require('minecraft-data')(bot.version);
    // COMPAT SHIM: generated skill code sometimes calls bot.jump(), which is not a
    // real mineflayer method — it throws "bot.jump is not a function" and kills the
    // whole skill. Provide a graceful one: a brief jump via control state. Escape/
    // movement should go through helpers, but this stops a stray call from crashing.
    if (typeof bot.jump !== 'function'){
      bot.jump = async () => {
        bot.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 350));
        bot.setControlState('jump', false);
        return true;
      };
    }
    // --- navigation policy (configured ONCE, not per-task) --------------------
    // Default pathfinder will happily dig straight down and drop up to 4 blocks to
    // reach a target, carving a pit it then can't climb out of — the "bot mines
    // ore, falls in a hole, wastes cycles escaping" failure. We don't forbid
    // digging (bots must mine to gather); we make UNRECOVERABLE descent expensive
    // so the planner prefers to route around / staircase instead of tunneling down.
    const moves = new Movements(bot, mcData);
    moves.maxDropDown = 3;          // (default 4) allow a controlled 3-block drop.
                                    //   Was 1, which forbade stepping DOWN a cliff or
                                    //   hillside face — exactly where exposed surface
                                    //   stone is — so the planner reported "No path"
                                    //   to visible stone on a plains/hills map. 3 lets
                                    //   it descend to rock without committing to a
                                    //   deep unrecoverable plunge (getUnstuck handles
                                    //   the rare over-drop).
    moves.allow1by1towers = false;  // DISABLED: on the surface this let the planner
                                    //   build 1x1 dirt towers to "reach" a goal,
                                    //   stranding bots on pillars (then placing tables
                                    //   on top). Genuine underground escape is handled
                                    //   explicitly by getUnstuck's buried-only pillar
                                    //   tier, not by the pathfinder auto-towering.
    moves.dontMineUnderFallingBlock = true;  // keep default: don't dig under gravel/sand.
    moves.digCost = 3;             // (default 1) discourage needless tunneling so the
                                    //   planner prefers routing around — but NOT so
                                    //   high (was 6) that it can't find any route to
                                    //   buried stone before thinkTimeout fires. 6 made
                                    //   mining time out constantly; 3 still biases
                                    //   against boring straight down.
    moves.liquidCost = 120;        // VERY strongly avoid pathing through water/lava.
                                    //   Raised 60->120 after a 20-bot run drowned 604
                                    //   times: each drowning nulls the skill's path goal
                                    //   ("goal was changed", 577x) and kills the skill.
                                    //   liquidCost is a COST not a ban, so a loose
                                    //   GoalNear across water could still dip in; 120
                                    //   makes any dry detour cheaper than a single
                                    //   water step. Pair with dry-site selection below.
    bot.pathfinder.setMovements(moves);
    // Give the planner more time and a bounded search space. Default thinkTimeout
    // (5000ms) + unbounded searchRadius (-1) means with a raised digCost the A* node
    // space explodes and the planner gives up with "Took to long to decide path to
    // goal!" — the failure that stalled entire runs. A larger think budget plus a
    // capped radius keeps searches tractable AND lets them finish.
    bot.pathfinder.thinkTimeout = 15000;   // (default 5000) ms to compute a path
    bot.pathfinder.tickTimeout = 40;       // ms/tick spent thinking (default 40)
    bot.pathfinder.searchRadius = 128;     // (default -1 unbounded) cap the search so
                                           //   it can't wander the whole loaded world,
                                           //   but it MUST exceed the mining reach:
                                           //   findMineableStone searches up to 96
                                           //   blocks (far sweep), so a 48 cap made the
                                           //   planner throw "No path" to stone the
                                           //   finder had already located past 48 — the
                                           //   root cause of "stone visible but
                                           //   unreachable" on open terrain. 128 covers
                                           //   the 96 far-sweep with headroom.
    ready = true;
    reconnectAttempts = 0;   // healthy connection resets the backoff
    installSurvivalWatchdog();   // always-on reflexes for the dead time between cycles
    log(`spawned as ${bot.username} on MC ${bot.version}`);
    send({ type:'ready' });
  });

  bot.on('kicked', (r) => log('KICKED: ' + JSON.stringify(r)));
  bot.on('error', (e) => log('BOT ERROR: ' + (e && e.message)));
  bot.on('end', (r) => {
    ready = false;
    log('DISCONNECTED: ' + r);
    if (intentionalClose) return;
    // A kicked/dropped bot would otherwise be dead for the whole run. Reconnect
    // with backoff so one illegal action (e.g. anti-cheat kick) isn't fatal.
    if (reconnectAttempts < MAX_RECONNECT) {
      reconnectAttempts++;
      const delay = Math.min(30000, 3000 * reconnectAttempts);
      log(`reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT})`);
      setTimeout(connect, delay);
    } else {
      log('gave up reconnecting after ' + MAX_RECONNECT + ' attempts');
    }
  });
}

connect();

// ============================================================================
// SURVIVAL WATCHDOG — always-on reflexes for the DEAD TIME between/around cycles.
//
// Why this exists: a cycle spends 60–160s in the propose (reasoning) call, plus
// gaps between skills, during which NO skill code is running and the bot is a
// passive ragdoll. Flint swam into water and drowned in that gap; a mob could
// kill a bot the same way. Pathing avoidance (high liquidCost) reduces getting
// INTO trouble, but can't help with the DELAY — you can't path-plan your way out
// of being idle while a skeleton shoots you.
//
// Design guarantees (owner chose the safest option):
//   • Acts ONLY when _skillRunning is false. While a skill drives the bot the
//     watchdog is completely hands-off, so it never fights the skill's pathfinder
//     for the same movement controls (which would cause jitter + "goal changed").
//   • One reflex at a time (_watchdogBusy), non-reentrant.
//   • Reflexes are SHORT and self-contained: swim up, back away, eat, hop out.
//     They clear their own control states so they never leave the bot walking.
//   • Fires on a throttled timer (physics is ~20Hz; we check ~4Hz) — cheap.
//
// Reflexes (all four the owner selected): swim-to-surface+land, flee hostiles,
// auto-eat when low, escape suffocation / lava-edge / deep-water sink.
// ============================================================================
function installSurvivalWatchdog(){
  if (_watchdogInstalled) return;
  _watchdogInstalled = true;

  const HOSTILES = new Set(['zombie','skeleton','spider','creeper','witch',
    'husk','stray','drowned','enderman','zombie_villager','pillager','vindicator',
    'zombified_piglin','piglin_brute','slime','cave_spider','phantom']);

  const foodInInv = () => ['cooked_beef','cooked_porkchop','cooked_chicken',
    'cooked_mutton','bread','cooked_cod','cooked_salmon','apple','carrot','potato',
    'baked_potato','beef','porkchop','chicken','mutton','melon_slice',
    'sweet_berries'].find(n => bot.inventory.items().some(i => i.name === n));

  async function clearControls(){
    for (const c of ['forward','back','left','right','jump','sprint','sneak'])
      { try { bot.setControlState(c, false); } catch(_){} }
  }

  // After exiting water, walk AWAY from the nearest water so we don't drift back in
  // (the shoreline oscillation fix). Finds the nearest water cell, heads the
  // opposite direction for a short burst onto solid ground, then stops.
  async function stepInlandFromWater(){
    try {
      const p = bot.entity.position.floored();
      // find nearest water within a small radius
      let wx=null, wz=null, wd=1e9;
      for (let dx=-4; dx<=4; dx++) for (let dz=-4; dz<=4; dz++){
        const b = bot.blockAt(new Vec3(p.x+dx, p.y, p.z+dz));
        if (b && b.name==='water'){ const d=Math.hypot(dx,dz); if(d<wd){wd=d;wx=dx;wz=dz;} }
      }
      // heading = opposite of the water direction (or arbitrary if none found)
      let hx = wx!==null ? -Math.sign(wx) : 1;
      let hz = wz!==null ? -Math.sign(wz) : 0;
      if (hx===0 && hz===0) hx = 1;
      const target = new Vec3(p.x + hx*4, p.y, p.z + hz*4);
      try { await bot.lookAt(target, true); } catch(_){}
      bot.setControlState('forward', true);
      // walk inland ~1.2s, but stop early if we start entering water again
      const t0 = Date.now();
      while (Date.now() - t0 < 1200){
        if (bot.entity.isInWater) break;
        await new Promise(r => setTimeout(r, 100));
      }
      await clearControls();
    } catch(_){ await clearControls(); }
  }

  // Reflex 1 (water/lava): PERSISTENT escape. The old version swam for 600ms then
  // let go, so a bot just bobbed in place for minutes (observed: Garrick/Rowan
  // stuck 6 min). This one keeps swimming until the bot is genuinely on dry land.
  // Direction: head toward the LAST DRY GROUND we stood on (the way we came in) —
  // NOT a scanned heading, which could point deeper into an ocean and send the bot
  // marching off thousands of blocks. Bounded by time + distance so it can never
  // wander forever; if it can't reach land in the budget it gives up for this
  // episode (liquidCost=60 makes deep-water entry rare, so this is an edge case).
  async function reflexWater(){
    const inLava = bot.entity && bot.entity.isInLava;
    const inWater = bot.entity && (bot.entity.isInWater || bot.entity.isInWaterBottom);
    const oxy = (typeof bot.oxygenLevel === 'number') ? bot.oxygenLevel : 20;
    // Only escape for REAL drowning: lava, or in water with air actually depleting.
    // Standing in shallow water with full oxygen is fine and MUST be left alone —
    // otherwise the farmer (who must stand at the water's edge to till/plant) gets
    // dragged inland every tick, oscillating in/out of water hundreds of times
    // (observed: Rowan, 771 bounces). Water CONTACT is not an emergency; AIR LOSS is.
    if (!inLava && (!inWater || oxy >= 20)) { _waterEpisode = null; return false; }

    const now = Date.now();
    if (!_waterEpisode){
      _waterEpisode = { startedAt: now, startPos: bot.entity.position.clone(), lastLog: 0 };
      log('[watchdog] entered ' + (inLava ? 'LAVA' : 'water') + ' — escaping toward last dry ground');
    }
    // BOUNDS: never swim more than ~45s or ~150 blocks from where we fell in.
    const elapsed = now - _waterEpisode.startedAt;
    const drift = bot.entity.position.distanceTo(_waterEpisode.startPos);
    if (elapsed > 45000 || drift > 150){
      // Give up this episode: stop swimming, let the bot settle. It's still alive
      // (treading beats drowning). Log once; a fresh episode starts if it re-enters.
      if (now - _waterEpisode.lastLog > 10000){
        log('[watchdog] could not reach land in ' + Math.round(elapsed/1000) + 's / '
          + Math.round(drift) + 'm — holding position (bounded to avoid drifting away)');
        _waterEpisode.lastLog = now;
      }
      await clearControls();
      // keep _inWaterNow true so cycles stay blocked; try again next tick after a beat
      await new Promise(r => setTimeout(r, 500));
      return true;
    }

    // Target: the last dry ground we remember standing on (the way back to shore).
    // Fall back to a short scan for nearby land if we have no memory yet.
    let tgt = _lastDryPos;
    if (!tgt){
      const p = bot.entity.position.floored();
      for (let r = 3; r <= 16 && !tgt; r += 2){
        for (const [dx,dz] of [[r,0],[-r,0],[0,r],[0,-r],[r,r],[-r,-r],[r,-r],[-r,r]]){
          const ground = bot.blockAt(new Vec3(p.x+dx, p.y-1, p.z+dz));
          const feet = bot.blockAt(new Vec3(p.x+dx, p.y, p.z+dz));
          const head = bot.blockAt(new Vec3(p.x+dx, p.y+1, p.z+dz));
          if (ground && ground.boundingBox === 'block' && feet && feet.name === 'air'
              && head && head.name === 'air'){ tgt = { x:p.x+dx, y:p.y, z:p.z+dz }; break; }
        }
      }
    }

    // Swim: hold jump (stay surfaced) + move toward the target continuously. We do
    // NOT release controls at the end — we keep them set and let the NEXT tick
    // re-affirm, so movement is continuous instead of stop-start bobbing.
    bot.setControlState('jump', true);
    if (tgt){
      try { await bot.lookAt(new Vec3(tgt.x, bot.entity.position.y, tgt.z), true); } catch(_){}
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
    } else {
      // No memory and no land in scan range: swim back the way we drifted from the
      // entry point (toward startPos), which is provably closer to where we began.
      const back = _waterEpisode.startPos;
      try { await bot.lookAt(new Vec3(back.x, bot.entity.position.y, back.z), true); } catch(_){}
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
    }
    // throttled progress log (every 10s), not every tick
    if (now - _waterEpisode.lastLog > 10000){
      log('[watchdog] still escaping ' + (inLava?'lava':'water') + ' — '
        + Math.round(elapsed/1000) + 's, drifted ' + Math.round(drift) + 'm');
      _waterEpisode.lastLog = now;
    }
    // let it swim a beat, but DON'T clear controls (continuous movement)
    await new Promise(r => setTimeout(r, 400));
    return true;
  }

  // Reflex 3: health/food low → eat if we have food.
  async function reflexEat(){
    const hungry = (bot.food !== undefined && bot.food <= 16);
    const hurt = (bot.health !== undefined && bot.health <= 12);
    if (!hungry && !hurt) return false;
    const food = foodInInv();
    if (!food) return false;
    try {
      const item = bot.inventory.items().find(i => i.name === food);
      await bot.equip(item, 'hand');
      log('[watchdog] low (hp=' + bot.health + ' food=' + bot.food + ') — eating ' + food);
      await bot.consume();
      return true;
    } catch(_){ return false; }
  }

  // Reflex 2: a hostile is close → back away from it (flee), and eat if we can.
  async function reflexFlee(){
    let nearest = null, nd = 1e9;
    for (const id in bot.entities){
      const e = bot.entities[id];
      if (!e || !e.position || !e.name) continue;
      if (!HOSTILES.has(e.name)) continue;
      const d = e.position.distanceTo(bot.entity.position);
      if (d < nd){ nd = d; nearest = e; }
    }
    if (!nearest || nd > 8) return false;    // only react when genuinely close
    // Fight if we have a weapon (sword/axe) and aren't badly hurt; otherwise retreat.
    const weapon = ['netherite_sword','diamond_sword','iron_sword','stone_sword',
      'wooden_sword','netherite_axe','diamond_axe','iron_axe','stone_axe','wooden_axe']
      .find(n => bot.inventory.items().some(i => i.name === n));
    const hp = (typeof bot.health === 'number') ? bot.health : 20;
    if (weapon && hp > 8){
      log('[watchdog] hostile ' + nearest.name + ' at ' + nd.toFixed(1) + 'm — fighting with ' + weapon);
      try {
        const item = bot.inventory.items().find(i => i.name === weapon);
        await bot.equip(item, 'hand');
      } catch(_){}
      // close in and swing a few times
      for (let i=0; i<4 && nearest && nearest.isValid; i++){
        try { await bot.pathfinder.goto(new goals.GoalFollow(nearest, 2)); } catch(_){}
        try { await bot.lookAt(nearest.position.offset(0, nearest.height?nearest.height*0.9:1, 0)); } catch(_){}
        try { bot.attack(nearest); } catch(_){}
        await new Promise(r => setTimeout(r, 300));
      }
      await clearControls();
      return true;
    }
    // No weapon (or too hurt to fight): retreat on land — face the threat, back away.
    log('[watchdog] hostile ' + nearest.name + ' at ' + nd.toFixed(1) + 'm — retreating (no weapon/low hp)');
    try { await bot.lookAt(nearest.position.offset(0, 1, 0), true); } catch(_){}
    bot.setControlState('back', true);
    bot.setControlState('sprint', true);
    await new Promise(r => setTimeout(r, 700));
    await clearControls();
    return true;
  }

  // Reflex 4b: suffocating (head block solid) → try to hop/step out.
  async function reflexSuffocate(){
    const head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
    if (!head || head.boundingBox !== 'block' || head.name === 'air') return false;
    log('[watchdog] head blocked (' + head.name + ') — hopping to free space');
    bot.setControlState('jump', true);
    bot.setControlState('forward', true);
    await new Promise(r => setTimeout(r, 500));
    await clearControls();
    return true;
  }

  const tick = async () => {
    if (!ready || _watchdogBusy) return;
    if (!bot.entity || bot.entity.health === 0) return;

    // EMERGENCY EXCEPTION to "hands-off during skills": the watchdog normally never
    // touches the bot while a skill runs. The ONE exception is genuine DROWNING —
    // ACTUAL AIR LOSS, not water contact and not being hurt near water. Two bugs in
    // the previous version (seen in a 289-emergency run): (1) the health<=15 clause
    // fired for ANY injury while wet — a mob attacking a bot standing in water read
    // as "drowning", and swimming did nothing about the mob, so it re-fired every
    // tick as HP fell; (2) it dragged the FARMER (Rowan) off its fields, because
    // farming requires standing at the water's edge — full oxygen, no danger, but
    // the watchdog kept fleeing inland, fighting the bot's own purpose (771 water
    // bounces). Fix: drowning = in liquid AND (lava OR oxygen actually below full).
    // Mob damage is a SEPARATE threat handled on land (see reflexFlee), never by
    // swimming. A bot with full oxygen in shallow water is FINE — leave it be.
    const inLiquid = bot.entity.isInWater || bot.entity.isInWaterBottom || bot.entity.isInLava;
    const inLava = bot.entity.isInLava;
    const oxy = (typeof bot.oxygenLevel === 'number') ? bot.oxygenLevel : 20;
    // oxy < 20 means air is actually being consumed (head underwater); full oxygen
    // in shallow water is not drowning. Lava is always an emergency.
    const drowning = inLava || (inLiquid && oxy < 20);

    // MOB DAMAGE emergency (SEPARATE from drowning, handled on LAND not by swimming).
    // Under attack = health actively FALLING since last tick (not merely low) AND a
    // hostile is close. Detecting a DROP avoids firing on a bot that's just low.
    const hp = (typeof bot.health === 'number') ? bot.health : 20;
    const tookDamage = hp < _lastHealth - 0.5;
    _lastHealth = hp;
    let hostileNear = false;
    if (tookDamage){
      for (const id in bot.entities){
        const e = bot.entities[id];
        if (e && e.position && e.name && HOSTILES.has(e.name)
            && e.position.distanceTo(bot.entity.position) <= 8){ hostileNear = true; break; }
      }
    }
    const mobEmergency = tookDamage && hostileNear && !drowning;

    // Single decision on whether the watchdog may act while a skill is running: only
    // for a genuine emergency (drowning or active mob attack). Otherwise hands-off.
    if (_skillRunning && !drowning && !mobEmergency) return;
    if (_skillRunning && drowning){
      log('[watchdog] EMERGENCY: drowning during a skill (oxy=' + oxy + ') — interrupting to escape');
      try { if (bot.pathfinder && bot.pathfinder.setGoal) bot.pathfinder.setGoal(null); } catch(_){}
      _skillInterruptedByDrowning = true;
    } else if (_skillRunning && mobEmergency){
      log('[watchdog] EMERGENCY: under mob attack during a skill (hp=' + hp + ') — interrupting to defend');
      try { if (bot.pathfinder && bot.pathfinder.setGoal) bot.pathfinder.setGoal(null); } catch(_){}
      _skillInterruptedByMob = true;
    }

    // Track whether we're in water (read by handle() to BLOCK cycles until out) and
    // remember the last DRY ground we stood on (used as the escape target — the way
    // back to shore). Cheap; runs every tick regardless of which reflex fires.
    if (!inLiquid && bot.entity.onGround){
      // Only remember this as safe ground if it has NO water in the 8 cells around
      // it. The shoreline-oscillation bug (Rowan: 148 water entries) came from
      // saving a dry block one step from water as _lastDryPos — the escape swam the
      // bot right back to the water's edge, it drifted in, repeat. A safe re-plan
      // spot must be genuinely inland.
      const b = bot.entity.position.floored();
      let waterAdjacent = false;
      for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]){
        const n = bot.blockAt(new Vec3(b.x+dx, b.y, b.z+dz));
        const nb = bot.blockAt(new Vec3(b.x+dx, b.y-1, b.z+dz));
        if ((n && (n.name==='water'||n.name==='lava')) || (nb && (nb.name==='water'||nb.name==='lava'))){
          waterAdjacent = true; break;
        }
      }
      if (!waterAdjacent) _lastDryPos = b;   // genuinely inland → safe to return to
    }
    const wasInWater = _inWaterNow;
    _inWaterNow = !!drowning;   // only block cycles when actually drowning, not shallow contact
    if (wasInWater && !_inWaterNow){
      // Was drowning, now clear. If we escaped deep water we may be at the edge and
      // could drift back; step inland and re-plan. (Shallow-water work never sets
      // _inWaterNow, so this only runs after a real escape, not for a farmer who
      // briefly touched water — no more dragging the farmer off its fields.)
      await clearControls();
      await stepInlandFromWater();
      log('[watchdog] escaped drowning — moved inland, cycles unblocked');
    }

    _watchdogBusy = true;
    try {
      // Priority order: get out of liquid first (drowning is fastest death), then
      // suffocation, then flee mobs, then top up food. One reflex per tick.
      if (await reflexWater()) return;
      if (await reflexSuffocate()) return;
      if (await reflexFlee()) return;
      await reflexEat();
    } catch (e){
      // never let a reflex error kill the host
      try { log('[watchdog] reflex error: ' + (e && e.message)); } catch(_){}
    } finally {
      _watchdogBusy = false;
    }
  };

  // ~4Hz check. Cheap: most ticks bail immediately on the guard above.
  setInterval(() => { tick().catch(()=>{}); }, 250);
}


// Compact top-down spatial map of the blocks around the bot. The LLM previously
// saw only nearbyBlockCensus — a HISTOGRAM ({cobblestone:8}) with zero spatial
// info, so it built walls blind and produced disconnected/floating fragments (it
// literally could not perceive a gap or whether anything was enclosed). This gives
// RAW spatial sight, not interpretation: the LLM draws its own conclusions about
// enclosure. ~radius 5 => an 11x11 grid; cheap (~150 tokens).
//
// Format: a top-down grid centered on the bot. Each cell shows the SURFACE within
// a vertical band around the bot's feet, using a small legend so the model can read
// walls/gaps/structure. '@' = the bot. Rows are north(-Z) to south(+Z); columns
// west(-X) to east(+X). A separate short list gives the height of solid columns so
// the model can reason about wall height / roofs.
function buildSpatialMap(radius=5){
  try {
    const p = bot.entity.position.floored();
    const glyph = (name) => {
      if (!name || name === 'air') return '.';
      if (name === 'water') return '~';
      if (name === 'lava') return 'L';
      if (name.includes('log')) return 'W';        // wood log
      if (name.includes('planks')) return 'P';
      if (name === 'cobblestone' || name === 'stone' || name.includes('stone')) return 'C';
      if (name === 'dirt' || name === 'grass_block' || name === 'coarse_dirt') return 'd';
      if (name.includes('fence')) return 'f';
      if (name === 'torch' || name === 'wall_torch') return 'i';
      if (name === 'crafting_table') return 'T';
      if (name === 'furnace') return 'F';
      if (name === 'chest') return 'H';
      if (name === 'farmland') return 'm';
      return '#';                                   // some other solid block
    };
    // For each column (dx,dz), find the TOPMOST non-air block within a vertical band
    // [-2 .. +4] around the bot's feet (captures floor, walls, low roofs).
    const rows = [];
    for (let dz=-radius; dz<=radius; dz++){
      let row = '';
      for (let dx=-radius; dx<=radius; dx++){
        if (dx===0 && dz===0){ row += '@'; continue; }
        let g = '.';
        for (let dy=4; dy>=-2; dy--){               // top-down: first solid wins
          const b = bot.blockAt(new Vec3(p.x+dx, p.y+dy, p.z+dz));
          if (b && b.name !== 'air'){ g = glyph(b.name); break; }
        }
        row += g;
      }
      rows.push(row);
    }
    const legend = ".=air/empty @=you C=stone/cobble P=planks W=log d=dirt/grass "
      + "f=fence i=torch T=table F=furnace H=chest ~=water m=farmland #=other";
    // SURFACE HEIGHT GRID: for each column, the Y of the highest solid block (the
    // ground/'build-on' level). The LLM was picking placement coordinates in mid-air
    // (nothing under them) and getting silent failures; with the ground height per
    // column it can choose coordinates that actually connect to terrain — place AT
    // surfaceY+1 to build up from the ground, not floating at an arbitrary Y.
    const heights = [];
    for (let dz=-radius; dz<=radius; dz++){
      const hrow = [];
      for (let dx=-radius; dx<=radius; dx++){
        let topY = null;
        for (let dy=6; dy>=-6; dy--){
          const b = bot.blockAt(new Vec3(p.x+dx, p.y+dy, p.z+dz));
          if (b && b.name !== 'air' && b.boundingBox === 'block'){ topY = p.y+dy; break; }
        }
        hrow.push(topY);
      }
      heights.push(hrow);
    }
    return {
      note: "Top-down map, radius " + radius + ". Rows N(-Z)->S(+Z), cols W(-X)->E(+X). "
          + "Shows the topmost block in each column near your level, so you can SEE "
          + "walls, gaps, and whether a structure is actually closed. `surfaceHeights` "
          + "gives the ground Y per column — to build ON the ground, place blocks at "
          + "surfaceHeight+1; placing at an arbitrary Y with nothing under/beside it "
          + "will FAIL (blocks can't float). Build up from the ground or out from an "
          + "existing block.",
      legend,
      grid: rows,           // array of strings, one per row (north to south)
      surfaceHeights: heights,   // ground Y per column, same layout as grid
      origin: { x:p.x, y:p.y, z:p.z },
    };
  } catch(e){ return { error: 'map failed: ' + (e && e.message) }; }
}

function snapshot(){
  if (!ready) return { ready:false };
  const p = bot.entity.position;
  const inv = {};
  for (const item of bot.inventory.items()) inv[item.name] = (inv[item.name]||0)+item.count;
  const nearbyBlocks = {};
  const radius = 6, base = p.floored();
  for (let dx=-radius; dx<=radius; dx+=2)
    for (let dy=-3; dy<=3; dy+=1)
      for (let dz=-radius; dz<=radius; dz+=2){
        const b = bot.blockAt(base.offset(dx,dy,dz));
        if (b && b.name !== 'air') nearbyBlocks[b.name] = (nearbyBlocks[b.name]||0)+1;
      }
  const players = Object.keys(bot.players).filter(n => n !== bot.username);
  const nearbyEntities = Object.values(bot.entities)
    .filter(e => e.position && e.position.distanceTo(p) < 16 && e.type !== 'object')
    .map(e => ({ name:e.name||e.displayName, type:e.type, dist:+e.position.distanceTo(p).toFixed(1) }))
    .slice(0,12);

  // --- mobility census: FACTUAL description of whether the bot is boxed in ---
  const mobility = computeMobility();

  // --- scan for shared community structures nearby (tables, chests, furnaces) ---
  // Factual: reports what infrastructure actually exists near the bot, so the
  // orchestrator can keep the shared registry grounded in reality.
  const SHARED = ['crafting_table','furnace','blast_furnace','smoker','chest',
    'barrel','smithing_table','anvil','brewing_stand','enchanting_table','bed',
    'campfire','cartography_table','loom','stonecutter'];
  const structuresNearby = [];
  try {
    const ids = SHARED.map(n => mcData.blocksByName[n] && mcData.blocksByName[n].id).filter(Boolean);
    if (ids.length){
      const found = bot.findBlocks({ matching: ids, maxDistance: 24, count: 20 }) || [];
      for (const v of found){
        const b = bot.blockAt(v);
        if (b) structuresNearby.push({ kind:b.name, x:v.x, y:v.y, z:v.z });
      }
    }
  } catch(e){ /* non-fatal */ }

  return {
    ready:true, username:bot.username, version:bot.version,
    position:{ x:+p.x.toFixed(1), y:+p.y.toFixed(1), z:+p.z.toFixed(1) },
    health:bot.health, food:bot.food, timeOfDay:bot.time.timeOfDay, isRaining:bot.isRaining,
    inventory:inv, heldItem: bot.heldItem ? bot.heldItem.name : null,
    nearbyBlockCensus:nearbyBlocks, nearbyPlayers:players, nearbyEntities,
    mobility, structuresNearby, spatialMap: buildSpatialMap(5),
  };
}

// Shared mobility computation: reports the bot's physical confinement. Called by
// snapshot() AND exposed to skill code via helpers.mobility() so generated code
// can self-check mid-action whether it's boxing itself in.
function computeMobility(){
  if (!ready || !bot.entity) return null;
  const feet = bot.entity.position.floored();
  const solid = (b) => b && b.name !== 'air' && b.boundingBox === 'block';
  const dirs = { north:[0,0,-1], south:[0,0,1], east:[1,0,0], west:[-1,0,0] };
  const wallsAtHead = [];
  for (const [name,[dx, ,dz]] of Object.entries(dirs))
    if (solid(bot.blockAt(feet.offset(dx, 1, dz)))) wallsAtHead.push(name);
  const headClear = !solid(bot.blockAt(feet.offset(0, 2, 0)));
  let dropBelow = 0;
  for (let d = 1; d <= 8; d++) {
    if (solid(bot.blockAt(feet.offset(0, -d, 0)))) { dropBelow = d - 1; break; }
    dropBelow = d;
  }
  let wallsAtFeet = 0;
  for (const [ , [dx, ,dz]] of Object.entries(dirs))
    if (solid(bot.blockAt(feet.offset(dx, 0, dz)))) wallsAtFeet++;
  // How high is the lip around us? If every side wall is only 1 block tall and
  // there's open air above it, the bot can just jump out — that is NOT a trap,
  // it's the normal state after mining a block at foot level. A real trap is
  // walls that continue above head height (can't jump over) OR a deep pit.
  let liftableSides = 0;   // side cells whose block-above is air (jump-out-able)
  for (const [ , [dx, ,dz]] of Object.entries(dirs)){
    const side = bot.blockAt(feet.offset(dx, 0, dz));
    const sideAbove = bot.blockAt(feet.offset(dx, 1, dz));
    if (solid(side) && sideAbove && sideAbove.name === 'air') liftableSides++;
  }
  const boxedIn = wallsAtHead.length >= 3;   // walls at HEAD height on 3+ sides
  // "Stuck" only if genuinely hard to leave: boxed at head height, or sitting in
  // a pit whose walls are taller than 1 (can't just hop out) while head is
  // covered. A 1-deep mining hole with clear sky above is recoverable, not stuck.
  const recoverableByJump = headClear && liftableSides >= wallsAtFeet && wallsAtFeet > 0;
  // Is there OPEN SKY straight up? Scan from head upward; if we hit only air all
  // the way to a generous height, we're on/near the surface with the sky above —
  // which means pillaring UP is pointless and horizontal escape is correct. If we
  // hit a solid ceiling, we may be genuinely buried and pillaring can be valid.
  let openSkyAbove = true;
  let ceilingAt = 0;
  for (let d = 2; d <= 16; d++){
    const b = bot.blockAt(feet.offset(0, d, 0));
    if (solid(b)) { openSkyAbove = false; ceilingAt = d; break; }
  }
  return {
    blockedSidesAtHead: wallsAtHead,
    canJumpUp: headClear,
    surroundedAtFeet: wallsAtFeet,
    liftableSides,                 // sides the bot can simply jump out over
    dropStraightDown: dropBelow,
    recoverableByJump,             // true = shallow hole, just jump; not a real trap
    openSkyAbove,                  // true = surface (don't pillar up; go sideways)
    ceilingAt,                     // height of solid ceiling above, 0 if open sky
    likelyStuckInHole: (boxedIn || (wallsAtFeet >= 3 && !recoverableByJump)),
  };
}

const helpers = {
  goals,
  async gotoXYZ(x,y,z,range=1){ await bot.pathfinder.goto(new goals.GoalNear(x,y,z,range)); },
  async waitTicks(n){ await new Promise(res=>{ let c=0; const t=()=>{ if(++c>=n){ bot.removeListener('physicsTick',t); res(); } }; bot.on('physicsTick',t); }); },
  findBlocks(name,count=1,maxDistance=32){ const ids = mcData.blocksByName[name] ? [mcData.blocksByName[name].id] : []; return bot.findBlocks({ matching:ids, maxDistance, count }); },
  mobility(){ return computeMobility(); },   // live self-check: am I boxing myself in?

  // ---- entities the bot can see (skill code has NO state var) ----
  nearbyEntities(maxDist=16){
    const p = bot.entity.position;
    return Object.values(bot.entities)
      .filter(e => e.position && e !== bot.entity && e.position.distanceTo(p) < maxDist)
      .map(e => ({ name:e.name||e.displayName, type:e.type, kind:e.kind,
                   dist:+e.position.distanceTo(p).toFixed(1),
                   pos:{x:e.position.x,y:e.position.y,z:e.position.z}, id:e.id }));
  },
  nearestHostile(maxDist=16){
    const p = bot.entity.position;
    let best=null, bd=maxDist;
    for (const e of Object.values(bot.entities)){
      if (!e.position || e===bot.entity) continue;
      const hostile = e.kind === 'Hostile mobs' || e.type === 'hostile' ||
        ['zombie','skeleton','spider','creeper','enderman','witch'].includes(e.name);
      if (!hostile) continue;
      const d = e.position.distanceTo(p);
      if (d < bd){ bd=d; best=e; }
    }
    return best;
  },

  // ---- CRAFTING (the exact recipesFor/craft dance; requiresTable handled) ----
  // name = item to make (e.g. 'oak_planks'). count = how many OUTPUT items you want.
  // Finds/uses a crafting table automatically if the recipe needs one.
  async craftItem(name, count=1, _depth=0){
    // NAME NORMALIZATION: the LLM frequently guesses item names that don't exist in
    // mcData — "sticks" (should be "stick"), "plank"/"planks" (needs a species),
    // "wood_planks", "wood". These caused hard "unknown item 'sticks'" craft
    // failures (7 in the last run) that blocked the whole wood->pickaxe path. Map
    // the common mistakes to real names before anything else runs.
    if (typeof name === 'string'){
      name = name.trim().toLowerCase().replace(/\s+/g,'_');
      const FIX = {
        sticks: 'stick',
        stick_item: 'stick',
        plank: 'oak_planks',
        planks: 'oak_planks',
        wood_plank: 'oak_planks',
        wood_planks: 'oak_planks',
        wooden_planks: 'oak_planks',
        wood: 'oak_planks',
        crafting_bench: 'crafting_table',
        workbench: 'crafting_table',
        wood_pickaxe: 'wooden_pickaxe',
        wood_axe: 'wooden_axe',
        wood_sword: 'wooden_sword',
        wood_shovel: 'wooden_shovel',
        wood_hoe: 'wooden_hoe',
      };
      if (FIX[name]) name = FIX[name];
      // If they asked for "<species>_plank" (singular), pluralize to real name.
      if (/_plank$/.test(name)) name = name.replace(/_plank$/, '_planks');
      // If the normalized name STILL isn't a real item, and a generic wood item is
      // clearly intended, fall back to oak variants so craft can proceed.
      if (!mcData.itemsByName[name] && !mcData.blocksByName[name]){
        if (name.includes('plank')) name = 'oak_planks';
        else if (name.includes('stick')) name = 'stick';
      }
    }
    // Generic-wood substitution: bots often ask for a specific species (birch/
    // cherry) they don't have. If they asked for '<species>_planks' but lack the
    // matching log, redirect to a species they actually possess.
    if (name.endsWith('_planks')){
      const haveThis = helpers.invCount(name) > 0;
      const species = name.replace('_planks','');
      const haveLog = helpers.invCount(species + '_log') > 0;
      if (!haveThis && !haveLog){
        const altLog = helpers.anyLogInInventory();
        const altPlanks = helpers.anyPlanksInInventory();
        if (altPlanks){ return { ok:true, crafted:altPlanks, count:helpers.invCount(altPlanks),
                                 note:`already have ${altPlanks}` }; }
        if (altLog){ name = altLog.replace('_log','_planks'); }
      }
    }
    const item = mcData.itemsByName[name];
    if (!item) return { ok:false, reason:`unknown item '${name}'` };
    // recipes we can do with current inventory (null table = inventory-only).
    // recipesFor with the metadata filter already restricts to inventory-craftable
    // recipes, BUT when several exist (one per wood species) it does not guarantee
    // the one whose inputs we actually hold is first. Reorder so the recipe our
    // inventory best covers is index 0 — this is what stops "have oak_planks but
    // told missing cherry_planks": the resolver was locking onto the first species
    // by item-id, not the species in hand.
    let recipes = helpers._rankRecipes(item.id, null);
    let table = null;
    if (!recipes || recipes.length === 0){
      // recipe needs a crafting table. Prefer, in order: a table right here, then
      // the community HOME/workshop (walk there — this is what stops table spam and
      // keeps infrastructure at one center), then any table we can reach, and only
      // as a LAST resort place a temporary one where we stand.
      const tblId = mcData.blocksByName.crafting_table ? mcData.blocksByName.crafting_table.id : -1;
      let tbl = bot.findBlock({ matching: tblId, maxDistance: 6 });

      // DECONGEST (20-bot fix): a crafting table is DISPOSABLE, not civic
      // infrastructure. The old policy walked every bot to the ONE shared workshop
      // table, so 20 bots stacked on a single block, collided (offline-mode entity
      // collision), and none could reach it — the pervasive "craft window did not
      // open" + "could not path within reach" pile-up, and the "blocking each other
      // in a hole" the operator saw. Now: if there's no table right here but we HOLD
      // one, just place it where we stand and craft locally. Chests/furnaces/storage
      // remain shared and centered (separate code paths); only the throwaway craft
      // table goes local. This trades a few extra tables for not gridlocking the base.
      if (!tbl && helpers.hasItem('crafting_table')){
        if (await helpers.placeNearby('crafting_table')){
          tbl = bot.findBlock({ matching: tblId, maxDistance: 6 });
          if (tbl) _lastCraftPlacedTempTable = true;
        }
      }

      // HOME FIRST: if the civilization has an established workshop, go craft there
      // rather than dropping a new table wherever we happen to be. _worldContext is
      // pushed by the orchestrator each run and is the shared, persistent memory of
      // "where home is" — the bot doesn't need to see it locally to know it exists.
      if (!tbl && _worldContext && _worldContext.workshop){
        const w = _worldContext.workshop;
        try {
          await bot.pathfinder.goto(new goals.GoalNear(w.x, w.y, w.z, 3));
          tbl = bot.findBlock({ matching: tblId, maxDistance: 6 });
          // At home but no table built yet? Place ONE here to seed the workshop.
          if (!tbl && helpers.hasItem('crafting_table')){
            if (await helpers.placeNearby('crafting_table'))
              tbl = bot.findBlock({ matching: tblId, maxDistance: 6 });
          }
        } catch(e){ /* couldn't reach home this cycle; fall through */ }
      }

      // Otherwise walk to the nearest table we can find in a WIDE radius rather than
      // duplicating (covers the pre-workshop early game before home is sited).
      if (!tbl){
        const far = bot.findBlock({ matching: tblId, maxDistance: 64 });
        if (far){
          try {
            await bot.pathfinder.goto(new goals.GoalNear(far.position.x, far.position.y, far.position.z, 2));
            tbl = bot.findBlock({ matching: tblId, maxDistance: 6 });
          } catch(e){ /* couldn't reach it; fall through */ }
        }
      }
      // LAST RESORT: no reachable table anywhere. Place a temporary one we hold (or
      // craft+place). Flagged temporary so the orchestrator does NOT register it as
      // permanent civic infrastructure — we do not want scattered mini-bases. When
      // home exists but was unreachable, this is a stopgap for THIS craft only.
      let placedTemp = false;
      if (!tbl && helpers.hasItem('crafting_table')){
        const placed = await helpers.placeNearby('crafting_table');
        if (placed){ tbl = bot.findBlock({ matching: tblId, maxDistance: 6 }); placedTemp = true; }
      }
      if (!tbl && !helpers.hasItem('crafting_table')){
        const tRec = bot.recipesFor(mcData.itemsByName.crafting_table.id, null, 1, null);
        if (tRec && tRec.length){
          try { await bot.craft(tRec[0], 1, null); } catch(e){}
          if (helpers.hasItem('crafting_table')){
            const placed = await helpers.placeNearby('crafting_table');
            if (placed){ tbl = bot.findBlock({ matching: tblId, maxDistance: 6 }); placedTemp = true; }
          }
        }
      }
      if (placedTemp) _lastCraftPlacedTempTable = true;
      if (tbl){ table = tbl; recipes = helpers._rankRecipes(item.id, tbl); }
    }
    if (!recipes || recipes.length === 0){
      // Can't craft yet. Figure out WHAT'S MISSING using recipesAll (ignores
      // inventory) so we can tell the bot the exact prerequisites — this lets it
      // sequence its own tech tree instead of us hardcoding "wood before stone".
      const missing = helpers._missingFor(name, table);
      if (missing && missing.length){
        // AUTO-CRAFT INTERMEDIATES: if a missing ingredient is itself something we
        // can craft RIGHT NOW from what we hold (the classic case: need planks/
        // sticks, have logs/planks), make it and retry — instead of bouncing the
        // whole task back to the planner one rung at a time. Guarded by _depth so
        // this can't recurse forever. General (reads recipes), not a hardcoded tree.
        if (_depth < 3){
          let madeSomething = false;
          for (const miss of missing){
            let target = miss.name;
            // planks are the usual blocker; substitute a species we actually own
            if (target.endsWith('_planks') && helpers.invCount(target) === 0){
              const altLog = helpers.anyLogInInventory();
              if (altLog) target = altLog.replace('_log','_planks');
            }
            const sub = await helpers.craftItem(target, miss.count, _depth + 1);
            if (sub && sub.ok) madeSomething = true;
          }
          if (madeSomething){
            // retry the original now that we may have the intermediates
            return await helpers.craftItem(name, count, _depth + 1);
          }
        }
        return { ok:false, env_failure:true, reason:`cannot craft ${name} yet — missing: ` +
          missing.map(m=>`${m.count} ${m.name}`).join(', ') +
          `. Acquire these first (mine/craft/gather), then retry.`,
          missing };
      }
      return { ok:false, env_failure:true, reason:`no recipe available for ${name} (need materials, or could not place/reach a crafting table)` };
    }
    // recipes is already ranked best-covered-first. If even the best still has a
    // shortfall, don't call bot.craft (it would throw a vague "must be present"
    // error). Instead recurse into the intermediates path by reporting what's
    // missing for the SPECIES WE'D ACTUALLY USE.
    const recipe = recipes[0];
    const shortfall = helpers._recipeShortfall(recipe);
    if (shortfall > 0){
      const need = helpers._recipeNeeds(recipe);
      const missing = [];
      for (const [nm, cnt] of Object.entries(need)){
        const have = helpers.invCount(nm);
        if (have < cnt) missing.push({ name:nm, count: cnt - have });
      }
      // try to auto-make the intermediates once, then retry (same logic as above)
      if (_depth < 3 && missing.length){
        let made = false;
        for (const miss of missing){
          let target = miss.name;
          if (target.endsWith('_planks') && helpers.invCount(target) === 0){
            const altLog = helpers.anyLogInInventory();
            if (altLog) target = altLog.replace('_log','_planks');
          }
          const sub = await helpers.craftItem(target, miss.count, _depth + 1);
          if (sub && sub.ok) made = true;
        }
        if (made) return await helpers.craftItem(name, count, _depth + 1);
      }
      return { ok:false, env_failure:true, missing,
        reason:`cannot craft ${name} yet — missing: ` +
          missing.map(m=>`${m.count} ${m.name}`).join(', ') +
          `. Acquire these first (mine/craft/gather), then retry.` };
    }
    // count is OUTPUT items; craft() count is operations, so divide by yield
    const per = (recipe.result && recipe.result.count) ? recipe.result.count : 1;
    const ops = Math.max(1, Math.ceil(count / per));
    if (table){
      try { await bot.pathfinder.goto(new goals.GoalNear(table.position.x,table.position.y,table.position.z,2)); } catch(e){}
      // LOOK AT THE TABLE before crafting. bot.craft opens the crafting-table GUI
      // and waits for a `windowOpen` event; if the bot isn't facing the table that
      // event may never fire, producing the pervasive "windowOpen did not fire within
      // 20000ms" failure. Facing it first makes the window open reliably.
      try { await bot.lookAt(table.position.offset(0.5, 0.5, 0.5), true); } catch(e){}
      await helpers.waitTicks(2);
    }
    try {
      // Race the craft against a bounded timeout so a stuck windowOpen costs ~6s,
      // not the full skill budget, and reports a clean retryable reason.
      await Promise.race([
        bot.craft(recipe, ops, table),
        new Promise((_, rej) => setTimeout(() => rej(new Error('craft window did not open')), 6000)),
      ]);
      const got = helpers.invCount(name);
      return { ok: got > 0, crafted:name, count: got,
               reason: got>0 ? undefined : 'craft call returned but item not in inventory' };
    } catch (e){
      const msg = String(e.message||e);
      // windowOpen/timeout is transient (table busy, GUI race) — mark retryable, not
      // a code defect, so the critic doesn't manufacture a bogus lesson.
      const transient = /window|timeout|did not open|did not fire/i.test(msg);
      return { ok:false, env_failure: transient || undefined, reason:'craft error: '+msg };
    }
  },

  // ---- CHEST STORAGE: deposit/withdraw to shared community chests -------------
  // Open a chest/barrel RELIABLY. bot.openContainer waits for a `windowOpen` event
  // that never fires if the bot isn't facing the block or is a hair out of range —
  // producing the pervasive "Event windowOpen did not fire within timeout of
  // 20000ms" that blocked Flint's whole cycle (4 dead attempts, 0 deposits). Same
  // root cause and same fix as crafting: get within reach, LOOK AT the chest, then
  // race the open against a bounded timeout so a stuck window costs ~6s not 20s,
  // and retry once from a re-approached position. Returns {chest} or {err}.
  async _openContainerReliably(block, tries=2){
    let lastErr = 'unknown';
    for (let attempt=0; attempt<tries; attempt++){
      // (re)approach: on a retry, come at it from close range again — the first
      // failure is often "just out of reach" after pathing stopped a block short.
      try {
        await bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, attempt===0 ? 2 : 1));
      } catch(e){}
      // FACE the chest — the single biggest cause of windowOpen never firing.
      try { await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true); } catch(e){}
      await helpers.waitTicks(2);
      try {
        const chest = await Promise.race([
          bot.openContainer(block),
          new Promise((_, rej) => setTimeout(() => rej(new Error('windowOpen did not fire')), 6000)),
        ]);
        return { chest };
      } catch(e){
        lastErr = String(e.message || e);
        await helpers.waitTicks(3);   // let any half-open GUI settle before retrying
      }
    }
    return { err: lastErr };
  },

  // The supply line needs this: a gatherer that can't put items in a shared chest
  // just hoards like everyone else. Uses the real mineflayer container API
  // (openContainer -> window.deposit/withdraw). Null-guarded like smelt so a
  // missing chest can't crash the runner.
  //
  // depositToChest(items): items = [{name, count?}] (count omitted = deposit ALL of
  // that item). Finds the nearest chest (or places one if holding a spare), walks
  // to it, deposits, closes. Returns {ok, deposited:[{name,count}], reason}.
  async depositToChest(items, opts){
    if (!Array.isArray(items) || !items.length)
      return { ok:false, reason:'no items specified to deposit' };
    // find nearest chest, or place one if we're allowed and hold a spare
    let block = null;
    const spots = bot.findBlocks({
      matching: (b) => b && (b.name === 'chest' || b.name === 'barrel'),
      maxDistance: 24, count: 1,
    }) || [];
    if (spots.length) block = bot.blockAt(spots[0]);
    if (!block && (!opts || opts.placeIfMissing !== false) && helpers.hasItem('chest')){
      if (await helpers.placeNearby('chest')){
        const s2 = bot.findBlocks({ matching:(b)=>b&&b.name==='chest', maxDistance:6, count:1 }) || [];
        if (s2.length) block = bot.blockAt(s2[0]);
      }
    }
    if (!block) return { ok:false, needChest:true,
      reason:'no chest within reach and none to place — craft/obtain a chest first' };
    const opened = await helpers._openContainerReliably(block);
    if (opened.err) return { ok:false, env_failure:true,
      reason:'could not open chest: '+opened.err };
    const chest = opened.chest;
    const deposited = [];
    try {
      for (const it of items){
        const name = it.name || it;
        const mc = mcData.itemsByName[name];
        if (!mc) continue;
        const have = helpers.invCount(name);
        const want = (it.count == null) ? have : Math.min(it.count, have);
        if (want <= 0) continue;
        try { await chest.deposit(mc.id, null, want); deposited.push({name, count:want}); }
        catch(e){ /* chest full or item shifted — report what did land */ }
      }
    } finally { try { await chest.close(); } catch(e){} }
    const total = deposited.reduce((a,d)=>a+d.count,0);
    return { ok: total > 0, deposited,
      reason: total>0 ? undefined : 'opened chest but deposited nothing (already empty-handed or chest full)' };
  },

  // withdrawFromChest(items): pull items FROM a shared chest into inventory.
  async withdrawFromChest(items, opts){
    if (!Array.isArray(items) || !items.length)
      return { ok:false, reason:'no items specified to withdraw' };
    const spots = bot.findBlocks({
      matching: (b) => b && (b.name === 'chest' || b.name === 'barrel'),
      maxDistance: 24, count: 1,
    }) || [];
    if (!spots.length) return { ok:false, reason:'no chest within reach' };
    const block = bot.blockAt(spots[0]);
    const opened = await helpers._openContainerReliably(block);
    if (opened.err) return { ok:false, env_failure:true,
      reason:'could not open chest: '+opened.err };
    const chest = opened.chest;
    const withdrawn = [];
    try {
      for (const it of items){
        const name = it.name || it;
        const mc = mcData.itemsByName[name];
        if (!mc) continue;
        const want = (it.count == null) ? 64 : it.count;
        try { await chest.withdraw(mc.id, null, want); withdrawn.push({name, count:want}); }
        catch(e){ /* not enough in chest — skip */ }
      }
    } finally { try { await chest.close(); } catch(e){} }
    const total = withdrawn.reduce((a,d)=>a+d.count,0);
    return { ok: total > 0, withdrawn,
      reason: total>0 ? undefined : 'chest had none of the requested items' };
  },

  // ---- SMELT: the whole furnace operation, safely, in one call ---------------
  // Smelting is a DIFFERENT mineflayer API from crafting (openFurnace -> putFuel
  // -> putInput -> wait -> takeOutput). Without this helper the LLM was forced to
  // hand-write raw bot.openFurnace calls and crashed the runner by passing an
  // undefined furnace block. This does the full dance and reports honestly.
  //
  // What it smelts (input -> output): cobblestone->stone, sand->glass,
  // raw_iron->iron_ingot, raw_copper->copper_ingot, raw_gold->gold_ingot,
  // any _log/_wood -> charcoal (also usable as fuel). NOTE: stone_bricks are
  // CRAFTED from stone (4 in a square), not smelted — smelt cobblestone to stone
  // first, then call craftItem('stone_bricks').
  //
  // Fuel: uses coal/charcoal if held, else falls back to planks/logs/sticks
  // (each smelt op needs ~1 fuel unit per 1-8 items; we add fuel generously).
  // Returns {ok, smelted, count, output, reason}.
  async smelt(inputName, count=1, opts){
    const SMELTS = {
      cobblestone:'stone', cobbled_deepslate:'deepslate', sand:'glass', red_sand:'glass',
      raw_iron:'iron_ingot', raw_copper:'copper_ingot', raw_gold:'gold_ingot',
      clay_ball:'brick', netherrack:'nether_brick', stone:'smooth_stone',
    };
    // logs/wood smelt to charcoal
    let output = SMELTS[inputName];
    if (!output && (inputName.endsWith('_log') || inputName.endsWith('_wood'))) output = 'charcoal';
    if (!output) return { ok:false, reason:`don't know what ${inputName} smelts into` };
    if (helpers.invCount(inputName) <= 0) return { ok:false, reason:`no ${inputName} to smelt` };

    // 1. find a furnace nearby, or place one we're holding
    let fBlock = null;
    const spots = bot.findBlocks({
      matching: (b) => b && (b.name === 'furnace' || b.name === 'blast_furnace'),
      maxDistance: 12, count: 1,
    }) || [];
    if (spots.length) fBlock = bot.blockAt(spots[0]);
    if (!fBlock){
      if (helpers.hasItem('furnace')){
        if (await helpers.placeNearby('furnace')){
          const s2 = bot.findBlocks({ matching:(b)=>b&&b.name==='furnace', maxDistance:6, count:1 }) || [];
          if (s2.length) fBlock = bot.blockAt(s2[0]);
        }
      }
    }
    if (!fBlock) return { ok:false, needFurnace:true,
      reason:'no furnace nearby and none in inventory to place — craft/obtain a furnace first' };

    // 2. walk to it and open it (GUARD: never call openFurnace with a null block)
    try { await bot.pathfinder.goto(new goals.GoalNear(fBlock.position.x, fBlock.position.y, fBlock.position.z, 2)); }
    catch(e){ /* get close enough to interact */ }
    let furnace;
    try { furnace = await bot.openFurnace(fBlock); }
    catch(e){ return { ok:false, reason:'could not open furnace: '+e.message }; }

    try {
      const want = Math.min(count, helpers.invCount(inputName));
      // 3. fuel: prefer coal/charcoal; else planks; else sticks; else logs
      const fuelPref = ['coal','charcoal','oak_planks','birch_planks','spruce_planks',
                        'stick','oak_log','birch_log'];
      const outStart = helpers.invCount(output);
      let inserted = 0, fueled = 0;
      // insert input first so we know how much fuel we need
      const inItem = bot.inventory.items().find(i => i.name === inputName);
      if (inItem){
        try { await furnace.putInput(inItem.type, null, want); inserted = want; } catch(e){}
      }
      // add fuel — 1 coal smelts 8 items, so ceil(want/8) coal, or more of weaker fuel
      const needFuelUnits = Math.max(1, Math.ceil(want / 8));
      for (const fname of fuelPref){
        if (fueled >= needFuelUnits) break;
        const fItem = bot.inventory.items().find(i => i.name === fname);
        if (!fItem) continue;
        // weaker fuels (planks=1.5, stick=0.5 items each) — just add a few
        const addN = (fname === 'coal' || fname === 'charcoal')
          ? Math.min(fItem.count, needFuelUnits - fueled)
          : Math.min(fItem.count, Math.max(2, want));  // generous for weak fuel
        try { await furnace.putFuel(fItem.type, null, addN); fueled += addN; } catch(e){}
      }
      if (inserted === 0) { try{ await furnace.close(); }catch(_){}
        return { ok:false, reason:'could not insert input into furnace' }; }
      if (fueled === 0) { try{ await furnace.close(); }catch(_){}
        return { ok:false, reason:'no fuel available (need coal/charcoal/planks/logs)' }; }

      // 4. wait for smelting to progress — poll output slot up to a bounded time
      const deadline = Date.now() + Math.min(60000, 12000 + want * 10000);
      let produced = 0;
      while (Date.now() < deadline){
        await helpers.waitTicks(20);   // ~1s
        const outItem = furnace.outputItem && furnace.outputItem();
        if (outItem && outItem.count > 0){
          try { await furnace.takeOutput(); produced += outItem.count; } catch(e){}
          if (helpers.invCount(output) - outStart >= want) break;
        }
        // stop early if furnace ran out of fuel AND no more output is coming
        if (furnace.fuel !== null && furnace.fuel <= 0 && (!outItem || outItem.count === 0)
            && produced > 0) break;
      }
      try { await furnace.takeOutput(); } catch(e){}   // grab any final output
      try { await furnace.close(); } catch(e){}
      const gained = helpers.invCount(output) - outStart;
      return { ok: gained > 0, smelted:inputName, output, count:gained,
               reason: gained>0 ? undefined
                 : 'furnace opened and loaded but no output produced in time (fuel/timing)' };
    } catch(e){
      try { await furnace.close(); } catch(_){}
      return { ok:false, reason:'smelt error: '+e.message };
    }
  },

  // Read a recipe's required ingredients as {itemName: count}. Handles both the
  // `delta` shape (negative counts = consumed) and the older `ingredients` shape.
  _recipeNeeds(recipe){
    const need = {};
    const src = recipe.delta || recipe.ingredients || [];
    for (const d of src){
      if (d.count < 0){
        const nm = mcData.items[d.id] ? mcData.items[d.id].name : ('id'+d.id);
        need[nm] = (need[nm]||0) + Math.abs(d.count);
      } else if (recipe.ingredients && d.count > 0 && !recipe.delta){
        const nm = mcData.items[d.id] ? mcData.items[d.id].name : ('id'+d.id);
        need[nm] = (need[nm]||0) + d.count;
      }
    }
    return need;
  },

  // How short is our inventory for this recipe? Returns the total count of
  // ingredient units we're missing (0 = fully craftable right now). This is the
  // score we minimize when choosing among species variants.
  _recipeShortfall(recipe){
    const need = helpers._recipeNeeds(recipe);
    let short = 0;
    for (const [nm, cnt] of Object.entries(need)){
      const have = helpers.invCount(nm);
      if (have < cnt) short += (cnt - have);
    }
    return short;
  },

  // Return recipes for an item, ordered so the one our CURRENT inventory best
  // covers comes first. This is the core fix for wrong-species recipe resolution:
  // when a pickaxe has an oak / birch / cherry / ... variant, we pick the variant
  // whose planks we actually hold instead of the lowest item-id (cherry).
  //
  // `includeUncraftable` controls the recipesAll fallback:
  //   false (default) -> STRICT: only inventory-craftable recipes for this table
  //      context. Returns [] when nothing is craftable as-is. craftItem relies on
  //      this: an empty result at the (table=null) probe is the signal that a
  //      crafting table is required, which drives the table-acquisition branch.
  //      (Returning a recipesAll shape here would skip that branch and then call
  //      bot.craft with no table -> "Recipe requires craftingTable" forever.)
  //   true -> also fall back to recipesAll (ignores inventory) so callers like
  //      _missingFor still get a recipe SHAPE to diff when nothing is craftable.
  // `table` may be a Block, or null for inventory-only.
  _rankRecipes(itemId, table, includeUncraftable=false){
    let list = [];
    // recipesFor(id, meta, minResultCount, craftingTable): inventory-aware
    try { list = bot.recipesFor(itemId, null, 1, table || null) || []; } catch(e){ list = []; }
    if (!list.length && includeUncraftable){
      // none craftable as-is: get every recipe shape (ignores inventory) so callers
      // can still compute what's missing for the best-covered variant.
      try { list = bot.recipesAll(itemId, null, table || null) || []; } catch(e){ list = []; }
      if (!list.length){ try { list = bot.recipesAll(itemId, null, true) || []; } catch(e){ list = []; } }
    }
    if (list.length <= 1) return list;
    // stable sort by ascending inventory shortfall (0 = fully craftable now)
    return list
      .map((r, i) => ({ r, i, s: helpers._recipeShortfall(r) }))
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .map(x => x.r);
  },

  // What ingredients is the bot short on to craft `name`? Uses the BEST-COVERED
  // recipe (via _rankRecipes) so the reported shortfall matches the species we'd
  // actually craft — not an arbitrary first-by-id variant. General across the
  // whole tech tree; no per-item hardcoding.
  _missingFor(name, table){
    const item = mcData.itemsByName[name];
    if (!item) return null;
    // include the inventory-ignoring fallback: we need a recipe SHAPE to diff even
    // when nothing is craftable yet (that's the whole point of "what's missing").
    const ranked = helpers._rankRecipes(item.id, table, true);
    if (!ranked.length) return null;
    const recipe = ranked[0];               // the variant our inventory covers best
    const need = helpers._recipeNeeds(recipe);
    const missing = [];
    for (const [nm, cnt] of Object.entries(need)){
      const have = helpers.invCount(nm);
      if (have < cnt) missing.push({ name:nm, count: cnt - have });
    }
    return missing;
  },

  // ---- collect N of a block: find -> path -> equip best tool -> dig -> repeat ----
  // Handles tool selection and the pick-up. Returns how many were collected.
  async collectBlock(name, count=1, maxDistance=48){
    const blk = mcData.blocksByName[name];
    if (!blk) return { ok:false, reason:`unknown block '${name}'`, collected:0 };
    // Track inventory by the item the block actually DROPS (stone->cobblestone,
    // grass_block->dirt). We report the real inventory gain, not dig-count, so the
    // LLM never has to (mis)read inventory itself.
    const dropName = (blk.drops && blk.drops.length && mcData.items[blk.drops[0]])
      ? mcData.items[blk.drops[0]].name : name;
    const startCount = helpers.invCount(dropName);
    let dug = 0;
    let softFails = 0;                // transient pathfinder interruptions
    let noneFound = false;
    let toolBlocked = 0;              // candidates the current tool can't harvest
    let digDowns = 0;                 // bounded dig-down-to-expose-stone attempts
    // Is this a STONE-type gather? Only stone gets the variant-matching and the
    // dig-down-to-expose fallback. Wood/dirt/etc. must NEVER trigger dig-down —
    // that's what made a bot mine dirt forever when it couldn't reach a tree.
    const isStoneGather = ['stone','cobblestone','deepslate','cobbled_deepslate',
      'andesite','diorite','granite','tuff'].some(s => name.includes(s));
    // For "stone" specifically, also accept the common stone variants a pickaxe
    // yields cobblestone-equivalent from, so a search over open ground/hills finds
    // mineable rock instead of locking onto one exact id (often deep deepslate).
    let matchIds = [blk.id];
    if (name === 'stone'){
      for (const alt of ['stone','andesite','diorite','granite','cobblestone']){
        const a = mcData.blocksByName[alt]; if (a && !matchIds.includes(a.id)) matchIds.push(a.id);
      }
    }
    for (let i=0; i<count; i++){
      const spots = bot.findBlocks({ matching: matchIds, maxDistance, count:16 }) || [];
      if (spots.length===0){ noneFound = true; break; }
      const here = bot.entity.position;
      spots.sort((p,q)=> here.distanceTo(p) - here.distanceTo(q));
      // Pick the nearest candidate the current tool can HARVEST by TOOL TIER — a
      // material judgment, NOT bot.canDigBlock (which returns false merely because
      // the block is out of reach, and would wrongly reject a tree we just haven't
      // walked to yet). We only skip a candidate if the bot genuinely lacks the
      // required tool tier for that block's material.
      let b = null;
      for (const v of spots){
        const cand = bot.blockAt(v);
        if (!cand || cand.name === 'air') continue;
        if (helpers._toolTierBlocks(cand)) continue;   // truly can't harvest -> skip
        b = cand; break;
      }
      if (!b){
        // Every candidate needs a better tool than we hold. For STONE, the classic
        // fix is to dig DOWN through a soil layer to expose stone. For wood/dirt/
        // anything hand-harvestable this branch never runs (they never fail the
        // tier check), so a bot will NOT mine dirt looking for logs.
        toolBlocked++;
        if (isStoneGather && digDowns < 3){
          const dugDown = await helpers._digDownToStone(matchIds);
          if (dugDown && dugDown.ok){ digDowns++; i--; continue; }  // exposed; retry find
        }
        log(`cannot dig ${name}: need a better tool than currently held`);
        break;
      }
      try {
        // equip the right tool NOW (just before digging), since we no longer equip
        // during candidate selection. For hand-harvestable blocks this is a no-op.
        const tool = helpers._bestToolFor(b);
        if (tool){ try { await bot.equip(tool, 'hand'); } catch(e){} }
        const dist = bot.entity.position.distanceTo(b.position);
        if (dist <= 3 && bot.canSeeBlock && bot.canSeeBlock(b)){
          await bot.dig(b);                    // in reach + visible: just dig it
        } else {
          await bot.pathfinder.goto(new goals.GoalNear(b.position.x,b.position.y,b.position.z,2));
          // re-equip after moving (equipment can change target block context)
          const t2 = helpers._bestToolFor(bot.blockAt(b.position) || b);
          if (t2){ try { await bot.equip(t2, 'hand'); } catch(e){} }
          const b2 = bot.blockAt(b.position) || b;
          if (!bot.canDigBlock(b2)){ toolBlocked++; continue; }  // truly can't; next
          await bot.dig(b2);
        }
        dug++;
        // DROP PICKUP: breaking a block leaves the item on the ground where the
        // block was. It does NOT auto-teleport to the bot — we must move onto it.
        // Since we dug from up to ~2 blocks away, walk to the block's position so
        // the item enters the pickup radius, then wait for it to register. This is
        // the fix for the pervasive "dug but drops not collected" failure.
        try {
          const dropPos = b.position;
          await bot.pathfinder.goto(new goals.GoalNear(dropPos.x, dropPos.y, dropPos.z, 1));
        } catch(_){ /* if we can't path exactly onto it, the settle below still tries */ }
        await helpers.waitTicks(8);   // let the drop actually enter inventory
        // If still not collected, nudge in place — a tiny step often triggers pickup
        if (helpers.invCount(dropName) - startCount < i + 1){
          bot.setControlState('forward', true);
          await helpers.waitTicks(3);
          bot.setControlState('forward', false);
          await helpers.waitTicks(4);
        }
      } catch(e){
        // "goal was changed" / "goal changed before it could be completed" is a
        // TRANSIENT pathfinder interruption (another goto took over, or a prior
        // skill's movement was still settling). Don't abort the whole gather —
        // skip this target and try the next block. Only give up after several.
        const msg = String(e.message || e);
        if (/goal was changed|goal changed|GoalChanged/i.test(msg)){
          softFails++;
          log('collect: pathfinder interrupted, retrying next block ('+softFails+')');
          await helpers.waitTicks(4);
          if (softFails >= 4) break;
          i--;                        // this target didn't count; try again
          continue;
        }
        // "No path to the goal" / "Took to long" = the planner couldn't route to
        // THIS block. Don't abort the whole gather — skip it, shrink range, and let
        // findBlocks surface a DIFFERENT, likely-closer candidate next loop.
        if (/too long|to long|timeout|Timeout|no path|No path/i.test(msg)){
          softFails++;
          log('collect: could not reach a block, trying a different one ('+softFails+')');
          try { bot.pathfinder.setGoal(null); } catch(_){}
          if (maxDistance > 8) maxDistance = Math.max(8, Math.floor(maxDistance/2));
          await helpers.waitTicks(2);
          if (softFails >= 4) break;
          continue;                   // count this iteration; move on to next find
        }
        log('collect step failed: '+msg); break;
      }
    }
    await helpers.waitTicks(4);       // final settle before measuring
    // LEAVE NO TRAP: if mining left us standing in a shallow hole, hop/step out
    // now so the after-snapshot doesn't read as "trapped" for a successful task.
    try {
      const m = computeMobility();
      if (m && (m.recoverableByJump || m.surroundedAtFeet >= 3) && !m.likelyStuckInHole){
        bot.setControlState('jump', true);
        bot.setControlState('forward', true);
        await helpers.waitTicks(6);
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
      } else if (m && m.likelyStuckInHole){
        await helpers.getUnstuck();
      }
    } catch(e){ /* non-fatal cleanup */ }
    const gained = helpers.invCount(dropName) - startCount;
    // env_failure = the WORLD didn't cooperate: nothing mineable-with-current-tool
    // in range, no target found, or transient path interruption. NOT set for
    // gained>0 (success) nor "dug but drops not collected" (may be a code issue).
    const env = gained <= 0 && dug === 0 && (noneFound || softFails > 0 || toolBlocked > 0);
    // A TRUE tool problem means: we actually stood next to (or found reachable)
    // stone and were rejected purely on tool TIER — NOT that everything was out of
    // reach or nonexistent. If we couldn't path to anything (softFails) or found
    // nothing in range (noneFound), that is a RELOCATION problem, not a tool one.
    // Reporting tool_blocked in those cases makes acquireStone emit "craft a
    // pickaxe", which makes the critic invent bogus durability/equip lessons and
    // sends the next code generation to re-craft tools instead of moving. Gate it
    // hard: only a genuine, reachable tier failure counts.
    const trueToolBlock = toolBlocked > 0 && dug === 0
                          && softFails === 0 && !noneFound;
    return {
      ok: gained > 0,
      env_failure: env || undefined,
      tool_blocked: trueToolBlock || undefined,   // needs better tool (reachable-only)
      collected: gained,             // VERIFIED inventory gain (use this number)
      item: dropName,
      dug,                            // blocks broken (may differ from collected)
      have: helpers.invCount(dropName),
      reason: gained>0 ? undefined
        : (dug>0 ? 'dug but drops not collected'
        : (trueToolBlock ? `no ${name} reachable that a ${helpers._heldToolTier()||'bare hand'} can mine; get a better tool`
        : (softFails>0 ? 'could not path to any reachable block; relocate to fresh/exposed terrain and retry'
        : (toolBlocked>0 ? `only tool-blocked candidates found and none reachable; relocate to exposed ${name} and retry`
        : (noneFound ? 'none found in range; travel to fresh terrain'
        : 'pathfinder kept getting interrupted; try again'))))),
    };
  },

  // report the tier of pickaxe currently held (for clearer failure messages)
  _heldToolTier(){
    for (const t of ['netherite','diamond','iron','stone','golden','wooden']){
      if (helpers.hasItem(t + '_pickaxe')) return t + ' pickaxe';
    }
    return null;
  },

  // ---- digStaircaseDown: the human "just dig down to the rock" primitive -----
  // Stone on a plains/forest sits a few blocks under the dirt. A human who sees
  // no exposed rock simply digs DOWN until they hit it. This does exactly that,
  // honestly and to completion (no arbitrary 1-block cap): it digs a descending
  // STAIRCASE (step forward + down each iteration so the bot can always walk back
  // up) until it reaches stone, hits maxDepth, or hits a genuine hazard.
  //
  // SAFETY (kept — these prevent real deaths, not exploration):
  //   - stops immediately if the block to dig, or the one below it, is lava/water
  //   - stops if an open drop of >2 opens up beneath (a cavern) — reports it so
  //     the caller/LLM can decide, rather than plunging in
  // Returns {ok, hitStone, depth, reason, stoppedFor}. When hitStone is true the
  // bot is standing ON or NEXT TO exposed stone and the caller should just call
  // collectBlock('stone', n, small-radius) — the stone is right here now.
  async digStaircaseDown(maxDepth=8){
    const stoneNames = ['stone','andesite','diorite','granite','tuff','deepslate','cobbled_deepslate'];
    const hazard = (b) => b && (b.name.includes('lava') || b.name.includes('water'));
    const isStone = (b) => b && stoneNames.some(s => b.name === s);
    let depth = 0;
    // If stone is already exposed within a couple blocks, we're done before digging.
    const near = bot.findBlocks({
      matching: (b) => isStone(b),
      maxDistance: 3, count: 1,
    }) || [];
    if (near.length) return { ok:true, hitStone:true, depth:0, reason:'stone already exposed adjacent' };

    for (let i = 0; i < maxDepth; i++){
      const feet = bot.entity.position.floored();
      // Choose a diagonal step cell so we carve stairs, not a vertical shaft.
      const dirsPref = [[1,0],[0,1],[-1,0],[0,-1]];
      let stepped = false;
      for (const [dx,dz] of dirsPref){
        const forward = feet.offset(dx, 0, dz);
        const below   = feet.offset(dx, -1, dz);
        const fBlock = bot.blockAt(forward);
        const bBlock = bot.blockAt(below);
        const belowBelow = bot.blockAt(below.offset(0,-1,0));
        // hazard checks before we commit to digging this cell
        if (hazard(fBlock) || hazard(bBlock) || hazard(belowBelow)){
          return { ok:false, hitStone:false, depth, reason:'lava/water ahead',
                   stoppedFor:'hazard' };
        }
        // if the forward-down cell is already stone, we've reached the layer:
        // dig the forward block (to make room) and report success.
        if (isStone(bBlock)){
          try {
            const t = helpers._bestToolFor(fBlock);
            if (t){ try{ await bot.equip(t,'hand'); }catch(e){} }
            if (fBlock && fBlock.boundingBox === 'block' && bot.canDigBlock(fBlock)) await bot.dig(fBlock);
          } catch(e){}
          return { ok:true, hitStone:true, depth, reason:'reached stone layer' };
        }
        // otherwise dig the forward block and the one below it, then step down
        if (fBlock && fBlock.name !== 'air' && fBlock.boundingBox === 'block'){
          if (!bot.canDigBlock(fBlock)) continue;   // can't dig here, try another dir
          const t = helpers._bestToolFor(fBlock);
          if (t){ try{ await bot.equip(t,'hand'); }catch(e){} }
          try { await bot.dig(fBlock); } catch(e){ continue; }
        }
        if (bBlock && bBlock.name !== 'air' && bBlock.boundingBox === 'block'){
          const t = helpers._bestToolFor(bBlock);
          if (t){ try{ await bot.equip(t,'hand'); }catch(e){} }
          try { await bot.dig(bBlock); } catch(e){}
        }
        // walk into the newly cleared step
        try { await bot.pathfinder.goto(new goals.GoalNear(forward.x, below.y, forward.z, 0)); }
        catch(e){
          // if pathing fails, nudge manually
          bot.setControlState('forward', true); await helpers.waitTicks(6);
          bot.setControlState('forward', false);
        }
        stepped = true; depth++;
        break;
      }
      if (!stepped){
        return { ok:false, hitStone:false, depth, reason:'no diggable step (all sides blocked/hazard)',
                 stoppedFor:'blocked' };
      }
      // after stepping, re-check for exposed stone adjacent (the wall we just cut)
      const adj = bot.findBlocks({ matching:(b)=>isStone(b), maxDistance: 2, count: 1 }) || [];
      if (adj.length) return { ok:true, hitStone:true, depth, reason:'exposed stone in staircase wall' };
    }
    return { ok:false, hitStone:false, depth, reason:`dug ${depth} blocks, no stone yet`,
             stoppedFor:'maxDepth' };
  },

  // ---- dig DOWN one safe step to expose stone under a soil layer -------------
  // The classic "standing on dirt/grass, stone is a couple blocks below" case.
  // Digs the block underfoot ONLY if there is solid ground a short drop below
  // (never over a cavern/void — checks for a floor within 3). Returns {ok} if it
  // exposed any of the target ids. Bounded and safe: won't plunge into the hollow.
  async _digDownToStone(matchIds){
    const feet = bot.entity.position.floored();
    // safety: refuse if there's a big drop just below (cavern) — don't dig into it
    let floor = 0;
    for (let d=1; d<=4; d++){
      const bb = bot.blockAt(feet.offset(0,-d,0));
      if (bb && bb.name !== 'air' && bb.boundingBox === 'block'){ floor = d; break; }
      floor = 99;   // still air this far down => likely a void; abort
    }
    if (floor >= 5) return { ok:false, reason:'void below; not digging down' };
    // stair-dig: step to an adjacent cell and dig down there so we keep a wall to
    // climb back out, rather than a straight vertical shaft.
    for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[0,0]]){
      const under = feet.offset(dx,-1,dz);
      const soil = bot.blockAt(under);
      if (!soil || soil.name === 'air') continue;
      if (!['dirt','grass_block','sand','gravel','podzol','coarse_dirt','mud']
            .some(s => soil.name.includes(s))) continue;
      try {
        const tool = helpers._bestToolFor(soil);
        if (tool){ try { await bot.equip(tool,'hand'); } catch(e){} }
        if (!bot.canDigBlock(soil)) continue;
        await bot.dig(soil);
        await helpers.waitTicks(4);
        // did we expose any target block adjacent to the new hole?
        const found = bot.findBlocks({ matching: matchIds, maxDistance: 4, count: 1 });
        if (found && found.length) return { ok:true, exposed:true };
      } catch(e){ /* try next cell */ }
    }
    return { ok:false, reason:'could not expose stone by digging down' };
  },

  // ---- relocate to where mineable stone is EXPOSED (option-A backstop) -------
  // When the bot is on a soil layer with no mineable stone reachable in place, the
  // humanlike move is to GO to where rock is exposed — a hillside, cliff, or shallow
  // cave mouth — rather than digging blindly. This finds the nearest stone the
  // CURRENT tool can harvest that is also adjacent to air (i.e. exposed/reachable),
  // travels near it, and returns a small report. The DECISION to call this stays
  // with the LLM; the helper just executes the travel.
  async findMineableStone(maxDistance=64){
    const ids = [];
    for (const n of ['stone','andesite','diorite','granite']){
      const b = mcData.blocksByName[n]; if (b) ids.push(b.id);
    }
    if (!ids.length) return { ok:false, reason:'no stone types in mcData' };
    const spots = bot.findBlocks({ matching: ids, maxDistance, count: 64 }) || [];
    if (!spots.length) return { ok:false, reason:'no stone within range at all' };
    const here = bot.entity.position;
    // keep only EXPOSED stone (has an air neighbor) that we can actually dig
    const exposed = [];
    for (const v of spots){
      const b = bot.blockAt(v); if (!b) continue;
      const nbrs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
      const open = nbrs.some(([dx,dy,dz]) => {
        const n = bot.blockAt(v.offset(dx,dy,dz)); return n && n.name === 'air';
      });
      if (open) exposed.push(v);
    }
    if (!exposed.length) return { ok:false, status:'all_buried',
      reason:'stone exists but none is exposed nearby (all buried) — dig down a staircase to reach it' };
    exposed.sort((p,q)=> here.distanceTo(p) - here.distanceTo(q));
    const target = exposed[0];
    try {
      await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 2));
      // Expose coords at TOP LEVEL (x,y,z) AND under movedTo, so skill code that
      // reads either shape works. This helper TRAVELS to the stone; after it
      // returns ok, the caller should just call collectBlock — do NOT gotoXYZ to
      // these coords again (you're already there).
      return { ok:true, status:'arrived', x:target.x, y:target.y, z:target.z,
               movedTo:{x:target.x,y:target.y,z:target.z},
               note:'now next to exposed stone — call collectBlock next (already traveled here)' };
    } catch(e){
      return { ok:false, status:'unreachable',
               reason:'found exposed stone but could not path to it: '+e.message };
    }
  },

  // ---- ONE reliable "get N cobblestone" primitive -------------------------
  // Guaranteed post-condition: returns {ok, collected, have, status}. The STATUS
  // is the decision surface for the LLM — the helper does NOT silently choose a
  // grand strategy; it does the mechanical work (find exposed rock, walk, mine,
  // pick up) and reports honestly which mechanical situation it hit so the model
  // can decide what to do next:
  //   status 'got'            -> collected >0, done
  //   status 'no_stone_here'  -> no stone in range at all (relocate / travel)
  //   status 'all_buried'     -> stone near but buried (dig a staircase down)
  //   status 'need_tool'      -> current tool can't harvest it (make a pickaxe)
  //   status 'blocked'        -> couldn't path to any candidate (move & retry)
  // It will, as pure mechanics, relocate ONCE to exposed stone if standing on
  // soil — that's not strategy, it's "walk to the rock you can see". Deeper
  // choices (dig down, craft a better pickaxe, give up) are left to the caller.
  async acquireStone(count=10, maxDistance=48){
    const startHave = helpers.invCount('cobblestone') + helpers.invCount('cobbled_deepslate');
    // first, straightforward attempt where we stand
    let r = await helpers.collectBlock('stone', count, maxDistance);
    let have = helpers.invCount('cobblestone');
    if (r.collected > 0) return { ok:true, status:'got', collected:r.collected, have };
    if (r.tool_blocked) return { ok:false, status:'need_tool', collected:0, have,
      reason:`no reachable stone a ${helpers._heldToolTier()||'bare hand'} can mine — craft/equip a pickaxe` };
    // nothing collected and not a tool problem. Before searching, make sure we're
    // not sitting in a self-dug trench/pit. The mobility check may say "recoverable
    // by jump" (so getUnstuck no-ops), yet the bot still can't path OVER the lip to
    // reachable stone — that's the "frozen at one coord for hours" case seen in the
    // field. Force an active reposition: get unstuck if flagged, then physically
    // step to nearby open ground so pathfinding restarts from a clean origin.
    const before = bot.entity.position.floored();
    const mob = helpers.mobility();
    if (mob && (mob.surroundedAtFeet >= 1 || mob.dropStraightDown >= 1 || mob.likelyStuckInHole)){
      await helpers.getUnstuck();
    }
    await helpers.stepToOpenGround(6);   // walk out of the immediate hole footprint
    // if we actually moved, retry a plain collect from the new footing first
    const after = bot.entity.position.floored();
    if (before.distanceTo(after) >= 1.5){
      r = await helpers.collectBlock('stone', count, maxDistance);
      have = helpers.invCount('cobblestone');
      if (r.collected > 0) return { ok:true, status:'got', collected:r.collected, have, repositioned:true };
    }
    // now try to WALK to exposed rock once
    const move = await helpers.findMineableStone(maxDistance);
    if (move.ok){
      r = await helpers.collectBlock('stone', count, 16);
      have = helpers.invCount('cobblestone');
      if (r.collected > 0) return { ok:true, status:'got', collected:r.collected, have };
      if (r.tool_blocked) return { ok:false, status:'need_tool', collected:0, have,
        reason:'reached stone but current tool cannot harvest it' };
      return { ok:false, status:'blocked', collected:0, have,
        reason:'reached exposed stone but could not break/collect it — try getUnstuck then retry' };
    }
    // Nearby relocation found nothing. The home area is often strip-mined and
    // cratered by this point, so widen the search substantially and try ONE far
    // relocation before giving up — this is the "walk out to fresh hills" move a
    // human makes instead of circling the picked-over base.
    const FAR = Math.max(maxDistance * 3, 96);
    log(`acquireStone: no stone within ${maxDistance}; far-sweeping to ${FAR} `
        + `(searchRadius=${bot.pathfinder.searchRadius})`);
    const far = await helpers.findMineableStone(FAR);
    if (far.ok){
      log(`acquireStone: far-sweep reached stone at ${far.x},${far.y},${far.z}`);
      r = await helpers.collectBlock('stone', count, 16);
      have = helpers.invCount('cobblestone');
      if (r.collected > 0) return { ok:true, status:'got', collected:r.collected, have, movedTo:far.movedTo };
      if (r.tool_blocked) return { ok:false, status:'need_tool', collected:0, have,
        reason:'reached far stone but current tool cannot harvest it' };
      return { ok:false, status:'blocked', collected:0, have,
        reason:'traveled to far exposed stone but could not break/collect it — try getUnstuck then retry' };
    }
    // couldn't even relocate (near OR far): no EXPOSED stone is reachable. Before
    // giving up, do the human thing — DIG DOWN to the rock. On plains/forest the
    // stone layer is only a few blocks under the dirt; a descending staircase
    // reaches it reliably. This is what makes "get the first cobblestone" work on
    // terrain with no visible rock, instead of thrashing on relocation forever.
    if (!r.tool_blocked){                    // only worth digging if our tool CAN mine stone
      log('acquireStone: no exposed stone reachable — digging a staircase down to the rock layer');
      const dug = await helpers.digStaircaseDown(8);
      if (dug.hitStone){
        r = await helpers.collectBlock('stone', count, 6);
        have = helpers.invCount('cobblestone');
        if (r.collected > 0) return { ok:true, status:'got', collected:r.collected, have, viaDigDown:true };
        if (r.tool_blocked) return { ok:false, status:'need_tool', collected:0, have,
          reason:'dug down to stone but current tool cannot harvest it' };
      } else {
        log(`acquireStone: dig-down stopped (${dug.stoppedFor||'?'}: ${dug.reason})`);
      }
    }
    // couldn't relocate AND couldn't dig down to stone: report the honest reason
    const status = far.status === 'all_buried' ? 'all_buried'
                 : (far.status === 'unreachable' ? 'blocked' : 'no_stone_here');
    log(`acquireStone: FAILED status=${status} reason="${far.reason || 'n/a'}"`);
    return { ok:false, status, collected:0, have,
      reason: (far.reason || move.reason || 'no mineable stone reachable from here') +
              ` (searched up to ${FAR} blocks and dig-down found no stone — likely need to travel to fresh terrain)` };
  },

  // ---- dig: convenience the model often reaches for. Accepts a Block object,
  //      a Vec3/position, or a block-name string. Delegates to safe collect. ----
  async dig(target){
    try {
      if (typeof target === 'string'){
        return await helpers.collectBlock(target, 1);
      }
      // a position-like {x,y,z}
      if (target && target.x !== undefined && !target.position){
        const b = bot.blockAt(new Vec3(Math.floor(target.x),Math.floor(target.y),Math.floor(target.z)));
        if (!b || b.name==='air') return { ok:false, reason:'no block there' };
        await bot.pathfinder.goto(new goals.GoalNear(b.position.x,b.position.y,b.position.z,2));
        const tool = helpers._bestToolFor(b);
        if (tool){ try{ await bot.equip(tool,'hand'); }catch(e){} }
        if (!bot.canDigBlock(b)) return { ok:false, reason:'cannot dig; missing tool' };
        await bot.dig(b); await helpers.waitTicks(4);
        return { ok:true };
      }
      // an actual Block object
      if (target && target.position){
        await bot.pathfinder.goto(new goals.GoalNear(target.position.x,target.position.y,target.position.z,2));
        const tool = helpers._bestToolFor(target);
        if (tool){ try{ await bot.equip(tool,'hand'); }catch(e){} }
        if (!bot.canDigBlock(target)) return { ok:false, reason:'cannot dig; missing tool' };
        await bot.dig(target); await helpers.waitTicks(4);
        return { ok:true };
      }
      return { ok:false, reason:'dig needs a block name, position, or Block' };
    } catch(e){ return { ok:false, reason:e.message }; }
  },

  // pick a held tool that can harvest the block (pickaxe/axe/shovel by material)
  _bestToolFor(block){
    if (!block || !block.harvestTools) {
      // no specific tool required; any is fine
      return null;
    }
    const items = bot.inventory.items();
    // harvestTools is a map of {itemId: true}; pick one we hold
    for (const it of items){
      if (block.harvestTools[it.type]) return it;
    }
    return null;
  },

  // Would this block yield NOTHING because we lack the required tool tier? True
  // ONLY when the block explicitly requires a harvest tool (harvestTools set) and
  // we hold none of them. Blocks with no harvestTools (logs, dirt, sand, leaves)
  // are hand-harvestable and ALWAYS return false — so wood gathering can never be
  // mistaken for "need a better tool" and never triggers the stone dig-down path.
  _toolTierBlocks(block){
    if (!block || !block.harvestTools) return false;   // hand-harvestable
    const ids = Object.keys(block.harvestTools);
    if (!ids.length) return false;
    for (const it of bot.inventory.items()){
      if (block.harvestTools[it.type]) return false;    // we hold a valid tool
    }
    return true;                                         // requires a tool we lack
  },

  // ---- FRESH inventory (bot.inventory can read stale mid-action) ----
  invCount(name){
    let n = 0;
    for (const it of bot.inventory.items()) if (it.name === name) n += it.count;
    return n;
  },
  hasItem(name){ return helpers.invCount(name) > 0; },

  // ---- drop/toss items (correct mineflayer API is bot.toss, not bot.drop) ----
  // Drops `count` of `name` (or all if count omitted). Useful for sharing items
  // with other bots or clearing space — NOT for gaming success criteria.
  async drop(name, count){
    const item = bot.inventory.items().find(i => i.name === name);
    if (!item) return { ok:false, reason:`no ${name} to drop` };
    const n = (count === undefined) ? item.count : Math.min(count, helpers.invCount(name));
    try { await bot.toss(item.type, null, n); return { ok:true, dropped:n, item:name }; }
    catch(e){ return { ok:false, reason:e.message }; }
  },

  // ---- generic wood handling: bots shouldn't guess species (birch vs oak) ----
  // Returns the name of a log/planks variant the bot actually HAS, or can find.
  anyLogInInventory(){
    for (const it of bot.inventory.items()) if (it.name.endsWith('_log')) return it.name;
    return null;
  },
  anyPlanksInInventory(){
    for (const it of bot.inventory.items()) if (it.name.endsWith('_planks')) return it.name;
    return null;
  },
  // find the nearest log block of ANY species; returns its block name or null
  anyLogNearby(maxDistance=48){
    const logIds = Object.values(mcData.blocksByName)
      .filter(b => b.name.endsWith('_log')).map(b => b.id);
    const spot = bot.findBlocks({ matching: logIds, maxDistance, count: 1 });
    if (spot && spot.length){ const b = bot.blockAt(spot[0]); return b ? b.name : null; }
    return null;
  },
  // gather any wood: find whatever log species is closest and collect it.
  // If none are within maxDistance, TRAVEL outward to find some (the #1 late-game
  // failure was bots chopping spawn bare then spamming "no logs nearby" forever
  // with no way to relocate). exploreFor walks the bot toward fresh terrain.
  async collectAnyLog(count=1, maxDistance=64){
    let name = helpers.anyLogNearby(maxDistance);
    if (!name){
      // travel to find trees, then re-check
      const found = await helpers.exploreFor('_log', { maxHops: 6, hopDist: 40 });
      if (!found.ok) return { ok:false, collected:0, env_failure:true,
        reason:'no logs found even after exploring — may be in a treeless biome' };
      name = helpers.anyLogNearby(maxDistance);
      if (!name) return { ok:false, collected:0, env_failure:true,
        reason:'explored to trees but lost them before harvest' };
    }
    return await helpers.collectBlock(name, count, maxDistance);
  },

  // HOW to travel until a resource is in range. LLM/skills say WHAT to look for;
  // this walks the bot outward in hops, scanning after each, until the target
  // block type (matched by name substring, e.g. '_log', 'stone') is within
  // scanRange, or maxHops is exhausted. Never digs — pure surface exploration.
  async exploreFor(nameSubstr, opts){
    opts = opts || {};
    const maxHops = opts.maxHops || 6;
    const hopDist = opts.hopDist || 40;
    const scanRange = opts.scanRange || 48;
    const ids = Object.values(mcData.blocksByName)
      .filter(b => b.name.includes(nameSubstr)).map(b => b.id);
    if (!ids.length) return { ok:false, reason:`no block type matches '${nameSubstr}'` };
    const seen = () => {
      const s = bot.findBlocks({ matching: ids, maxDistance: scanRange, count: 1 });
      return s && s.length ? s[0] : null;
    };
    if (seen()) return { ok:true, hops:0, note:'already in range' };
    // Walk outward in a roughly-straight direction, re-scanning each hop. Bias
    // toward a random surface heading so different bots spread out instead of all
    // marching the same way and stripping one corridor.
    const ang = Math.random() * Math.PI * 2;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    for (let hop=1; hop<=maxHops; hop++){
      const p = bot.entity.position;
      const tx = Math.floor(p.x + dx*hopDist);
      const tz = Math.floor(p.z + dz*hopDist);
      try {
        // Use the same GoalNear every other helper uses (proven in this
        // pathfinder version). Target current Y with a generous range so we
        // don't force an exact-block path (the cause of past "no path" stalls).
        await bot.pathfinder.goto(new goals.GoalNear(tx, Math.floor(p.y), tz, 8));
      } catch(e){
        // blocked that way — turn and try the next hop from wherever we landed
      }
      const hit = seen();
      if (hit) return { ok:true, hops:hop, at:hit };
    }
    return { ok:false, hops:maxHops, reason:`no ${nameSubstr} found within ${maxHops} hops` };
  },

  // ---- reliable equip: returns false instead of throwing on missing item ----
  async equipItem(name){
    const item = bot.inventory.items().find(i => i.name === name);
    if (!item) return false;
    try { await bot.equip(item, 'hand'); return true; }
    catch (e) { log('equip failed: ' + e.message); return false; }
  },

  // ---- reliable placement: handles the blockUpdate-timeout quirk ----
  // Places `name` against a solid neighbor of (x,y,z). Verifies by re-reading the
  // world instead of trusting the event, so it never hangs the full 5s on failure.
  // ---- groundY: absolute ground height at a column, so the LLM stops guessing --
  // THE build bug (95 dead attempts at one spot): the LLM picked a floor Y that was
  // INSIDE the terrain (tried to place a floor at Y=67 where the ground surface IS
  // Y=67), so every place collided with existing dirt and "didn't stick". The
  // spatialMap already carries surfaceHeights, but as a grid indexed by offset from
  // the bot's MOVING position — using it means relative array math the model got
  // wrong every time. This gives the answer directly, in ABSOLUTE world coords, for
  // ANY column: scan down from high to low and return the top solid block's Y plus
  // the Y a floor should sit at (ground+1). No relative math, no guessing.
  //   helpers.groundY(x, z) -> { x, z, groundY, floorY, found }
  //   floorY is where a floor/first course goes; groundY is the surface it rests on.
  groundY(x, z){
    const gx = Math.floor(x), gz = Math.floor(z);
    // Scan a generous vertical band around the bot so hills/pits near the build
    // site resolve correctly, not just the bot's own level.
    const topY = Math.floor(bot.entity.position.y) + 8;
    const botY = Math.floor(bot.entity.position.y) - 12;
    for (let y = topY; y >= botY; y--){
      const b = bot.blockAt(new Vec3(gx, y, gz));
      if (b && b.name !== 'air' && b.name !== 'water' && b.boundingBox === 'block'){
        return { x:gx, z:gz, groundY:y, floorY:y+1, found:true };
      }
    }
    return { x:gx, z:gz, groundY:null, floorY:null, found:false,
             reason:'no solid ground found in the scanned band at this column' };
  },

  // Canonicalize an LLM-supplied block/item name to a REAL mcData name. The model
  // routinely writes singular 'oak_plank' for 'oak_planks', or aliases like
  // 'wooden_planks'/'cobble'. placeAt/buildBlocks/verifyCells all match names EXACTLY
  // (against inventory and world blocks), so an un-normalized 'oak_plank' made
  // buildBlocks report no_material DESPITE 50 oak_planks AND made verifyCells never
  // match the placed block — a persistent design stuck at 0/N forever. This maps the
  // common mistakes to the real name WITHOUT changing block identity (no species swap,
  // which would desync build vs. verify). Unknown names pass through normalized so the
  // caller can still report a clean 'no <name>' error. craftItem has its own richer
  // (inventory-aware) normalization; this is the lightweight shared version for the
  // place/build/verify path.
  canonicalItemName(name){
    if (typeof name !== 'string') return name;
    let n = name.trim().toLowerCase().replace(/\s+/g,'_');
    const FIX = {
      plank:'oak_planks', planks:'oak_planks', wood_plank:'oak_planks',
      wood_planks:'oak_planks', wooden_planks:'oak_planks', wood:'oak_planks',
      sticks:'stick', crafting_bench:'crafting_table', workbench:'crafting_table',
      cobble:'cobblestone', cobblestones:'cobblestone',
    };
    if (FIX[n]) n = FIX[n];
    if (/_plank$/.test(n)) n = n.replace(/_plank$/, '_planks');   // oak_plank -> oak_planks
    if (mcData.blocksByName[n] || mcData.itemsByName[n]) return n;   // already real
    // Last resort: toggle a trailing 's' to reach a real name (logs->log, plank->planks).
    if (n.endsWith('s') && (mcData.blocksByName[n.slice(0,-1)] || mcData.itemsByName[n.slice(0,-1)]))
      return n.slice(0,-1);
    if (mcData.blocksByName[n+'s'] || mcData.itemsByName[n+'s']) return n+'s';
    return n;
  },

  async placeAt(x, y, z, name, opts){
    const Vec3c = Vec3;
    name = helpers.canonicalItemName(name);
    const requireFloor = !(opts && opts.allowFloating);   // default: need ground
    const target = new Vec3c(Math.floor(x), Math.floor(y), Math.floor(z));
    const existing = bot.blockAt(target);
    if (existing && existing.name === name) return true;         // already there
    // NO BUILDING WHILE SUBMERGED: bots were seen standing IN a lake swinging to
    // build a wall out into the water (drowning on non-Easy). Building INTO water is
    // fine (docks/bridges) but the bot must do it from DRY FOOTING — placing from
    // the last solid block, not from within the water column. If we're currently in
    // water, try to get back to dry ground first; if we can't, refuse this placement
    // (the watchdog will pull us out; the skill fails as env, not a code bug).
    if (bot.entity.isInWater || bot.entity.isInWaterBottom){
      try { await helpers.stepToOpenGround(4); } catch(e){}
      if (bot.entity.isInWater || bot.entity.isInWaterBottom){
        _lastPlaceFail = { x:target.x, y:target.y, z:target.z, reason:'submerged' };
        return false;   // still submerged — don't build from in the water
      }
    }
    // CRITICAL: you cannot place a block into the cell you are standing in (or the
    // cell your head occupies). The #1 reason build_temporary_shelter never placed
    // a single block: the skill computed the target from bot.entity.position, so the
    // bot was literally standing on/in every target cell. If the bot occupies the
    // target (or the cell just above it), step off before trying to place.
    const feet = bot.entity.position.floored();
    const occupies = (feet.x === target.x && feet.z === target.z &&
                      (feet.y === target.y || feet.y === target.y - 1 ||
                       feet.y + 1 === target.y));
    if (occupies){
      try { await helpers.stepToOpenGround(3); } catch(e){}
      // if we still occupy it, we can't place here this run
      const f2 = bot.entity.position.floored();
      if (f2.x === target.x && f2.z === target.z &&
          (f2.y === target.y || f2.y === target.y - 1)){
        _lastPlaceFail = { x:target.x, y:target.y, z:target.z, reason:'occupies_target' };
        return false;
      }
    }
    // GROUND CHECK: a block can be placed against ANY solid face — including a
    // side face floating in the air. That is how bots built cantilevered towers.
    // For storage/tables/furnaces/floors we want them supported: require the cell
    // BELOW to be solid. Callers wanting a wall/roof block pass {allowFloating}.
    if (requireFloor){
      const below = bot.blockAt(target.offset(0,-1,0));
      if (!(below && below.boundingBox === 'block')){
        return false;   // no floor under this cell — don't build into the air
      }
      if (existing && existing.boundingBox === 'block' && existing.name !== 'air'){
        return false;
      }
    }
    // Try to place against ANY adjacent solid face. Even a floor block can be
    // placed against a neighbor's side face (then it rests on its own floor). This
    // is far more robust than only trying the single block below, which failed
    // whenever the bot couldn't reach that exact face.
    const faces = [[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]];
    // First: does this cell even HAVE a solid neighbour to build against? In
    // Minecraft you cannot place a block against empty air — there must be an
    // adjacent solid face. If there is none, say so clearly (the LLM was picking
    // mid-air coordinates and getting a silent false, so it never learned to place
    // a SUPPORTING block first). This informative failure lets it self-correct.
    let hasNeighbour = false;
    for (const [dx,dy,dz] of faces){
      const ref = bot.blockAt(target.offset(dx,dy,dz));
      if (ref && ref.boundingBox === 'block' && ref.name !== 'air'){ hasNeighbour = true; break; }
    }
    if (!hasNeighbour){
      log(`[place] CANNOT place ${name} at ${target.x},${target.y},${target.z}: no solid `
        + `block adjacent to build against (it would float in mid-air). Place a `
        + `supporting block below or beside it FIRST, then build up/out from there.`);
      _lastPlaceFail = { x:target.x, y:target.y, z:target.z, reason:'no_support_neighbour' };
      return false;
    }
    if (!(await helpers.equipItem(name))){
      log(`[place] CANNOT place ${name}: not in inventory.`);
      _lastPlaceFail = { reason:'no_item', name };
      return false;
    }
    let triedButUnreached = false;
    for (const [dx,dy,dz] of faces){
      const ref = bot.blockAt(target.offset(dx,dy,dz));
      if (ref && ref.boundingBox === 'block' && ref.name !== 'air'){
        try {
          // stand within reach of this face if we aren't already
          if (bot.entity.position.distanceTo(target.offset(0.5,0.5,0.5)) > 4){
            try { await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 2)); } catch(_){ triedButUnreached = true; }
          }
          // FACE the reference block. mineflayer aims a placement ray from the
          // bot's look vector; if we aren't looking at the face, placeBlock fires
          // but the server rejects it and no blockUpdate returns — the exact
          // "had a neighbour but didn't stick" failure seen on the wall build.
          try { await bot.lookAt(ref.position.offset(0.5,0.5,0.5), true); } catch(_){}
          await helpers.waitTicks(1);
          // re-equip each attempt: a prior face may have consumed/!swapped the held
          // stack (auto-eat, tool switch), leaving nothing in hand to place.
          if (!(await helpers.equipItem(name))) break;
          // Cap each placeBlock. Under GPU/concurrency load the blockUpdate can lag,
          // so give it 3s (was 1.5s) before abandoning THIS face — still bounded.
          await Promise.race([
            bot.placeBlock(ref, new Vec3c(-dx,-dy,-dz)),
            new Promise((_, rej) => setTimeout(() => rej(new Error('place timeout')), 3000)),
          ]);
        } catch (e) { /* verify by world re-read regardless */ }
        // POLL for the block instead of a single re-read. The place may land a few
        // ticks after the call returns (server lag); one 150ms peek was declaring
        // failure prematurely and moving off a face that actually worked. Poll up
        // to ~1s; the moment the target cell shows our block, we're done.
        let stuck = false;
        for (let p=0; p<7; p++){
          await helpers.waitTicks(3);
          const now = bot.blockAt(target);
          if (now && now.name === name){ stuck = true; break; }
        }
        if (stuck) return true;               // confirmed placed
      }
    }
    log(`[place] FAILED to place ${name} at ${target.x},${target.y},${target.z}: had a `
      + `neighbour but placement didn't stick`
      + (triedButUnreached ? ' (could not path within reach of the spot).' : '.'));
    _lastPlaceFail = { x:target.x, y:target.y, z:target.z, reason:'place_did_not_stick' };
    return false;
  },

  // ---- build: place a run of blocks along a line (walls, floors) ----
  // start={x,y,z}, dir one of 'x','z'; length blocks of `name`. Bounded time:
  // walks near each cell and places it. Returns how many were placed.
  async buildLine(start, dir, length, name){
    if (!helpers.hasItem(name)) return { ok:false, placed:0, reason:`no ${name}` };
    let placed = 0;        // NEW blocks placed this run
    let already = 0;       // cells that already held the target block
    for (let i=0; i<length; i++){
      const x = Math.floor(start.x) + (dir==='x'? i:0);
      const z = Math.floor(start.z) + (dir==='z'? i:0);
      const y = Math.floor(start.y);
      // Skip cells that are ALREADY the target block — re-running a build over a
      // finished wall must not thrash. This was the build-loop cause: the skill
      // rebuilt from the bot's position each cycle, hit existing blocks, placed 0
      // NEW ones, and the critic (correctly) saw no change → endless retry.
      const cur = bot.blockAt(new Vec3(x, y, z));
      if (cur && cur.name === name){ already++; continue; }
      try { await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2)); } catch(e){}
      if (!helpers.hasItem(name)) break;
      if (await helpers.placeAt(x, y, z, name, {allowFloating:true})) placed++;
    }
    // Success if we placed something NEW, OR the whole segment already exists (the
    // wall is complete — that's "done", report it so the skill isn't retried).
    const complete = (already + placed) >= length;
    return { ok: placed>0 || complete, placed, already, of: length,
             status: placed>0 ? 'built' : (complete ? 'already_complete' : 'partial'),
             env_failure: (placed===0 && !complete) };
  },

  // ---- build: place an ARBITRARY set of blocks (ANY shape the LLM designs) ----
  // cells = [{x,y,z}, ...] — the FORM is the caller's decision, not this helper's.
  // A box, an L, a wall with a door gap, a pitched roof, a hexagon — whatever the
  // LLM reasons its structure should look like. This helper owns ONLY the physics
  // and pathing (category B): it orders cells bottom-up so nothing is asked to
  // float before its support exists, walks to each, calls the physics-filtered
  // placeAt, and reports back per-cell WHAT stuck and WHY the rest didn't — so the
  // LLM can adjust its DESIGN. It encodes no shape of its own. `buildLine` is now
  // just the trivial case the LLM can express itself as a straight run of cells.
  //
  // Returns {ok, placed, already, failed, of, failures:[{x,y,z,reason}], status}.
  // reason is one of placeAt's structured causes (no_support_neighbour, no_item,
  // place_did_not_stick, submerged, occupies_target) so the model self-corrects.
  async buildBlocks(cells, name){
    name = helpers.canonicalItemName(name);   // 'oak_plank' -> 'oak_planks', etc.
    if (!Array.isArray(cells) || cells.length === 0)
      return { ok:false, placed:0, already:0, failed:0, of:0, failures:[],
               status:'no_cells', reason:'cells must be a non-empty array of {x,y,z}' };
    if (!helpers.hasItem(name))
      return { ok:false, placed:0, already:0, failed:cells.length, of:cells.length,
               failures:[], status:'no_material', reason:`no ${name} in inventory` };
    // Normalise + de-dupe, then sort ascending by Y. Building the lowest course
    // first means each higher block has its support in place by the time we reach
    // it — the "blocks can't float" physics rule, handled mechanically so the LLM
    // doesn't have to think about placement ORDER (only the shape it wants).
    const seen = new Set();
    const norm = [];
    for (const c of cells){
      if (!c || c.x==null || c.z==null) continue;
      let x=Math.floor(c.x), z=Math.floor(c.z), y;
      if (c.y == null){
        // No Y given: this cell is a FLOOR/footprint cell — resolve it to the real
        // ground surface at this column so the LLM never has to compute heights (the
        // exact thing it got wrong 95x). Places on top of the ground, not into it.
        const g = helpers.groundY(x, z);
        if (!g.found) continue;                 // no ground here (void/edge) — skip
        y = g.floorY;
      } else {
        y = Math.floor(c.y);
      }
      const k = `${x},${y},${z}`;
      if (seen.has(k)) continue;
      seen.add(k); norm.push({x,y,z});
    }
    norm.sort((a,b) => a.y - b.y);
    let placed=0, already=0;
    const failures=[];
    for (const {x,y,z} of norm){
      if (!helpers.hasItem(name)){                     // ran out mid-build
        failures.push({ x, y, z, reason:'no_item' });
        continue;
      }
      const cur = bot.blockAt(new Vec3(x, y, z));
      if (cur && cur.name === name){ already++; continue; }   // already correct
      _lastPlaceFail = null;
      const ok = await helpers.placeAt(x, y, z, name, {allowFloating:true});
      if (ok){ placed++; }
      else {
        const why = (_lastPlaceFail && _lastPlaceFail.reason) || 'place_did_not_stick';
        failures.push({ x, y, z, reason: why });
      }
    }
    const failed = failures.length;
    // ok if we made ANY real change OR the whole design already exists in world.
    const complete = (placed + already) >= norm.length;
    return {
      ok: placed>0 || (complete && failed===0),
      placed, already, failed, of: norm.length,
      failures: failures.slice(0, 12),        // cap so the log/context isn't flooded
      status: placed>0 ? 'built'
            : (complete ? 'already_complete'
            : (failed>0 ? 'blocked' : 'no_progress')),
    };
  },

  // ---- verifyCells: which of a DESIGN's cells actually exist in the world? ----
  // Grounded check used by the orchestrator to track a persistent structure design
  // across cycles (see structures.py designs). It reads the world only (no placing,
  // no pathing) so it is fast and safe to call every build cycle. A cell counts as
  // PRESENT if it holds the target block (or, when name is omitted, any solid
  // non-air block — useful for "is this footprint filled at all"). Returns the
  // still-MISSING cells so the coder can be handed exactly what is left to build.
  verifyCells(cells, name){
    // Same canonicalization as buildBlocks/placeAt so a design authored with a bad
    // name ('oak_plank') is verified against the REAL block that gets placed
    // ('oak_planks') — otherwise present stays 0 and the design never completes.
    if (name) name = helpers.canonicalItemName(name);
    if (!Array.isArray(cells) || cells.length === 0)
      return { ok:false, total:0, present:0, missing:[], reason:'no cells' };
    const missing = [];
    let present = 0;
    for (const c of cells){
      if (!c || c.x==null || c.y==null || c.z==null) continue;
      const x = Math.floor(c.x), y = Math.floor(c.y), z = Math.floor(c.z);
      const b = bot.blockAt(new Vec3(x, y, z));
      let ok;
      if (name) ok = !!(b && b.name === name);
      else ok = !!(b && b.name !== 'air' && b.boundingBox === 'block');
      if (ok) present++;
      else missing.push({ x, y, z });
    }
    const total = present + missing.length;
    return {
      ok: true, total, present, missingCount: missing.length,
      missing: missing.slice(0, 200),    // cap so the RPC payload stays small
      complete: missing.length === 0 && total > 0,
    };
  },

  // ---- is a cell a GOOD place for (shared) infrastructure? PHYSICS RULES ----
  // Not a decision — a property of a sane world. A crafting table in a tree is
  // absurd regardless of who "decided" it, so we forbid it mechanically: the spot
  // must sit on real ground (not leaves/logs/foliage), have open air at the cell
  // and headroom above, and not be a precarious perch over a drop.
  _isGoodBuildCell(cell){
    const below = bot.blockAt(cell.offset(0,-1,0));
    const at = bot.blockAt(cell);
    const above = bot.blockAt(cell.offset(0,1,0));
    if (!below || !at || !above) return false;
    if (at.name !== 'air') return false;                    // cell must be empty
    if (above.name !== 'air') return false;                 // need headroom
    if (below.boundingBox !== 'block') return false;        // need solid footing
    // reject foliage/unstable ground: no building in/on trees or on gravel/sand
    const badGround = ['leaves','log','wood','sapling','vine','mushroom_block',
                       'sand','gravel','snow'];
    if (badGround.some(s => below.name.includes(s))) return false;
    // reject LIQUID sites: a workshop/build sited in or beside water is the root of
    // the drowning cascade (bots working there keep stepping into water; each
    // drowning kills the running skill). The cell itself, the block it stands on,
    // and the block below must not be liquid; and no more than one of the 4 direct
    // neighbours (at foot height) may be liquid, so builds land on genuinely dry
    // ground rather than a shoreline that floods the work area.
    const isLiquid = (b) => b && (b.name === 'water' || b.name === 'lava');
    if (isLiquid(at) || isLiquid(below)) return false;
    let liquidNeighbours = 0;
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]){
      if (isLiquid(bot.blockAt(cell.offset(dx, 0, dz)))
          || isLiquid(bot.blockAt(cell.offset(dx, -1, dz)))) liquidNeighbours++;
    }
    if (liquidNeighbours >= 2) return false;
    return true;
  },

  // ---- place a block in a GOOD spot next to the bot (physics-filtered) ----
  async placeNearby(name){
    if (!helpers.hasItem(name)) return false;
    // Build a candidate ring: the 8 cells around the bot at foot level AND one
    // level down (for standing on a lip/edge), nearest-first. The old version only
    // tried the 4 orthogonal foot-level cells, which all fail when the bot is boxed
    // in — e.g. FOUR bots crowding the same spawn area, each other's bodies and
    // dropped blocks filling the adjacent cells. That silent false is what makes a
    // held crafting_table never get placed, so the 3x3 craft window never opens.
    const build = () => {
      const feet = bot.entity.position.floored();
      const offs = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],
                    [1,0,1],[1,0,-1],[-1,0,1],[-1,0,-1],
                    [1,-1,0],[-1,-1,0],[0,-1,1],[0,-1,-1],
                    [2,0,0],[-2,0,0],[0,0,2],[0,0,-2]];
      return offs.map(([dx,dy,dz]) => feet.offset(dx,dy,dz));
    };
    let cells = build();
    // prefer physics-good cells; then any air cell with solid floor
    for (const cell of cells.filter(c => helpers._isGoodBuildCell(c))){
      if (await helpers.placeAt(cell.x, cell.y, cell.z, name)) return true;
    }
    for (const cell of cells){
      const below = bot.blockAt(cell.offset(0,-1,0));
      const at = bot.blockAt(cell);
      if (below && below.boundingBox === 'block' && at && at.name === 'air'){
        if (await helpers.placeAt(cell.x, cell.y, cell.z, name)) return true;
      }
    }
    // STILL boxed in: step to open ground to get a fresh, uncrowded footprint, then
    // retry the ring once. This rescues the "four bots in one spot" deadlock.
    try {
      const step = await helpers.stepToOpenGround(6);
      if (step && step.ok){
        cells = build();
        for (const cell of cells.filter(c => helpers._isGoodBuildCell(c))){
          if (await helpers.placeAt(cell.x, cell.y, cell.z, name)) return true;
        }
        for (const cell of cells){
          const below = bot.blockAt(cell.offset(0,-1,0));
          const at = bot.blockAt(cell);
          if (below && below.boundingBox === 'block' && at && at.name === 'air'){
            if (await helpers.placeAt(cell.x, cell.y, cell.z, name)) return true;
          }
        }
      }
    } catch(_){ /* best effort */ }
    return false;
  },

  // ---- WORKSHOP: place shared infrastructure at the community build site ----
  // If a workshop exists, walk there and place adjacent to it so it grows as one
  // cluster. If none exists, this returns {ok:false, noWorkshop:true} so the skill
  // can fall back / signal the need — the decider, not this helper, sites it.
  async placeAtWorkshop(name, workshop){
    if (!helpers.hasItem(name)) return { ok:false, reason:`no ${name}` };
    if (!workshop || workshop.x === undefined)
      return { ok:false, noWorkshop:true, reason:'no workshop sited yet' };
    try {
      await bot.pathfinder.goto(new goals.GoalNear(workshop.x, workshop.y, workshop.z, 3));
    } catch(e){ /* get as close as we can, then try to place */ }
    // try good cells around the bot's current (now near-workshop) position
    if (await helpers.placeNearby(name)) return { ok:true, at:'workshop' };
    return { ok:false, reason:'could not place at workshop (no good adjacent cell)' };
  },

  // ---- step OUT of the current hole footprint onto open, standable ground ----
  // The mobility check can label a shallow trench "recoverable" (so getUnstuck
  // no-ops), yet the bot still can't path over the lip to reachable stone and
  // freezes at one coordinate. This walks it to the nearest open surface cell in
  // an expanding ring, giving pathfinding a fresh origin above ground. Returns
  // {ok, movedTo} — best-effort; safe to call even when already in the open.
  async stepToOpenGround(radius=6){
    const feet = bot.entity.position.floored();
    const isSurfaceStand = (c) => {
      const below = bot.blockAt(c.offset(0,-1,0));
      const at = bot.blockAt(c);
      const above = bot.blockAt(c.offset(0,1,0));
      const above2 = bot.blockAt(c.offset(0,2,0));
      if (!below || !at || !above) return false;
      if (below.boundingBox !== 'block') return false;   // solid footing
      if (at.name !== 'air' || above.name !== 'air') return false;  // standable
      // "open" = sky-ish: at least two blocks of air above head so we're not
      // stepping sideways into another covered pocket of the same trench.
      if (above2 && above2.name !== 'air') return false;
      const bad = ['leaves','log','sand','gravel','water','lava'];
      if (bad.some(s => below.name.includes(s))) return false;
      return true;
    };
    // search an expanding ring for the nearest good surface cell that ISN'T the
    // one we're already on, preferring higher Y (out of the pit) then nearer.
    const cands = [];
    for (let dx=-radius; dx<=radius; dx++){
      for (let dz=-radius; dz<=radius; dz++){
        if (Math.abs(dx)+Math.abs(dz) < 1) continue;
        for (let dy=0; dy<=2; dy++){          // allow stepping up out of the pit
          const c = feet.offset(dx, dy, dz);
          if (isSurfaceStand(c)) { cands.push(c); break; }
        }
      }
    }
    if (!cands.length) return { ok:false, reason:'no open ground within radius' };
    cands.sort((a,b) => (b.y - a.y) || (feet.distanceTo(a) - feet.distanceTo(b)));
    for (const c of cands.slice(0, 5)){
      try {
        await bot.pathfinder.goto(new goals.GoalNear(c.x, c.y, c.z, 0));
        const now = bot.entity.position.floored();
        if (now.distanceTo(feet) >= 1.5)
          return { ok:true, movedTo:{x:now.x,y:now.y,z:now.z} };
      } catch(e){ /* try next candidate */ }
    }
    return { ok:false, reason:'could not path to any open ground cell' };
  },

  // Report a good, physics-valid spot near the bot for founding the workshop, or
  // null if the bot isn't standing anywhere sane. The DECIDER uses this to turn
  // "here is roughly where I am" into concrete, buildable coordinates — the choice
  // of general area is the LLM's; this just ensures the chosen cell is legal.
  goodSiteHere(){
    const feet = bot.entity.position.floored();
    // consider the bot's own cell and its neighbors; return the first good one
    const candidates = [[0,0],[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dz]) => feet.offset(dx,0,dz));
    for (const c of candidates){
      if (helpers._isGoodBuildCell(c)) return { x:c.x, y:c.y, z:c.z };
    }
    return null;
  },

  // ---- pillar up N blocks: jump + place beneath, the reliable way ----
  async pillarUp(n, name='dirt'){
    // Accept any placeable block we actually hold, not just the requested one, so a
    // bot with cobblestone but no dirt still escapes.
    if (!helpers.hasItem(name)){
      const alt = ['dirt','cobblestone','stone','netherrack','deepslate','andesite','cobbled_deepslate']
        .find(helpers.hasItem);
      if (!alt) return { ok:false, reason:`no placeable block in inventory`, placed:0 };
      name = alt;
    }
    let placed = 0;
    for (let i = 0; i < n; i++){
      if (!helpers.hasItem(name)) break;
      const startY = Math.floor(bot.entity.position.y);
      // Jump and HOLD until we've actually risen ~1 block, then place beneath.
      // The old code placed after a fixed 2 ticks whether or not the bot rose,
      // so it frequently placed at current feet and jammed. Poll for real ascent.
      bot.setControlState('jump', true);
      let rose = false;
      for (let t = 0; t < 10; t++){
        await helpers.waitTicks(1);
        if (Math.floor(bot.entity.position.y) > startY){ rose = true; break; }
      }
      const p = bot.entity.position;
      const under = new Vec3(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z));
      const ok = await helpers.placeAt(under.x, under.y, under.z, name, {allowFloating:true});
      bot.setControlState('jump', false);
      await helpers.waitTicks(3);
      if (ok) placed++; else if (!rose) break;   // couldn't rise AND couldn't place -> stuck
    }
    return { ok: placed > 0, placed };
  },

  // ---- get unstuck from ANYWHERE: pit, cave, ravine, water ----
  // Tiered strategy, each tried in order until mobility improves or we surface.
  // This is the "a competent player can escape any bad spot" primitive.
  async escapeHole(){ return helpers.getUnstuck(); },   // alias, back-compat
  async getUnstuck(){
    const start = computeMobility();
    const y = bot.entity.position.y;
    // BURIED CHECK (fix): a bot can have open space at its FEET yet still be trapped
    // — standing in a hole/tunnel below the surface with a solid ceiling and no sky
    // overhead. The old gate only looked at feet/drop/likelyStuckInHole, so this
    // exact case (Garrick at Y~71, no openSky) returned "not actually stuck" forever
    // and never escaped. Treat "no open sky above AND below surface level" as stuck.
    const buriedBelowSurface = start && start.openSkyAbove === false && y < 62;
    if (!start || (start.surroundedAtFeet <= 1 && start.dropStraightDown <= 1
                   && !start.likelyStuckInHole && !buriedBelowSurface)) {
      return { ok:true, note:'not actually stuck' };
    }
    const startY = bot.entity.position.y;
    const SURFACE_Y = 62;   // rough overworld surface; above this = likely out

    // TIER 1 — let pathfinder route to open sky. This solves most caves/ravines
    // because pathfinder can climb, jump, and route around obstacles on its own.
    try {
      const near = bot.findBlocks({
        matching: (b) => b && b.name === 'air',
        maxDistance: 24, count: 200,
      }) || [];
      // prefer an air column that has sky access (air continuing upward)
      let best = null;
      for (const v of near) {
        const above = bot.blockAt(v.offset(0, 2, 0));
        if (v.y >= startY && above && above.name === 'air') {
          if (!best || v.y > best.y) best = v;
        }
      }
      if (best) {
        await bot.pathfinder.goto(new goals.GoalNear(best.x, best.y, best.z, 1));
        const m = computeMobility();
        if (m && (m.surroundedAtFeet <= 1 || bot.entity.position.y > startY + 1))
          return { ok:true, method:'pathfind-to-air' };
      }
    } catch (e) { log('unstuck tier1: ' + e.message); }

    // TIER 2 — dig a step out through a side wall (tight pit).
    try {
      const feet = bot.entity.position.floored();
      for (const [dx,,dz] of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]) {
        const wall = bot.blockAt(feet.offset(dx,0,dz));
        const above = bot.blockAt(feet.offset(dx,1,dz));
        if (wall && wall.boundingBox === 'block' && bot.canDigBlock(wall)) {
          await bot.dig(wall);
          if (above && above.boundingBox === 'block' && bot.canDigBlock(above)) await bot.dig(above);
          bot.setControlState('jump', true); bot.setControlState('forward', true);
          await helpers.waitTicks(6);
          bot.setControlState('forward', false); bot.setControlState('jump', false);
          const m = computeMobility();
          if (m && m.surroundedAtFeet <= 1) return { ok:true, method:'dig-step-out' };
        }
      }
    } catch (e) { log('unstuck tier2: ' + e.message); }

    // TIER 3 — pillar up if we have any placeable block. ONLY valid when we're
    // genuinely BURIED (a solid ceiling overhead). On the surface, pillaring just
    // builds a useless dirt tower that strands the bot in the sky — which then
    // gets "crafting tables placed on top" nonsense. If open sky is above, SKIP
    // this entirely and go to the horizontal escape below.
    try {
      const mm = computeMobility();
      const buried = mm && !mm.openSkyAbove && mm.ceilingAt > 0;
      if (buried){
        const item = ['dirt','cobblestone','stone','netherrack','deepslate','andesite']
          .find(helpers.hasItem);
        if (item) {
          const r = await helpers.pillarUp(6, item);
          const m = computeMobility();
          if (m && (m.surroundedAtFeet <= 1 || bot.entity.position.y > startY + 1))
            return { ok:true, method:'pillar', placed:r.placed };
        }
      }
    } catch (e) { log('unstuck tier3: ' + e.message); }

    // TIER 3b — SURFACE horizontal escape: we're in an open-sky trench/pit. The
    // right move is OUT, not up. Dig through the lowest side wall repeatedly and
    // walk to open ground. Never places a block; only removes walls between us
    // and daylight.
    try {
      const mm = computeMobility();
      if (mm && mm.openSkyAbove){
        for (let ring = 0; ring < 4; ring++){
          const feet = bot.entity.position.floored();
          let dugAny = false;
          for (const [dx,,dz] of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]) {
            const wall = bot.blockAt(feet.offset(dx,0,dz));
            const head = bot.blockAt(feet.offset(dx,1,dz));
            if (wall && wall.boundingBox === 'block' && bot.canDigBlock(wall)){
              try { await bot.dig(wall); dugAny = true; } catch(e){}
              if (head && head.boundingBox === 'block' && bot.canDigBlock(head)){
                try { await bot.dig(head); } catch(e){}
              }
              bot.setControlState('jump', true); bot.setControlState('forward', true);
              await helpers.waitTicks(6);
              bot.setControlState('forward', false); bot.setControlState('jump', false);
            }
          }
          const step = await helpers.stepToOpenGround(8);
          if (step.ok) return { ok:true, method:'dig-out-to-surface', movedTo:step.movedTo };
          if (!dugAny) break;   // nothing left to dig and still can't step out
        }
      }
    } catch (e) { log('unstuck tier3b: ' + e.message); }

    // TIER 4 — LAST RESORT: mine straight up toward the surface. Only when truly
    // buried with nothing to pillar. Risky (could be water/lava above) so we check
    // the block above is safe before digging it. Skip entirely if sky is already
    // open above — there's nothing to mine up TO, and on the surface this tier
    // would just flail.
    try {
      const mm = computeMobility();
      if (mm && mm.openSkyAbove) throw new Error('skip tier4: open sky above');
      let climbed = 0;
      for (let i = 0; i < 25 && bot.entity.position.y < SURFACE_Y; i++) {
        const head = bot.blockAt(bot.entity.position.offset(0, 2, 0));
        if (!head) break;
        if (head.name === 'water' || head.name === 'lava') break;   // don't dig into liquid
        if (head.name === 'air') {
          // open air above: try to rise into it, keep going toward surface
          bot.setControlState('jump', true);
          await helpers.waitTicks(4);
          bot.setControlState('jump', false);
          await helpers.waitTicks(2);
          climbed++;
          continue;
        }
        if (head.boundingBox === 'block' && bot.canDigBlock(head)) {
          await bot.dig(head);
          bot.setControlState('jump', true);
          await helpers.waitTicks(4);
          bot.setControlState('jump', false);
          await helpers.waitTicks(2);
          climbed++;
        } else break;
      }
      const m = computeMobility();
      // Escaped if we're no longer flagged as buried, or we have open sky above,
      // or we reached surface height. (Standing atop a dug shaft is fine — the bot
      // is now out of the burial and can pathfind normally.)
      const above2 = bot.blockAt(bot.entity.position.offset(0, 2, 0));
      const skyAbove = above2 && above2.name === 'air';
      if (climbed > 0 && ((m && !m.likelyStuckInHole) || skyAbove
                          || bot.entity.position.y >= SURFACE_Y))
        return { ok:true, method:'mine-up', climbed };
    } catch (e) { log('unstuck tier4: ' + e.message); }

    return { ok:false, reason:'all escape tiers failed; may be deeply trapped or in liquid',
             mobility: computeMobility() };
  },

  // ---- escapeToSurface: the ONE reliable way out of a hole/pocket ------------
  // This replaces the endlessly-regenerated escape_pocket_navigate skill. The LLM
  // versions failed ~22 times in a row because they each guessed at the algorithm
  // (bot.jump, pillar-then-wander-off, place-without-confirming-rise). This is the
  // correct algorithm, hardcoded once:
  //   1. If already at/near surface with open sky -> done.
  //   2. If a solid CEILING is above -> mine straight up through it (dig the block
  //      over the head, step up, repeat). This is what gets you out of a sealed
  //      pocket; pillaring can't, because there's no room to place above.
  //   3. If NO ceiling (open shaft above) but boxed at feet -> pillar up: jump,
  //      confirm we actually rose, place a block beneath. Repeat.
  //   4. Verify Y strictly increases each iteration; if it stalls twice, switch
  //      tactic (mine<->pillar) or call getUnstuck as a last resort.
  // Returns when openSkyAbove is true (daylight) or maxRise is exhausted.
  async escapeToSurface(targetY = null, maxRise = 80){
    const surfaceGoal = (mm) => mm && mm.openSkyAbove &&
                                (targetY == null || bot.entity.position.y >= targetY - 1);
    let mm = computeMobility();
    if (surfaceGoal(mm)) return { ok:true, method:'already-surface', y: bot.entity.position.y };

    // pick a placeable block for pillaring (any we hold)
    const placeBlock = () => ['dirt','cobblestone','stone','cobbled_deepslate',
                              'andesite','granite','diorite','netherrack']
                              .find(helpers.hasItem);

    let lastY = Math.floor(bot.entity.position.y);
    let stalls = 0;
    let startY = lastY;
    let noProgressStreak = 0;   // consecutive iterations with no net Y gain
    for (let step = 0; step < maxRise; step++){
      mm = computeMobility();
      if (surfaceGoal(mm)){
        return { ok:true, method:'reached-surface', y: bot.entity.position.y, steps: step };
      }
      const curY = Math.floor(bot.entity.position.y);
      if (curY <= lastY) { stalls++; noProgressStreak++; } else { stalls = 0; noProgressStreak = 0; lastY = curY; }

      // HARD BAILOUT: if we've churned many iterations without gaining ANY height,
      // we're not going to (bedrock above, unbreakable block, or a mine-up that
      // isn't taking). Bail cleanly instead of printing "mining up through ceiling"
      // 60+ times until the 90s skill timeout kills the whole cycle (the observed
      // Garrick/Rowan failure). Let the proposer try a different action next cycle.
      if (noProgressStreak >= 8){
        return { ok:false, method:'gave-up-no-rise', y: bot.entity.position.y,
                 rose: curY - startY,
                 reason:'mined/pillared repeatedly but could not gain height — '
                      + 'likely bedrock or unbreakable ceiling; try a different spot' };
      }

      // If sealed by a ceiling, MINE up through it.
      const ceiling = !mm.openSkyAbove;
      if (ceiling || stalls >= 2){
        // equip best pickaxe if we have one (faster through stone) — not required
        for (const p of ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe','stone_pickaxe','wooden_pickaxe'])
          if (helpers.hasItem(p)) { try { await helpers.equipItem(p); } catch(_){} break; }
        const feet = bot.entity.position.floored();
        const above = bot.blockAt(feet.offset(0, 2, 0));   // block over the head
        if (above && above.name !== 'air'){
          try {
            log('escapeToSurface: mining up through ceiling');
            await bot.dig(above);
            await helpers.waitTicks(2);
          } catch(e){ log('escapeToSurface mine-up: ' + e.message); }
        }
        // hop up into the gap and place a block under us so we hold the new height
        bot.setControlState('jump', true);
        await helpers.waitTicks(3);
        const b = placeBlock();
        if (b){
          const p = bot.entity.position.floored();
          try { await helpers.placeAt(p.x, p.y - 1, p.z, b, {allowFloating:true}); } catch(_){}
        }
        bot.setControlState('jump', false);
        await helpers.waitTicks(2);
        if (stalls >= 4){
          // truly stuck — hand off to the tiered recovery once, then keep trying
          try { await helpers.getUnstuck(); } catch(_){}
          stalls = 0;
        }
        continue;
      }

      // Open shaft above but boxed at feet -> pillar straight up.
      const b = placeBlock();
      if (!b){
        // no blocks to pillar and no ceiling to mine: try to just walk/jump out
        if (mm.recoverableByJump){
          bot.setControlState('jump', true); await helpers.waitTicks(4);
          bot.setControlState('jump', false); await helpers.waitTicks(2);
          continue;
        }
        return { ok:false, reason:'no blocks to pillar and cannot jump out', y: bot.entity.position.y };
      }
      const r = await helpers.pillarUp(3, b);   // pillarUp already confirms ascent
      await helpers.waitTicks(2);
      if (!r.ok && stalls >= 3){
        try { await helpers.getUnstuck(); } catch(_){}
        stalls = 0;
      }
    }
    mm = computeMobility();
    return { ok: !!(mm && mm.openSkyAbove), method:'exhausted',
             y: bot.entity.position.y, reason: mm && mm.openSkyAbove ? undefined : 'maxRise reached still buried' };
  },

  // ---- leave no trap: fill a pit the bot (or a past bot) dug ----
  // Fills open air below/around current spot up to standing level with a block.
  async fillHole(name){
    const item = name || ['dirt','cobblestone','stone']
      .find(helpers.hasItem);
    if (!item || !helpers.hasItem(item)) return { ok:false, reason:'no fill block' };
    const feet = bot.entity.position.floored();
    let filled = 0;
    // fill the ring of holes at foot level around us and the drop directly below,
    // so we don't leave a pit behind. We fill from outside-in so we don't trap self.
    for (const [dx,,dz] of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]) {
      const spot = feet.offset(dx, -1, dz);
      const b = bot.blockAt(spot);
      if (b && b.name === 'air' && helpers.hasItem(item)) {
        if (await helpers.placeAt(spot.x, spot.y, spot.z, item)) filled++;
      }
    }
    return { ok: filled > 0, filled };
  },

  // ==========================================================================
  // PRIMITIVE VERB CORE (Part 2). These are "how", never "what/where/whether".
  // The LLM decides the nouns and passes them in; each verb owns only the
  // mechanical execution a human wouldn't consciously think about. Added to
  // close the gaps the log analysis found: combat, farming, survival, tooling.
  // ==========================================================================

  // HOW to equip the right tool for a block. LLM says nothing — this just picks
  // the best harvesting tool the bot owns for the given block/target and equips
  // it. Stops the recurring "mining stone with a wooden pickaxe" failures.
  async equipBestToolFor(target){
    let block = target;
    if (typeof target === 'string'){
      const id = mcData.blocksByName[target] ? mcData.blocksByName[target].id : -1;
      block = bot.findBlock({ matching: id, maxDistance: 8 }) || null;
    }
    if (!block) return { ok:false, reason:'no such block near to size up' };
    const tool = helpers._bestToolFor(block);
    if (!tool) return { ok:true, tool:'hand', note:'hand is fine for this block' };
    const ok = await helpers.equipItem(tool.name);
    return { ok, tool: ok ? tool.name : null,
             reason: ok ? undefined : `could not equip ${tool.name}` };
  },

  // HOW to hit a target the LLM chose. The LLM decides WHAT to attack (via
  // nearestHostile / nearbyEntities and its own judgment) and passes the entity
  // or a name; this just closes distance and swings until it's gone or a bound
  // is hit. Never decides whether to fight.
  async attack(target, opts){
    opts = opts || {};
    let ent = target;
    if (typeof target === 'string'){
      const list = helpers.nearbyEntities(opts.maxDist || 16)
        .filter(e => (e.name === target || e.kind === target || e.type === target));
      ent = list.length ? bot.entities[list[0].id] : null;
    }
    if (!ent || !ent.isValid) return { ok:false, reason:'no valid target entity' };
    const maxSwings = opts.maxSwings || 20;
    let swings = 0;
    while (ent && ent.isValid && swings < maxSwings){
      try {
        await bot.pathfinder.goto(new goals.GoalFollow(ent, 2));
      } catch(e){ /* keep swinging if we're already close enough */ }
      if (!ent.isValid) break;
      try { await bot.lookAt(ent.position.offset(0, ent.height ? ent.height*0.9 : 1, 0)); } catch(e){}
      try { bot.attack(ent); } catch(e){}
      swings++;
      await helpers.waitTicks(10);
    }
    return { ok: !ent || !ent.isValid, swings,
             reason: (ent && ent.isValid) ? 'target survived swing budget' : undefined };
  },

  // HOW to eat when hungry — a survival reflex, not a decision. LLM never has to
  // think about this; keeps the bot from starving mid-task. Eats any food it has.
  async eat(){
    if (bot.food === undefined || bot.food >= 20) return { ok:true, note:'not hungry' };
    const FOODS = ['cooked_beef','cooked_porkchop','cooked_chicken','cooked_mutton',
      'bread','cooked_cod','cooked_salmon','apple','carrot','potato','baked_potato',
      'beef','porkchop','chicken','mutton','melon_slice','sweet_berries'];
    const have = FOODS.find(helpers.hasItem);
    if (!have) return { ok:false, reason:'no food in inventory' };
    try {
      await helpers.equipItem(have);
      await bot.consume();
      return { ok:true, ate:have, food:bot.food };
    } catch(e){ return { ok:false, reason:`eat failed: ${e.message}` }; }
  },

  // HOW to till one soil block into farmland. LLM decides WHERE to farm and
  // whether to farm at all; this just performs the hoe action on a given spot
  // (or the dirt/grass block directly under the bot if no pos given).
  async till(pos){
    const hoe = ['netherite_hoe','diamond_hoe','iron_hoe','stone_hoe','wooden_hoe']
      .find(helpers.hasItem);
    if (!hoe) return { ok:false, reason:'no hoe in inventory' };
    let target = pos ? bot.blockAt(new Vec3(pos.x, pos.y, pos.z)) : null;
    if (!target){
      const feet = bot.entity.position.floored();
      target = bot.blockAt(feet.offset(0,-1,0));
    }
    if (!target || !['dirt','grass_block','dirt_path'].includes(target.name))
      return { ok:false, reason:`can't till ${target ? target.name : 'nothing'} (need dirt/grass)` };
    try {
      await helpers.equipItem(hoe);
      await bot.activateBlock(target);
      const after = bot.blockAt(target.position);
      return { ok: after && after.name === 'farmland', block: after ? after.name : null };
    } catch(e){ return { ok:false, reason:`till failed: ${e.message}` }; }
  },

  // HOW to plant a seed the LLM named onto nearby farmland. LLM chooses WHAT to
  // plant and WHERE the farm is; this performs the placement onto tilled soil.
  async plant(seedName, pos){
    if (!helpers.hasItem(seedName)) return { ok:false, reason:`no ${seedName} to plant` };
    let farm = pos ? bot.blockAt(new Vec3(pos.x, pos.y, pos.z)) : null;
    if (!farm || farm.name !== 'farmland'){
      const id = mcData.blocksByName.farmland ? mcData.blocksByName.farmland.id : -1;
      farm = bot.findBlock({ matching: id, maxDistance: 6 });
    }
    if (!farm) return { ok:false, reason:'no farmland nearby to plant on' };
    try {
      await helpers.equipItem(seedName);
      await bot.placeBlock(farm, new Vec3(0,1,0));
      return { ok:true, planted:seedName, at:farm.position };
    } catch(e){ return { ok:false, reason:`plant failed: ${e.message}` }; }
  },

  // HOW to harvest mature crops of a named type within range. LLM decides WHEN
  // to harvest and WHAT crop; this breaks the grown ones and collects drops.
  async harvest(cropName, maxDist=16){
    const id = mcData.blocksByName[cropName] ? mcData.blocksByName[cropName].id : -1;
    if (id < 0) return { ok:false, reason:`unknown crop '${cropName}'` };
    const spots = bot.findBlocks({ matching:id, maxDistance:maxDist, count:16 });
    if (!spots.length) return { ok:false, env_failure:true, reason:`no ${cropName} found within ${maxDist}` };
    let harvested = 0;
    for (const p of spots){
      const b = bot.blockAt(p);
      // only fully-grown crops (age metadata at max) are worth breaking
      if (!b) continue;
      const grown = (b.getProperties && b.getProperties().age !== undefined)
        ? Number(b.getProperties().age) >= 7 : true;
      if (!grown) continue;
      try {
        await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1));
        await bot.dig(b);
        harvested++;
      } catch(e){ /* skip ones we can't reach */ }
      if (harvested >= 8) break;
    }
    return { ok: harvested > 0, harvested,
             env_failure: harvested === 0,
             reason: harvested === 0 ? 'no mature crops in range' : undefined };
  },
};

async function runSkill(code, timeout_ms){
  // reset the runaway-log detector for this run so counts don't leak across skills
  _lastLogLine = null; _lastLogRepeat = 0; _spamTripped = false;
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  let fn;
  try {
    // Construction parses the code. A SyntaxError here means the LLM wrote
    // invalid JS — catch it cleanly so the retry loop gets a precise message
    // instead of a raw crash, and WITHOUT wasting an execution.
    fn = new AsyncFunction('bot','mcData','Vec3','log','helpers','goals',
      `return (async () => { ${code} \n })();`);
  } catch (e) {
    throw new Error(`SYNTAX ERROR in generated code (${e.message}). The code did `
      + `not parse. Check for references to variables not in scope (only bot, `
      + `mcData, Vec3, log, helpers, goals exist) and for malformed statements.`);
  }
  // Stop any movement/goal the (now-abandoned) skill left running. Without this,
  // a timed-out skill's pending pathfinder.goto keeps executing in the background
  // and collides with the NEXT attempt's movement — the "goal was changed before
  // it could be completed" cascade. Called on timeout AND on error.
  function cancelInFlight(){
    try { if (bot.pathfinder && bot.pathfinder.setGoal) bot.pathfinder.setGoal(null); } catch(e){}
    try { if (bot.pathfinder && bot.pathfinder.stop) bot.pathfinder.stop(); } catch(e){}
    try { bot.clearControlStates && bot.clearControlStates(); } catch(e){}
    for (const c of ['forward','back','left','right','jump','sprint','sneak']){
      try { bot.setControlState(c, false); } catch(e){}
    }
    try { bot.stopDigging && bot.stopDigging(); } catch(e){}
  }
  let timer;
  const timeoutP = new Promise((_,rej)=>{
    timer = setTimeout(()=>{ cancelInFlight(); rej(new Error(`skill timed out after ${timeout_ms}ms`)); }, timeout_ms);
  });
  // Guard hallucinated helper names: the model sometimes calls a helper that does
  // not exist (e.g. `anyPlansInInventory` for `anyPlanksInInventory`). Without a
  // guard that's a raw TypeError that wastes the whole attempt. Intercept unknown
  // helper access and throw a CLEAR, actionable error naming the closest real one.
  const _realHelperNames = Object.keys(helpers);
  const _lev = (a,b)=>{ const d=[...Array(a.length+1)].map((_,i)=>[i,...Array(b.length).fill(0)]);
    for(let j=0;j<=b.length;j++)d[0][j]=j;
    for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)
      d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
    return d[a.length][b.length]; };
  const guardedHelpers = new Proxy(helpers, {
    get(target, prop){
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol' || prop === 'then') return target[prop];
      // find nearest real helper name for a "did you mean"
      let best=null, bd=1e9;
      for (const n of _realHelperNames){ const d=_lev(String(prop), n); if(d<bd){bd=d; best=n;} }
      const hint = (best && bd <= Math.max(2, best.length/3))
        ? ` Did you mean helpers.${best}()?` : '';
      throw new Error(`helpers.${String(prop)} does not exist.${hint} `
        + `Only use helpers listed in the contract; do not invent helper names.`);
    }
  });
  try {
    _skillRunning = true;   // watchdog stays hands-off while a skill drives the bot
    _skillInterruptedByDrowning = false;   // fresh per run
    _skillInterruptedByMob = false;
    // Clear any control states a watchdog reflex may have left set (its 600-700ms
    // bursts could still be finishing exactly as this skill starts). Ensures the
    // skill begins from a clean movement state, not mid-swim/mid-retreat.
    for (const c of ['forward','back','left','right','jump','sprint','sneak'])
      { try { bot.setControlState(c, false); } catch(_){} }
    const out = await Promise.race([ fn(bot,mcData,Vec3,log,guardedHelpers,goals), timeoutP ]);
    // If the watchdog had to interrupt this skill to escape drowning, report it as
    // an environmental failure regardless of what the (now-derailed) skill returned
    // — the bot was in mortal danger, not running buggy code.
    if (_skillInterruptedByDrowning){
      return { ok:false, env_failure:true,
               reason:'skill interrupted by survival watchdog to escape drowning/lava' };
    }
    if (_skillInterruptedByMob){
      return { ok:false, env_failure:true,
               reason:'skill interrupted by survival watchdog to defend against a mob' };
    }
    return out;
  } catch (e){
    cancelInFlight();               // also clear movement on a thrown error
    if (_skillInterruptedByDrowning){
      return { ok:false, env_failure:true,
               reason:'skill interrupted by survival watchdog to escape drowning/lava' };
    }
    if (_skillInterruptedByMob){
      return { ok:false, env_failure:true,
               reason:'skill interrupted by survival watchdog to defend against a mob' };
    }
    throw e;
  } finally {
    _skillRunning = false;          // dead time begins — watchdog may now act
    clearTimeout(timer);
  }
}

let buf = '';
process.stdin.on('data', async (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0){
    const line = buf.slice(0,idx).trim(); buf = buf.slice(idx+1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch(e){ send({type:'error',error:'bad json: '+line}); continue; }
    handle(msg);
  }
});

async function handle(msg){
  const { id, cmd } = msg;
  try {
    if (cmd === 'get_state'){
      send({ id, type:'state', data:snapshot() });
    } else if (cmd === 'chat'){
      if (!ready || !bot) { send({ id, type:'result', data:{ error:'bot not connected' } }); return; }
      bot.chat(msg.text); send({ id, type:'result', data:{ chatted:msg.text } });
    } else if (cmd === 'run_skill'){
      if (!ready || !bot || !bot.entity) {
        send({ id, type:'result', data:{ ok:false, result:null,
               error:'bot is not connected/ready (reconnecting?) — skipping this action',
               stack:null, logs:[], before:{ready:false}, after:{ready:false} } });
        return;
      }
      // WATER GATE: if the bot is in water, do NOT run the skill — it would just
      // fail with "could not reach a block" while treading water, wasting a cycle
      // (observed: Garrick/Rowan burned every cycle failing while stuck in a lake).
      // The survival watchdog is actively swimming it to shore; report a benign
      // skip so the orchestrator doesn't count this as a code failure or revise the
      // skill. The bot does ONE thing while wet: get to land.
      if (_inWaterNow){
        const s = snapshot();
        send({ id, type:'result', data:{ ok:false, result:null,
               error:'blocked_in_water: bot is in water and is swimming to shore '
                    + '(survival watchdog) — skill skipped until on dry land',
               env_failure:true, stack:null, logs:['[host] skill skipped: in water'],
               before:s, after:s } });
        return;
      }
      // World context the ORCHESTRATOR knows but the bot can't see locally: the
      // established community workshop/home site, and whether this bot is the
      // decider. Stored module-level so tested HELPERS (e.g. craftItem) can route
      // to home instead of dropping loose infrastructure wherever they stand. This
      // is the shared civic-memory the bots reason over — persistent, global.
      _worldContext = {
        workshop: (msg.context && msg.context.workshop) || null,
        isDecider: !!(msg.context && msg.context.isDecider),
      };
      _lastCraftPlacedTempTable = false;   // reset per run; craftItem may set it
      // Defensive: clear any movement/goal left over from a previous skill that
      // may have timed out, so this fresh run starts from a clean control state.
      try { if (bot.pathfinder && bot.pathfinder.setGoal) bot.pathfinder.setGoal(null); } catch(e){}
      try { bot.clearControlStates && bot.clearControlStates(); } catch(e){}
      const before = snapshot();
      let result, error=null, stack=null;
      _logBuffer = [];                       // start capturing this run's logs
      try { result = await runSkill(msg.code, msg.timeout_ms || 60000); }
      catch(e){ error = e.message; stack = e.stack; }
      const logs = _logBuffer; _logBuffer = null;
      await new Promise(r=>setTimeout(r,400));
      const after = snapshot();
      send({ id, type:'result', data:{ ok:error===null, result:result??null,
             error, stack, logs, before, after,
             placedTempTable: _lastCraftPlacedTempTable } });
    } else {
      send({ id, type:'error', error:'unknown cmd: '+cmd });
    }
  } catch(e){ send({ id, type:'error', error:e.message, stack:e.stack }); }
}
// A skill can trigger a throw from INSIDE a mineflayer event callback (e.g.
// openFurnace's progress-bar listener firing on a malformed block). That escapes
// runSkill's try/catch because it runs on the event loop, not in the awaited
// promise chain — so without this it crashes the whole host. We can't turn it
// into a normal skill failure from here (the run's promise already settled or is
// racing the timeout), but we MUST NOT let it kill the process: log it, clear any
// in-flight movement, and keep the host alive for the next command.
process.on('uncaughtException', (e)=>{
  log('UNCAUGHT (recovered, host stays alive): ' + (e && e.stack ? e.stack : e));
  try { if (bot && bot.pathfinder && bot.pathfinder.setGoal) bot.pathfinder.setGoal(null); } catch(_){}
  try { bot && bot.clearControlStates && bot.clearControlStates(); } catch(_){}
});
process.on('unhandledRejection', (e)=>{
  log('UNHANDLED REJECTION (recovered): ' + (e && e.stack ? e.stack : e));
});
