// 1. Check inventory for food first to avoid unnecessary work
if (helpers.invCount('cooked_beef') > 0 || helpers.invCount('cooked_porkchop') > 0 || 
    helpers.invCount('cooked_chicken') > 0 || helpers.invCount('cooked_salmon') > 0 ||
    helpers.invCount('bread') > 0) {
  return { status: 'already_fed', food_count: helpers.invCount('cooked_beef') + helpers.invCount('cooked_porkchop') + helpers.invCount('cooked_chicken') + helpers.invCount('cooked_salmon') + helpers.invCount('bread') };
}

// 2. Hunt passive mobs for raw meat
const entities = helpers.nearbyEntities(16);
const passive = entities.find(e => 
  e.type === 'mob' && 
  ['chicken', 'pig', 'cow', 'sheep', 'rabbit'].includes(e.kind)
);

if (passive) {
  await helpers.equipItem('wooden_sword');
  await helpers.gotoXYZ(passive.pos.x, passive.pos.y, passive.pos.z, 2);
  await helpers.attack(passive);
  await helpers.collectBlock(passive.kind, 1); // Collect raw meat
  return { status: 'hunted', mob: passive.kind, collected: 1 };
}

// 3. Fallback: Collect seeds from grass
// Try tall grass first (higher chance of seeds/drops)
const tallGrass = helpers.findBlocks('tall_grass', 5, 10);
if (tallGrass.length > 0) {
  const target = tallGrass[0];
  await helpers.gotoXYZ(target.x, target.y, target.z, 1);
  await helpers.collectBlock('wheat_seeds', 5);
  if (helpers.invCount('wheat_seeds') > 0) return { status: 'found_seeds', count: helpers.invCount('wheat_seeds') };
}

// Then short grass
const shortGrass = helpers.findBlocks('short_grass', 5, 10);
if (shortGrass.length > 0) {
  const target = shortGrass[0];
  await helpers.gotoXYZ(target.x, target.y, target.z, 1);
  await helpers.collectBlock('wheat_seeds', 5);
  if (helpers.invCount('wheat_seeds') > 0) return { status: 'found_seeds_short', count: helpers.invCount('wheat_seeds') };
}

// 4. If still no food or seeds, try to cook raw meat if we have any (e.g. from previous tasks or hunting failed but dropped)
// Note: Hunt above collects raw meat. If we have raw meat, we might need to cook it, but the task is "hunt or forage".
// If we have raw meat, we have "food" in a broad sense, but let's stick to the prompt's likely intent: obtain edible items.
// If we have raw meat, we can return it as a successful hunt.
if (helpers.invCount('raw_beef') > 0 || helpers.invCount('raw_porkchop') > 0 || helpers.invCount('raw_chicken') > 0 || helpers.invCount('raw_salmon') > 0) {
  return { status: 'hunted_raw', type: 'raw_meat', count: helpers.invCount('raw_beef') + helpers.invCount('raw_porkchop') + helpers.invCount('raw_chicken') + helpers.invCount('raw_salmon') };
}

return { status: 'no_food_or_seeds_found' };