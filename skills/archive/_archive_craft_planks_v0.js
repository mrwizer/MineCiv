log("Crafting 12 oak planks from 7 oak logs.");
// We have 7 oak logs. 1 log = 4 planks. 7 * 4 = 28 planks possible.
// We need 12 planks. 3 logs are sufficient.
// Check current inventory to avoid over-crafting if we already have some, 
// but the task is specific: "Craft 12 oak planks". 
// Since we have 1 oak_plank already, we need 11 more. 
// Crafting 3 logs yields 12 planks. Total will be 13. This satisfies the goal.

const res = await helpers.craftItem('oak_planks', 3);
if (!res || !res.ok) {
  log("Crafting failed: " + res.reason);
  return { error: "Crafting failed", reason: res.reason };
}

log("Crafted " + res.crafted + " planks.");
return { collected: 'oak_planks', count: res.crafted };