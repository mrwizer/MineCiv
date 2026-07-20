// 1. Go to crafting table
await helpers.gotoXYZ(-87, 65, -81, 2);

// 2. Craft wooden hoe
// Recipe: 2 planks + 2 sticks. We have 1 plank and 1 stick.
// We need to craft planks from logs first, or just craft a stick if we had more logs.
// Actually, let's check inventory. We have 9 oak_log, 1 oak_planks, 1 stick.
// We need 2 planks and 2 sticks.
// Step 2a: Craft planks from logs (we have 9 logs, need 2 planks -> 1 log makes 4 planks)
await helpers.craftItem('oak_planks', 1);

// Step 2b: Craft sticks (2 planks make 4 sticks, we have 1 plank now + 1 original = 2 planks? 
// Wait, we had 1 plank. Crafted 1 more -> 2 planks. 
// 2 planks -> 4 sticks. We need 2 sticks.
await helpers.craftItem('stick', 2);

// Step 2c: Craft wooden hoe (2 planks, 2 sticks)
// We have 2 planks and 4 sticks.
await helpers.craftItem('wooden_hoe', 1);

// 3. Till dirt near water
// Find water block
const waterBlocks = helpers.findBlocks('water', 1, 10);
if (waterBlocks.length === 0) {
  return { error: 'Water not found' };
}
const waterPos = waterBlocks[0];

// Find a nearby dirt block to till (within 2 blocks of water)
// We'll just search around the water source
const dirtBlocks = helpers.findBlocks('dirt', 10, 5);
if (dirtBlocks.length === 0) {
  return { error: 'No dirt found near water' };
}

// Till the first dirt block found near water
const dirtPos = dirtBlocks[0];
await helpers.till(dirtPos);

return { crafted: 'wooden_hoe', tilled: dirtPos };