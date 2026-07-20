log("Starting wood collection...");
// 1. Collect 5 logs using the robust collectAnyLog helper
const logResult = await helpers.collectAnyLog(5);
if (!logResult || !logResult.ok || logResult.collected < 5) {
  log("Failed to collect logs, exploring...");
  await helpers.exploreFor('_log');
  const logResult2 = await helpers.collectAnyLog(5);
  if (logResult2 && logResult2.ok && logResult2.collected >= 5) {
    log("Logs collected after exploration.");
  } else {
    return { error: "Could not collect 5 logs" };
  }
}

// 2. Identify wood species and craft planks
const species = helpers.anyLogInInventory();
if (!species) return { error: "No logs in inventory" };

const plankCount = 5 * 4; // 5 logs -> 20 planks
const craftPlanks = await helpers.craftItem(`${species}_planks`, plankCount);
if (!craftPlanks || !craftPlanks.ok) return { error: "Failed to craft planks", reason: craftPlanks?.reason };

// 3. Craft sticks (1 plank -> 2 sticks, need 2 planks for 4 sticks)
const stickCount = 4;
const craftSticks = await helpers.craftItem('stick', stickCount);
if (!craftSticks || !craftSticks.ok) return { error: "Failed to craft sticks", reason: craftSticks?.reason };

log("Task complete: logs, planks, and sticks acquired.");
return { collected: 'wood_resources', planks: plankCount, sticks: stickCount };