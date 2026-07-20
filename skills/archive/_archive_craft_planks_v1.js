log("Crafting oak planks.");
// Check if we already have enough planks to satisfy the implicit goal (usually 12 for a table/floor)
const have = helpers.invCount('oak_planks');
const need = Math.max(0, 12 - have);
if (need <= 0) {
  log("Already have enough planks.");
  return { collected: 'oak_planks', count: have };
}

// Ensure we have logs to craft
const logs = helpers.invCount('oak_log');
if (logs < 1) {
  log("No oak logs found. Gathering...");
  const res = await helpers.collectAnyLog(1);
  if (!res.ok || res.collected < 1) return { error: "Failed to gather log" };
}

// Craft the planks. Using helpers.craftItem handles table placement automatically.
const res = await helpers.craftItem('oak_planks', need);
if (!res || !res.ok) {
  log("Crafting failed: " + res.reason);
  return { error: "Crafting failed", reason: res.reason };
}

log("Crafted " + res.crafted + " planks.");
return { collected: 'oak_planks', count: res.crafted };