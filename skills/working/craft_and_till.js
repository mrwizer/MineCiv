// 1. Gather resources: Get any logs, convert to planks/sticks, craft hoe
const logs = await helpers.collectAnyLog(2);
if (!logs.ok || logs.collected < 1) return { error: 'No logs found' };

// Craft planks (auto-handles species)
const planks = await helpers.craftItem(anyPlanksInInventory() || 'planks', 2);
if (!planks.ok) return { error: 'Failed to craft planks' };

// Craft sticks (2 planks -> 4 sticks)
const sticks = await helpers.craftItem('stick', 2);
if (!sticks.ok) return { error: 'Failed to craft sticks' };

// Craft wooden hoe
const hoe = await helpers.craftItem('wooden_hoe', 1);
if (!hoe.ok) return { error: 'Failed to craft hoe' };

// Equip hoe
await helpers.equipItem('wooden_hoe');

// 2. Find and till dirt
// Locate water first to ensure valid farming spot
const waterBlocks = helpers.findBlocks('water', 1, 10);
if (waterBlocks.length === 0) return { error: 'No water nearby' };

// Find dirt near water
const dirtBlocks = helpers.findBlocks('dirt', 1, 5);
if (dirtBlocks.length === 0) return { error: 'No dirt near water' };

const targetDirt = dirtBlocks[0];
await helpers.gotoXYZ(targetDirt.x, targetDirt.y, targetDirt.z, 1);
await helpers.till(targetDirt);

return { crafted: 'wooden_hoe', tilled: targetDirt };