log("Starting wood collection...");

// 1. Safety & Prep
const mob = helpers.mobility();
if (mob.surroundedAtFeet >= 3 || mob.likelyStuckInHole) {
  await helpers.getUnstuck();
}

// 2. Try collecting directly (handles nearby trees)
const res = await helpers.collectAnyLog(5);
if (res && res.ok && res.collected >= 5) {
  return { collected: 'wood_log', count: 5 };
}

// 3. If failed or insufficient, explore for logs
log("Not enough logs nearby, exploring...");
await helpers.exploreFor('_log');

// 4. Try collecting again after exploring
const res2 = await helpers.collectAnyLog(5);
if (res2 && res2.ok && res2.collected >= 5) {
  return { collected: 'wood_log', count: 5 };
}

// 5. Final check: do we have 5 logs?
if (helpers.invCount('wood_log') >= 5) {
  return { collected: 'wood_log', count: 5 };
}

return { error: 'Failed to collect 5 wood logs' };