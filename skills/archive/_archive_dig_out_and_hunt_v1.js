// 1. Unstuck if necessary
const mobility = helpers.mobility();
if (mobility.likelyStuckInHole || mobility.surroundedAtFeet >= 3) {
  const res = await helpers.getUnstuck();
  if (!res.ok) return { status: 'stuck', reason: res.reason };
}

// 2. Find passive mobs
const entities = helpers.nearbyEntities(15);
const passive = entities.find(e => e.type === 'mob' && e.kind === 'passive');
if (!passive) {
  // Roam to find food
  await helpers.gotoXYZ(bot.entity.position.x, bot.entity.position.y, bot.entity.position.z, 15);
  return { status: 'escaped', food: false, roaming: true };
}

// 3. Attack and collect
await helpers.attack(passive);
const collectRes = await helpers.collectBlock(passive.name, 1, 5);
if (!collectRes.ok) {
  log(`Failed to collect ${passive.name}`);
}

return { status: 'escaped', food: true, collected: collectRes.item, count: collectRes.collected };