log("Gathering logs...");
const logRes = await helpers.collectAnyLog(5);
if (!logRes || logRes.collected < 5) {
  log("Failed to collect logs, exploring...");
  await helpers.exploreFor('_log');
  const logRes2 = await helpers.collectAnyLog(5);
  if (!logRes2 || logRes2.collected < 5) return { error: "Could not find logs" };
}

log("Crafting planks...");
// Check current plank count to decide how many to craft
const currentPlanks = helpers.invCount('oak_planks');
const needed = 5 - currentPlanks; // We have 2 logs, need 5 planks total. 1 log = 4 planks.
// Actually, we just need MORE planks than before. We have 3.
// Let's craft 2 logs into planks to get 8 planks. Total 11.
const craftCount = 2; 
const craftRes = await helpers.craftItem('oak_planks', craftCount);
if (!craftRes || !craftRes.ok) return { error: "Crafting failed", reason: craftRes.reason };

return { collected: 'oak_planks', count: craftRes.crafted };