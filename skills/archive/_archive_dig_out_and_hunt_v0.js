// Previous attempt dug deeper or moved into a confined space.
// Current state: likelyStuckInHole=true, openSkyAbove=true, canJumpUp=true.
// This means we are in a shallow hole/pit where we can see the sky but cannot jump out
// or move sideways because of walls.
// Since openSkyAbove is true, we are not buried. We just need to climb out.
// helpers.getUnstuck() is designed for this. It will check mobility and choose
// the best path (dig out, pillar up if buried, or path out).
// Given canJumpUp is true, it might just try to path out. If walls block path,
// it will dig.
const result = await helpers.getUnstuck();
if (result.ok) {
  log('Successfully unstuck.');
  // Now find passive mobs.
  // Look for entities.
  const entities = helpers.nearbyEntities(10);
  const passive = entities.find(e => e.type === 'mob' && e.kind === 'passive');
  if (passive) {
    log(`Found passive mob: ${passive.name}`);
    // Attack it
    await helpers.attack(passive);
    // Collect drops
    await helpers.collectBlock(passive.name, 1, 5);
    return { status: 'escaped', food: true };
  }
  // No passive mobs nearby, roam to find some.
  await helpers.gotoXYZ(bot.entity.position.x, bot.entity.position.y, bot.entity.position.z, 15);
  return { status: 'escaped', roaming: true };
}
return { status: 'still_stuck', reason: result.reason };