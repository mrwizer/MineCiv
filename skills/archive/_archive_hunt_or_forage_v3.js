// 1. Check if already fed
if (helpers.hasItem('cooked_beef') || helpers.hasItem('cooked_porkchop') || helpers.hasItem('cooked_chicken') || helpers.hasItem('cooked_salmon') || helpers.hasItem('bread')) {
  return { status: 'already_fed' };
}

// 2. Hunt passive mobs
const entities = helpers.nearbyEntities(16);
const passive = entities.find(e => e.type === 'mob' && ['chicken', 'pig', 'cow', 'sheep', 'rabbit'].includes(e.kind));

if (passive) {
  await helpers.equipItem('wooden_sword');
  await helpers.gotoXYZ(passive.pos.x, passive.pos.y, passive.pos.z, 2);
  await helpers.attack(passive);
  const result = await helpers.collectBlock(passive.kind, 5);
  if (result.collected > 0) {
    return { status: 'hunted', mob: passive.kind, collected: result.collected };
  }
}

// 3. Fallback: Forage seeds from grass
const grasses = helpers.findBlocks('tall_grass', 10, 8).concat(helpers.findBlocks('short_grass', 10, 8));
if (grasses.length > 0) {
  const target = grasses[0];
  await helpers.gotoXYZ(target.x, target.y, target.z, 1);
  await helpers.dig(target);
  const result = await helpers.collectBlock('wheat_seeds', 5);
  if (result.collected > 0) {
    return { status: 'found_seeds', collected: result.collected };
  }
}

return { status: 'no_resources' };