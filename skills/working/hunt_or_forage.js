await helpers.equipItem('wooden_sword');
const entities = helpers.nearbyEntities(16);
// Filter for passive mobs: chicken, pig, cow, sheep, rabbit
const passive = entities.find(e => 
  e.type === 'mob' && 
  ['chicken', 'pig', 'cow', 'sheep', 'rabbit'].includes(e.kind)
);

if (passive) {
  await helpers.gotoXYZ(passive.pos.x, passive.pos.y, passive.pos.z, 2);
  await helpers.attack(passive);
  // Wait a moment for drops to appear
  await new Promise(r => setTimeout(r, 1000));
  return { status: 'hunted', mob: passive.kind };
}

// Secondary: Search for tall grass to get seeds
log('No mobs found. Searching for tall grass...');
const grasses = helpers.findBlocks('tall_grass', 5, 10);
if (grasses.length > 0) {
  // Go to the nearest one
  const target = grasses[0];
  await helpers.gotoXYZ(target.x, target.y, target.z, 1);
  const block = bot.blockAt(target);
  if (block) {
    await helpers.dig(block);
    await helpers.collectBlock('wheat_seeds', 5);
    return { status: 'found_seeds', count: 5 };
  }
}

// If still nothing, try breaking short grass nearby
const shortGrasses = helpers.findBlocks('short_grass', 10, 8);
if (shortGrasses.length > 0) {
  for (const pos of shortGrasses) {
    await helpers.gotoXYZ(pos.x, pos.y, pos.z, 1);
    const block = bot.blockAt(pos);
    if (block && block.name === 'short_grass') {
      await helpers.dig(block);
      await helpers.collectBlock('wheat_seeds', 5);
      if (helpers.invCount('wheat_seeds') > 0) {
        return { status: 'found_seeds_from_short_grass', count: helpers.invCount('wheat_seeds') };
      }
    }
  }
}

return { status: 'no_food_or_seeds_found' };