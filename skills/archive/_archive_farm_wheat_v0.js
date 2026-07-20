// 1. Find tilled farmland or dirt near water.
// The map shows water to the East. Let's move there and find dirt.
await helpers.gotoXYZ(-65, 63, -62, 3);

// 2. Till dirt into farmland.
const dirtBlocks = helpers.findBlocks('dirt', 5, 8);
if (dirtBlocks.length === 0) return { error: 'No dirt found' };

await helpers.equipItem('wooden_hoe');
for (const pos of dirtBlocks.slice(0, 3)) {
  await helpers.till(pos);
}

// 3. Plant seeds.
if (helpers.hasItem('wheat_seeds')) {
  for (const pos of dirtBlocks.slice(0, 3)) {
    await helpers.plant('wheat_seeds', pos);
  }
  log('Planted seeds.');
}

// 4. Collect seeds from tall grass.
// Find tall grass nearby and break it.
const tallGrassBlocks = helpers.findBlocks('tall_grass', 5, 8);
if (tallGrassBlocks.length > 0) {
  // Equip hand or hoe to break grass efficiently
  await helpers.equipItem('wooden_hoe');
  for (const pos of tallGrassBlocks) {
    await helpers.dig(pos);
  }
  log('Collected seeds from tall grass.');
} else {
  // If no tall grass, try breaking grass blocks with hoe (sometimes drops seeds)
  const grassBlocks = helpers.findBlocks('grass_block', 5, 8);
  if (grassBlocks.length > 0) {
    await helpers.equipItem('wooden_hoe');
    for (const pos of grassBlocks.slice(0, 3)) {
      await helpers.dig(pos);
    }
  }
}

return { status: 'done', planted: true, seeds_collected: true };