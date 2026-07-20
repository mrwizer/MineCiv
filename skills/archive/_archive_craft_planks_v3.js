log("Crafting oak planks.");
// 1. Check if we already have enough
const have = helpers.invCount('oak_planks');
const need = Math.max(0, 4 - have); // Task specifically asked for 4
if (need <= 0) return { collected: 'oak_planks', count: have };

// 2. Ensure we have logs
if (helpers.invCount('oak_log') < 1) {
  // Use collectAnyLog to find whatever wood is available
  const res = await helpers.collectAnyLog(1);
  if (!res || !res.ok) return { error: "Failed to gather wood" };
}

// 3. Craft the planks
// helpers.craftItem handles table placement and recipe lookup
const res = await helpers.craftItem('oak_planks', need);
if (!res || !res.ok) {
  log("Crafting failed: " + (res.reason || "Unknown error"));
  return { error: "Crafting failed", reason: res.reason };
}

log("Crafted " + res.crafted + " planks.");
return { collected: 'oak_planks', count: res.crafted };