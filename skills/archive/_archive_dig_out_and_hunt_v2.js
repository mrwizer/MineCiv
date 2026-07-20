// 1. Unstuck if necessary
const mob = helpers.mobility();
if (mob.likelyStuckInHole || mob.surroundedAtFeet >= 3) {
  const res = await helpers.getUnstuck();
  if (!res.ok) return { status: 'stuck', reason: res.reason };
}

// 2. Find passive mobs
const entities = helpers.nearbyEntities(20);
const passive = entities.find(e => e.type === 'mob' && e.kind === 'passive');
if (!passive) {
  // Roam to find food
  const dest = new Vec3(
    bot.entity.position.x + (Math.random() * 20 - 10),
    bot.entity.position.y,
    bot.entity.position.z + (Math.random() * 20 - 10)
  );
  await helpers.gotoXYZ(dest.x, dest.y, dest.z, 5);
  return { status: 'escaped', food: false, roaming: true };
}

// 3. Attack and collect
await helpers.attack(passive);
const collectRes = await helpers.collectBlock(passive.name, 1, 10);
if (!collectRes.ok) {
  log(`Failed to collect ${passive.name}`);
}

return { status: 'escaped', food: true, collected: collectRes.item, count: collectRes.collected };