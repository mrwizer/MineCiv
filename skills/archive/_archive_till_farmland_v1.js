// Goal: Till dirt near water at (-84, 64, -80).
await helpers.gotoXYZ(-84, 64, -80, 1);

// Verify we are adjacent to water or in it
const waterPos = new Vec3(-84, 64, -80);
const myPos = bot.entity.position;
const dist = myPos.distanceTo(waterPos);
if (dist > 1.5) {
  return { error: 'Failed to reach water' };
}

// Find dirt/grass adjacent to water
const waterBlocks = helpers.findBlocks('water', 10, 2);
const dirtBlocks = helpers.findBlocks('dirt', 10, 2);
const grassBlocks = helpers.findBlocks('grass_block', 10, 2);

let targets = [...dirtBlocks, ...grassBlocks];

// Filter for blocks adjacent to ANY water block found
const adjacentTargets = targets.filter(block => {
  return waterBlocks.some(w => {
    const dx = Math.abs(block.x - w.x);
    const dy = Math.abs(block.y - w.y);
    const dz = Math.abs(block.z - w.z);
    return dx <= 1 && dy <= 1 && dz <= 1 && (dx + dy + dz) > 0;
  });
});

if (adjacentTargets.length === 0) {
  return { error: 'No dirt/grass adjacent to water found' };
}

// Equip stone hoe
await helpers.equipItem('stone_hoe');

// Till the first target
const target = adjacentTargets[0];
await helpers.till(target);

return { tilled: target, waterSource: waterPos };