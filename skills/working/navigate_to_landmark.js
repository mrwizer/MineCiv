await log("Navigating to (-117, 68, -91)...");
// Ensure we are not stuck before moving
const mob = helpers.mobility();
if (mob.surroundedAtFeet >= 3 || mob.likelyStuckInHole) {
  await log("Stuck, getting unstuck first.");
  await helpers.getUnstuck();
}

// Navigate to target
await helpers.gotoXYZ(-117, 68, -91, 2);

// Verify arrival and inventory state
const pos = bot.entity.position;
const dist = pos.distanceTo(new Vec3(-117, 68, -91));
const hasCobble = helpers.invCount('cobblestone') > 0;

if (dist > 3) {
  return { status: 'failed', reason: 'pathfinding_timeout', position: pos };
}

return {
  status: 'completed',
  position: pos,
  cobblestone: helpers.invCount('cobblestone'),
  hasCobble: hasCobble
};