log("Gathering 5 wood logs...");
const gather = await helpers.collectAnyLog(5);
if (!gather.ok || gather.collected < 5) {
  log(`Failed to gather logs. Got: ${gather.collected}`);
  return { error: 'insufficient_logs', collected: gather.collected };
}
log("Logs gathered. Crafting wooden pickaxe...");
const craft = await helpers.craftItem('wooden_pickaxe', 1);
if (!craft.ok) {
  log(`Crafting failed: ${craft.reason}`);
  return { error: 'crafting_failed', reason: craft.reason };
}
return { collected: 5, crafted: 'wooden_pickaxe' };