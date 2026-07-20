log("Crafting oak planks.");
// 1. Check inventory
const have = helpers.invCount('oak_planks');
const need = Math.max(0, 4 - have);
if (need <= 0) return { collected: 'oak_planks', count: have };

// 2. Ensure we have logs
if (helpers.invCount('oak_log') < 1) {
  const res = await helpers.collectAnyLog(1);
  if (!res || !res.ok) return { error: "Failed to gather wood" };
}

// 3. Craft planks
// helpers.craftItem handles table placement, recipe lookup, and execution.
const res = await helpers.craftItem('oak_planks', need);
if (!res || !res.ok) {
  log("Crafting failed: " + (res.reason || "Unknown error"));
  return { error: "Crafting failed", reason: res.reason };
}

log("Crafted " + res.crafted + " planks.");
return { collected: 'oak_planks', count: res.crafted };