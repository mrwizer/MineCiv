// 1. Craft planks from logs
const planksNeeded = 3; // 1 for planks, 8 for chest? No, chest is 8 planks.
// We have 1 plank. Need 7 more. 1 log = 4 planks. Need 2 logs -> 8 planks.
// Total planks will be 1 + 8 = 9.
const logsNeeded = 2;
const currentLogs = helpers.invCount('oak_log');
if (currentLogs < logsNeeded) {
  const gatherRes = await helpers.collectAnyLog(logsNeeded - currentLogs);
  if (!gatherRes || gatherRes.collected < logsNeeded - currentLogs) {
    return { error: "Failed to gather logs" };
  }
}

// Craft planks (we have 5 logs, need to make at least 7 planks total, have 1, so make 7+ more. Let's make 8 from 2 logs)
const craftPlanksRes = await helpers.craftItem('oak_planks', 8);
if (!craftPlanksRes || !craftPlanksRes.ok) {
  return { error: "Crafting planks failed", reason: craftPlanksRes.reason };
}

// 2. Craft sticks
// Chest needs 8 planks. We have 1 + 8 = 9 planks. Enough for chest.
// Sticks are needed for many things, but chest only needs planks.
// Wait, the task says "craft a chest using the planks and sticks".
// Actually, a chest recipe is:
// [Plank Plank Plank]
// [Plank       Plank]
// [Plank Plank Plank]
// It does NOT require sticks. The prompt might be misleading or referring to a crafting table?
// "Craft planks from oak logs, then craft a chest using the planks and sticks."
// Standard Minecraft chest does not use sticks. Crafting table uses planks.
// However, if the prompt insists on sticks, maybe it implies making a crafting table first?
// But the goal is just "a chest is in inventory".
// Let's assume the prompt is slightly inaccurate about sticks for the chest itself, or maybe it wants me to craft a crafting table first to ensure crafting works?
// No, craftItem handles tables.
// Let's just craft the chest. It only needs planks.
// But wait, if I don't have sticks, maybe I should get them just in case?
// The prompt says "using the planks and sticks". This is a strong hint.
// Is there a chest variant that uses sticks? No.
// Maybe it means "Craft a crafting table (using planks) and then a chest"?
// Or maybe it's a trick and I should just craft the chest.
// Let's look at the inventory: I have 2 sticks.
// I will proceed to craft the chest. If it fails due to missing sticks (which it shouldn't), I'll handle it.
// Actually, let's re-read carefully: "craft a chest using the planks and sticks".
// This is likely a hallucination in the prompt or a confusion with Crafting Table.
// I will craft the chest. If it fails, I'll check.
// But wait, if I craft a crafting table first, I use 4 planks.
// Then I craft a chest with 8 planks.
// Let's just try to craft the chest directly.

const chestRes = await helpers.craftItem('chest', 1);
if (!chestRes || !chestRes.ok) {
  // If it fails, maybe it wanted a crafting table?
  // Let's try crafting a crafting table first, then chest.
  const tableRes = await helpers.craftItem('crafting_table', 1);
  if (!tableRes || !tableRes.ok) {
     return { error: "Failed to craft table or chest", reason: tableRes.reason };
  }
  // Now try chest again
  const chestRes2 = await helpers.craftItem('chest', 1);
  if (!chestRes2 || !chestRes2.ok) {
    return { error: "Failed to craft chest after table", reason: chestRes2.reason };
  }
  return { crafted: 'chest', count: 1, table: true };
}

return { crafted: 'chest', count: 1 };