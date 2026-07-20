const mob = helpers.mobility();
if (mob.likelyStuckInHole || mob.surroundedAtFeet >= 3) {
  log('Stuck detected, initiating escape protocol.');
  const res = await helpers.getUnstuck();
  if (res.ok) {
    log('Successfully escaped using getUnstuck.');
    return { status: 'escaped', method: 'getUnstuck' };
  }
  log('getUnstuck failed, forcing manual escape.');
}

// If getUnstuck failed or wasn't called, try manual escape steps.
// 1. Check if buried (block above is not air)
const blockAbove = await bot.blockAt(new Vec3(bot.entity.position.x, bot.entity.position.y + 1, bot.entity.position.z));
if (blockAbove && blockAbove.name !== 'air') {
  log('Buried, attempting to pillar up.');
  const pillarRes = await helpers.pillarUp(2, 'dirt');
  if (pillarRes.ok) {
    // After pillar up, try to get unstuck again to find an exit
    const res = await helpers.getUnstuck();
    if (res.ok) return { status: 'escaped', method: 'pillar_then_unstuck' };
  }
}

// 2. Try to dig out sideways if not buried
if (blockAbove && blockAbove.name === 'air') {
  const dirs = [
    { x: 0, z: 1, name: 'South' },
    { x: 0, z: -1, name: 'North' },
    { x: 1, z: 0, name: 'East' },
    { x: -1, z: 0, name: 'West' }
  ];
  for (const dir of dirs) {
    const targetPos = new Vec3(bot.entity.position.x + dir.x, bot.entity.position.y, bot.entity.position.z + dir.z);
    const block = await bot.blockAt(targetPos);
    if (block && block.name !== 'air') {
      log(`Digging ${dir.name} side.`);
      await helpers.dig(block);
      // Move into the newly dug space
      const moveRes = await helpers.gotoXYZ(targetPos.x, targetPos.y, targetPos.z, 0);
      if (moveRes) return { status: 'escaped', method: 'dig_sideways' };
    }
  }
}

// 3. If all else fails, try escapeToSurface as a last resort
log('Manual escape failed, trying escapeToSurface.');
const finalRes = await helpers.escapeToSurface();
if (finalRes.ok) return { status: 'escaped', method: 'escapeToSurface' };

return { status: 'still_stuck', reason: 'All escape methods failed' };