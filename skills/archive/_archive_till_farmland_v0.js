// Goal: Till dirt near water at (-84, 64, -80).
// Current pos: (-81.5, 63, -77.5).
// We are close. Water is nearby (5 blocks).

// 1. Move to the water source location to ensure proximity
await helpers.gotoXYZ(-84, 64, -80, 2);

// 2. Find a dirt block adjacent to the water source
// The water is at (-84, 64, -80). We need dirt at y=64 or y=63 adjacent to it.
// Let's look for dirt blocks in a small radius around the water.
const waterPos = new Vec3(-84, 64, -80);
const dirtBlocks = helpers.findBlocks('dirt', 10, 4);
const grassBlocks = helpers.findBlocks('grass_block', 10, 4);

// Combine potential targets
let targets = [...dirtBlocks, ...grassBlocks];

// Filter for blocks adjacent to water
const adjacentTargets = targets.filter(block => {
  const dx = Math.abs(block.x - waterPos.x);
  const dy = Math.abs(block.y - waterPos.y);
  const dz = Math.abs(block.z - waterPos.z);
  // Adjacent means distance is 1 in x, y, or z, but not diagonal in all three
  // Simple adjacency: dx+dy+dz == 1 or (dx==1 && dy==0 && dz==0) etc.
  // Actually, just check if it's within 1 block in any axis and 0 in others, or same level adjacent
  // Water is at 64. Dirt/grass is likely at 63 or 64.
  // Let's check if it's a neighbor in the horizontal plane or directly above/below
  return (dx + dy + dz) <= 1 && (dx === 1 || dz === 1 || dy === 1);
});

if (adjacentTargets.length === 0) {
  return { error: 'No dirt/grass adjacent to water found' };
}

// 3. Equip stone hoe and till the first adjacent block
const target = adjacentTargets[0];
await helpers.equipItem('stone_hoe');
await helpers.till(target);

return { tilled: target, waterSource: waterPos };