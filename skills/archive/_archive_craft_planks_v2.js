log("Crafting oak planks.");
const have = helpers.invCount('oak_planks');
const need = Math.max(0, 12 - have);
if (need <= 0) return { collected: 'oak_planks', count: have };

// Gather logs if needed
if (helpers.invCount('oak_log') < 1) {
  const res = await helpers.collectAnyLog(1);
  if (!res.ok || res.collected < 1) return { error: "Failed to gather log" };
}

// Craft planks (auto-handles table placement)
const res = await helpers.craftItem('oak_planks', need);
if (!res || !res.ok) {
  log("Crafting failed: " + res.reason);
  return { error: "Crafting failed", reason: res.reason };
}

log("Crafted " + res.crafted + " planks.");
return { collected: 'oak_planks', count: res.crafted };