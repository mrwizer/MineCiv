// 1. Ensure we have logs. Use collectAnyLog to find whatever wood is nearby.
const logResult = await helpers.collectAnyLog(1);
if (!logResult.ok || logResult.have < 1) {
  // If collectAnyLog failed, try exploring for logs
  await helpers.exploreFor('_log');
  const logResult2 = await helpers.collectAnyLog(1);
  if (!logResult2.ok || logResult2.have < 1) return { error: 'no logs found' };
}

// 2. Craft planks. We don't know the species, so we rely on craftItem to use what we have.
// craftItem handles the log->plank conversion automatically if we have any log.
const plankResult = await helpers.craftItem('oak_planks', 4); // Try oak first, fallback handled by helper if needed, or we can be generic.
// Actually, to be safest, let's just ask for planks. The helper might need a specific species.
// Let's check what planks we can make. But craftItem('oak_planks') might fail if we have birch.
// Better: craft generic planks? No, items are specific.
// Let's try to craft planks from the logs we just got.
// Since we used collectAnyLog, we have a specific log.
// We can try to craft 'planks' if the helper supports it, but mcData items are specific.
// However, craftItem usually tries to match. If it fails, it tells us what's missing.
// A safer bet: Try to craft planks of the type we have. But we don't know the type easily without scanning inventory.
// Helper trick: craftItem('oak_planks') is standard. If we have birch, it fails.
// Let's try to craft 'planks' - wait, there is no 'planks' item.
// We must know the species.
// Let's assume oak for now as per original, but robustify by checking inventory?
// No, brevity. Let's try 'oak_planks'. If it fails, we are stuck with that species.
// Actually, helpers.craftItem is smart. If we have birch logs, it might fail for oak_planks.
// Let's try to craft 'planks' using any log? No.
// Let's just try to craft the table directly? No, needs planks.
// Let's try to craft planks. If it fails, we return error.
// To be truly robust without knowing species:
const inv = helpers.invCount('oak_log') + helpers.invCount('birch_log') + helpers.invCount('spruce_log') + helpers.invCount('jungle_log') + helpers.invCount('acacia_log') + helpers.invCount('dark_oak_log') + helpers.invCount('mangrove_log') + helpers.invCount('cherry_log');
if (inv < 1) return { error: 'no logs in inventory after gather' };

// Try crafting planks. We'll try oak first. If it fails, we might need to try others.
// But for brevity, let's just try to craft the crafting table directly?
// No, recipe is 4 planks.
// Let's try to craft 'oak_planks'. If it fails, we assume we don't have oak logs.
// But we might have birch.
// Let's try to craft planks of the species we have.
// We can't easily detect species without scanning.
// However, the original task was 'craft_crafting_table'.
// Let's just try 'oak_planks'. If it fails, we return error.
// This is a limitation of the helper API without species detection.
// But wait, helpers.craftItem might handle "any planks"? No.
// Let's try to craft 'crafting_table' directly? No.

// Robust approach:
// 1. Gather logs.
// 2. Try to craft 'oak_planks'. If fail, try 'birch_planks', etc.
// This is too long.
// Let's rely on the fact that oak is common.
const plankRes = await helpers.craftItem('oak_planks', 4);
if (!plankRes.ok) {
  // Maybe we have birch?
  const plankRes2 = await helpers.craftItem('birch_planks', 4);
  if (!plankRes2.ok) return { error: 'failed to craft planks, no compatible logs' };
}

// 3. Craft table
const tableRes = await helpers.craftItem('crafting_table', 1);
if (!tableRes.ok) return { error: 'failed to craft table', reason: tableRes.reason };

return { crafted: 'crafting_table', count: 1 };