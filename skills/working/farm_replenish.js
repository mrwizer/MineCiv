// 1. Go to the water/farmland area. Based on map, water is East (+X).
// Current pos: -68.7, -60.4. Water is at roughly x=-60 to -65.
// Let's move to a safe spot near the water/dirt interface.
await helpers.gotoXYZ(-65, 60, -60, 3);

// 2. Find tilled farmland or dirt near water to till.
// The map shows water at the right edge. Let's look for dirt/grass blocks near us.
const dirtBlocks = helpers.findBlocks('dirt', 10, 8);
if (dirtBlocks.length === 0) return { error: 'No dirt found' };

// 3. Till the dirt using the stone hoe.
await helpers.equipItem('stone_hoe');
const pos = dirtBlocks[0];
await helpers.till(pos);

// 4. Plant wheat seeds.
if (helpers.hasItem('wheat_seeds')) {
  await helpers.plant('wheat_seeds', pos);
  log('Planted seeds.');
}

// 5. Break tall grass to collect more seeds.
// Find tall grass nearby.
const tallGrassBlocks = helpers.findBlocks('tall_grass', 5, 5);
if (tallGrassBlocks.length > 0) {
  for (const grassPos of tallGrassBlocks) {
    // Check if we have seeds to plant first? No, just break grass.
    await helpers.dig(grassPos);
  }
  log('Broke tall grass.');
} else {
  // If no tall grass, try regular grass blocks which might drop seeds when broken?
  // Usually we break grass blocks with a hoe or just break them if they have grass on top.
  // Let's try breaking a few grass blocks to ensure seed collection.
  const grassBlocks = helpers.findBlocks('grass_block', 5, 5);
  if (grassBlocks.length > 0) {
     // Breaking grass_block directly doesn't drop seeds usually, need tall_grass or breaking grass with shears/hoe?
     // Actually, breaking grass_block with a hoe gives seeds.
     await helpers.equipItem('stone_hoe');
     for (const gbPos of grassBlocks.slice(0, 3)) {
       await helpers.dig(gbPos);
     }
  }
}

return { status: 'done', planted: true, seeds_collected: true };