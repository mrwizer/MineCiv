// 1. Gather logs using the robust helper
const gatherRes = await helpers.collectAnyLog(2);
if (!gatherRes || !gatherRes.ok) return { error: "Failed to gather logs" };

// 2. Craft planks (auto-detects species from inventory)
// We craft 8 to ensure we have enough for sticks and chest parts
const plankRes = await helpers.craftItem('planks', 8);
if (!plankRes || !plankRes.ok) return { error: "Failed to craft planks", reason: plankRes.reason };

// 3. Craft the chest
// craftItem handles crafting table placement automatically if needed
const chestRes = await helpers.craftItem('chest', 1);
if (!chestRes || !chestRes.ok) return { error: "Failed to craft chest", reason: chestRes.reason };

return { crafted: 'chest', count: 1 };