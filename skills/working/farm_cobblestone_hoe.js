// 1. Go to crafting table
await helpers.gotoXYZ(-87, 65, -81, 2);

// 2. Craft Stone Hoe
// Recipe: 2 Cobblestone + 2 Sticks.
// We have 11 sticks. We need cobblestone.
// Check if we have cobblestone.
if (helpers.invCount('cobblestone') < 2) {
  // Acquire cobblestone
  const stoneRes = await helpers.acquireStone(2);
  if (!stoneRes.ok || stoneRes.collected < 2) {
    return { error: 'Failed to get cobblestone', status: stoneRes.status };
  }
}

const craftRes = await helpers.craftItem('stone_hoe', 1);
if (!craftRes.ok) {
  return { error: 'Failed to craft stone hoe', reason: craftRes.reason };
}

// 3. Find water and till dirt
const waterBlocks = helpers.findBlocks('water', 1, 10);
if (waterBlocks.length === 0) return { error: 'No water found' };
const waterPos = waterBlocks[0];

// Find dirt near water
const dirtBlocks = helpers.findBlocks('dirt', 10, 5);
if (dirtBlocks.length === 0) return { error: 'No dirt near water' };

// Till one block
const dirtPos = dirtBlocks[0];
await helpers.till(dirtPos);

// 4. Plant seeds
if (helpers.hasItem('wheat_seeds')) {
  await helpers.plant('wheat_seeds', dirtPos);
}

return { crafted: 'stone_hoe', tilled: dirtPos, planted: helpers.hasItem('wheat_seeds') };