// Goal: Till dirt near water at (-84, 64, -80).
await helpers.gotoXYZ(-84, 64, -80, 2);

// Verify presence of water and farmland-able blocks
const waterBlocks = helpers.findBlocks('water', 1, 5);
if (waterBlocks.length === 0) return { error: 'No water found' };

const dirtBlocks = helpers.findBlocks('dirt', 10, 5);
const grassBlocks = helpers.findBlocks('grass_block', 10, 5);
const targets = [...dirtBlocks, ...grassBlocks];

// Find adjacent target
let target = null;
for (const t of targets) {
  if (waterBlocks.some(w => Math.abs(t.x - w.x) <= 1 && Math.abs(t.y - w.y) <= 1 && Math.abs(t.z - w.z) <= 1)) {
    target = t;
    break;
  }
}

if (!target) return { error: 'No dirt/grass adjacent to water' };

// Equip hoe and till
if (!await helpers.equipItem('stone_hoe')) {
  // Fallback: try any hoe
  const hoes = ['stone_hoe', 'iron_hoe', 'wooden_hoe', 'golden_hoe', 'diamond_hoe'];
  for (const h of hoes) {
    if (await helpers.equipItem(h)) break;
  }
}

await helpers.till(target);
return { tilled: target, waterSource: waterBlocks[0] };