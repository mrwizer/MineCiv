// 1. Mine cobblestone using the existing wooden pickaxe.
// acquireStone handles finding exposed stone, equipping the tool, and mining.
const stoneResult = await helpers.acquireStone(4);

if (!stoneResult.ok && stoneResult.status === 'need_tool') {
  // Wooden pickaxe might be too weak or broken? Try crafting stone pick first if we have stone.
  // But usually wooden works for cobblestone. If it failed due to tool durability/level:
  // We have sticks. Let's try to craft a stone pickaxe directly if we have stone.
  // However, acquireStone failed, so we might not have stone yet.
  // Let's assume wooden pickaxe is fine but maybe we need to dig down if 'all_buried'.
  if (stoneResult.status === 'all_buried' || stoneResult.status === 'no_stone_here') {
    await helpers.digStaircaseDown(5);
    await helpers.acquireStone(4); // Retry after digging down
  } else {
    log("Failed to acquire stone: " + stoneResult.status);
    return { error: "Could not mine cobblestone" };
  }
}

// Check if we have stone now
if (helpers.invCount('cobblestone') < 3) {
  // If still not enough, try one more time or dig deeper
  await helpers.acquireStone(4);
}

// 2. Craft a stone pickaxe.
// Recipe: 3 cobblestone, 2 sticks.
// We have sticks (2) and hopefully cobblestone now.
const craftResult = await helpers.craftItem('stone_pickaxe', 1);

if (craftResult.ok) {
  return { success: true, item: 'stone_pickaxe' };
} else {
  log("Crafting failed: " + craftResult.reason);
  // Check if we have the materials
  const hasCobble = helpers.invCount('cobblestone');
  const hasSticks = helpers.invCount('stick');
  log(`Inventory check: Cobblestone=${hasCobble}, Sticks=${hasSticks}`);
  return { error: "Crafting failed", reason: craftResult.reason };
}