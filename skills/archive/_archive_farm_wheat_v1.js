// 1. Ensure we have seeds. If not, collect from tall grass first.
const hasSeeds = helpers.hasItem('wheat_seeds');
if (!hasSeeds) {
  const grass = helpers.findBlocks('tall_grass', 10, 5);
  if (grass.length > 0) {
    await helpers.equipItem('hand');
    for (const pos of grass) {
      await helpers.dig(pos);
    }
    await helpers.collectBlock('wheat_seeds', 1, 5);
  }
}

// 2. If still no seeds, fail gracefully.
if (!helpers.hasItem('wheat_seeds')) {
  return { error: 'No seeds found or collected' };
}

// 3. Find water to ensure farmland hydration. Water is East.
await helpers.gotoXYZ(-65, 63, -62, 3);

// 4. Find dirt and till it.
const dirtBlocks = helpers.findBlocks('dirt', 10, 8);
if (dirtBlocks.length === 0) return { error: 'No dirt found' };

await helpers.equipItem('wooden_hoe');
const tilledPositions = [];
for (const pos of dirtBlocks.slice(0, 5)) {
  // Check if already tilled or if dig fails
  const result = await helpers.till(pos);
  if (result) tilledPositions.push(pos);
}

if (tilledPositions.length === 0) return { error: 'Failed to till dirt' };

// 5. Plant seeds.
await helpers.equipItem('wheat_seeds');
let plantedCount = 0;
for (const pos of tilledPositions) {
  const result = await helpers.plant('wheat_seeds', pos);
  if (result) plantedCount++;
}

return { status: 'done', planted: plantedCount, tilled: tilledPositions.length };