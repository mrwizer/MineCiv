// 1. Gather wood and ensure planks are available
const logsNeeded = 2;
const currentLogs = helpers.invCount('oak_log') + helpers.invCount('birch_log') + helpers.invCount('spruce_log') + helpers.invCount('jungle_log') + helpers.invCount('acacia_log') + helpers.invCount('dark_oak_log') + helpers.invCount('mangrove_log') + helpers.invCount('cherry_log');
if (currentLogs < logsNeeded) {
  const gatherRes = await helpers.collectAnyLog(logsNeeded - currentLogs);
  if (!gatherRes || !gatherRes.ok) return { error: "Failed to gather logs" };
}

// 2. Craft planks (auto-detects species)
const planksRes = await helpers.craftItem('planks', 8);
if (!planksRes || !planksRes.ok) return { error: "Failed to craft planks", reason: planksRes.reason };

// 3. Craft Chest (auto-handles crafting table placement if needed)
const chestRes = await helpers.craftItem('chest', 1);
if (!chestRes || !chestRes.ok) return { error: "Failed to craft chest", reason: chestRes.reason };

return { crafted: 'chest', count: 1 };