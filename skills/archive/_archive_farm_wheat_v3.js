await helpers.eat();
if (helpers.mobility().likelyStuckInHole) await helpers.getUnstuck();

// 1. Ensure seeds
if (!helpers.hasItem('wheat_seeds')) {
  const grass = helpers.findBlocks('tall_grass', 10, 8);
  if (grass.length > 0) {
    await helpers.gotoXYZ(grass[0].x, grass[0].y, grass[0].z, 2);
    await helpers.collectBlock('wheat_seeds', 1, 5);
  }
}
if (!helpers.hasItem('wheat_seeds')) return { error: 'No seeds found' };

// 2. Navigate to target area
await helpers.gotoXYZ(-84, 64, -80, 5);

// 3. Find and till dirt
const dirtBlocks = helpers.findBlocks('dirt', 10, 6);
if (dirtBlocks.length === 0) return { error: 'No dirt found' };

await helpers.equipItem('wooden_hoe');
const tilled = [];
for (const pos of dirtBlocks) {
  if (pos.distanceTo(bot.entity.position) < 6) {
    const res = await helpers.till(pos);
    if (res) tilled.push(pos);
    if (tilled.length >= 5) break;
  }
}
if (tilled.length === 0) return { error: 'Failed to till' };

// 4. Plant seeds
await helpers.equipItem('wheat_seeds');
let planted = 0;
for (const pos of tilled) {
  const res = await helpers.plant('wheat_seeds', pos);
  if (res) planted++;
}

return { status: 'done', planted, tilled: tilled.length };