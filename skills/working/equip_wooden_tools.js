log("Checking inventory...");
if (helpers.hasItem('wooden_pickaxe') && helpers.hasItem('wooden_sword')) {
  return { success: true, items: ['wooden_pickaxe', 'wooden_sword'] };
}

log("Gathering wood...");
const res = await helpers.collectAnyLog(4);
if (!res.ok) {
  log("Failed to collect wood: " + res.reason);
  return { error: 'wood_gather_failed', reason: res.reason };
}
log(`Collected wood: ${res.item} x${res.collected}`);

log("Crafting tools...");
const crafts = [];
if (!helpers.hasItem('wooden_pickaxe')) {
  const r = await helpers.craftItem('wooden_pickaxe', 1);
  crafts.push({ item: 'wooden_pickaxe', ok: r.ok, reason: r.reason });
  if (!r.ok) log(`Pickaxe craft failed: ${r.reason}`);
}
if (!helpers.hasItem('wooden_sword')) {
  const r = await helpers.craftItem('wooden_sword', 1);
  crafts.push({ item: 'wooden_sword', ok: r.ok, reason: r.reason });
  if (!r.ok) log(`Sword craft failed: ${r.reason}`);
}

return {
  success: crafts.every(c => c.ok),
  crafts: crafts,
  has_pickaxe: helpers.hasItem('wooden_pickaxe'),
  has_sword: helpers.hasItem('wooden_sword')
};