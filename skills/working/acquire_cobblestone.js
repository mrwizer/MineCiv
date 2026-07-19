log("Deadlock: No cobblestone, wooden pickaxe cannot mine stone. Digging down to find exposed stone.");
const digResult = await helpers.digStaircaseDown(8);
log(`Dig result: ${JSON.stringify(digResult)}`);

if (digResult.hitStone || digResult.depth > 0) {
  log("Reached stone layer, acquiring cobblestone.");
  const stoneResult = await helpers.acquireStone(8);
  log(`Acquire result: ${JSON.stringify(stoneResult)}`);
  
  if (stoneResult.ok && stoneResult.collected > 0) {
    log("Cobblestone acquired. Crafting stone pickaxe.");
    const craftResult = await helpers.craftItem('stone_pickaxe', 1);
    log(`Craft result: ${JSON.stringify(craftResult)}`);
    return { status: 'stone_pickaxe_crafted', cobblestone: stoneResult.collected };
  }
}

log("Failed to get cobblestone or craft pickaxe. Checking nearby items for help.");
// Fallback: Check if any nearby item is cobblestone
const entities = helpers.nearbyEntities(10);
for (const ent of entities) {
  if (ent.type === 'other' && ent.name === 'item') {
    // Try to collect it if it's cobblestone
    const itemResult = await helpers.collectBlock('cobblestone', 1, 10);
    if (itemResult.ok && itemResult.collected > 0) {
      log("Found cobblestone item. Crafting pickaxe.");
      const craftResult = await helpers.craftItem('stone_pickaxe', 1);
      return { status: 'stone_pickaxe_crafted', cobblestone: itemResult.collected };
    }
  }
}

return { status: 'stuck', reason: 'no_cobblestone_source' };