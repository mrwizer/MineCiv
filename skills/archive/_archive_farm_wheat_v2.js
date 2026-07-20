// 1. Ensure seeds. If none, collect from tall grass nearby.
if (!helpers.hasItem('wheat_seeds')) {
  const grass = helpers.findBlocks('tall_grass', 5, 8);
  if (grass.length > 0) {
    await helpers.equipItem('hand');
    for (const pos of grass) await helpers.dig(pos);
    await helpers.collectBlock('wheat_seeds', 1, 5);
  }
}
if (!helpers.hasItem('wheat_seeds')) return { error: 'No seeds found' };

// 2. Locate water for hydration. Target area is near (-84, 64, -80).
// Water is typically at y=63 in this biome/area.
await helpers.gotoXYZ(-84, 64, -80, 5);

// 3. Find dirt near the water to till.
const dirtBlocks = helpers.findBlocks('dirt', 8, 6);
if (dirtBlocks.length === 0) return { error: 'No dirt found near water' };

// 4. Till the dirt.
await helpers.equipItem('wooden_hoe');
const tilled = [];
for (const pos of dirtBlocks) {
  // Only till if it's actually dirt (not grass/dirt mix that might be grass)
  // and is close enough.
  if (pos.distanceTo(bot.entity.position) < 5) {
    const res = await helpers.till(pos);
    if (res) tilled.push(pos);
    if (tilled.length >= 5) break; // Limit to 5 blocks to keep it fast
  }
}
if (tilled.length === 0) return { error: 'Failed to till dirt' };

// 5. Plant seeds on tilled farmland.
await helpers.equipItem('wheat_seeds');
let planted = 0;
for (const pos of tilled) {
  const res = await helpers.plant('wheat_seeds', pos);
  if (res) planted++;
}

return { status: 'done', planted, tilled: tilled.length };