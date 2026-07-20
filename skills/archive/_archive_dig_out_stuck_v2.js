log('Stuck detected, initiating escape protocol.');
// 1. Primary escape: Let the robust helper handle digging/pillaring/pathfinding
const res = await helpers.getUnstuck();
if (res.ok) {
  log('Escaped via getUnstuck.');
  return { status: 'escaped', method: 'getUnstuck' };
}

log('getUnstuck failed or incomplete. Verifying current state.');
const mob = helpers.mobility();

// 2. If still buried (block above), pillar up to break surface
if (mob.surroundedAtFeet >= 3 || mob.likelyStuckInHole) {
  // Ensure we have a pillar block. Default to dirt if empty.
  let pillarBlock = 'dirt';
  if (!helpers.hasItem(pillarBlock)) {
    // Try to find dirt nearby or use whatever is in inventory
    const anyItem = helpers.invCount('dirt') > 0 ? 'dirt' : null;
    if (anyItem) pillarBlock = anyItem;
    else {
      // Attempt to grab dirt if possible, otherwise just try with current hand or fail
      log('No dirt found for pillar, trying generic pillar.');
    }
  }
  
  const pillarRes = await helpers.pillarUp(2, pillarBlock);
  if (pillarRes.ok) {
    log('Pilled up, trying getUnstuck again to exit.');
    const res2 = await helpers.getUnstuck();
    if (res2.ok) return { status: 'escaped', method: 'pillar_then_unstuck' };
  }
}

// 3. If still stuck, dig sideways to create space
log('Still stuck, attempting to dig sideways.');
const dirs = [
  { x: 0, z: 1 }, { x: 0, z: -1 }, { x: 1, z: 0 }, { x: -1, z: 0 }
];
for (const dir of dirs) {
  const targetPos = new Vec3(bot.entity.position.x + dir.x, bot.entity.position.y, bot.entity.position.z + dir.z);
  const block = await bot.blockAt(targetPos);
  
  if (block && block.name !== 'air' && block.name !== 'bedrock') {
    log(`Digging ${dir.x},${dir.z} side.`);
    const digRes = await helpers.dig(block);
    if (digRes.ok) {
      // Move into the dug space
      const moveRes = await helpers.gotoXYZ(targetPos.x, targetPos.y, targetPos.z, 0);
      if (moveRes) return { status: 'escaped', method: 'dig_sideways' };
    }
  }
}

// 4. Last resort: Force surface escape
log('Manual escape failed, forcing escapeToSurface.');
const finalRes = await helpers.escapeToSurface();
if (finalRes.ok) return { status: 'escaped', method: 'escapeToSurface' };

return { status: 'still_stuck', reason: 'All escape methods failed' };