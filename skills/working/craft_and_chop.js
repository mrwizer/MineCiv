// 1. Go to crafting table
await helpers.gotoXYZ(-87, 65, -81, 2);

// 2. Craft stone axe
// Recipe: 3 cobblestone + 2 sticks. We have 1 cobblestone. We need more.
// Check if we have enough cobblestone. If not, acquire more.
let cobbleCount = helpers.invCount('cobblestone');
if (cobbleCount < 3) {
  log(`Need more cobblestone. Have ${cobbleCount}, need 3.`);
  // Try to acquire more cobblestone
  const stoneResult = await helpers.acquireStone(3 - cobbleCount);
  if (!stoneResult.ok) {
    log("Failed to acquire more cobblestone.");
    return { error: 'Could not craft stone axe due to lack of materials' };
  }
}

// Now craft the axe
const craftResult = await helpers.craftItem('stone_axe', 1);
if (!craftResult.ok) {
  log(`Crafting failed: ${craftResult.reason}`);
  return { error: 'Crafting failed' };
}
log("Crafted stone axe.");

// 3. Equip stone axe
await helpers.equipItem('stone_axe');

// 4. Collect wood logs
// Use collectAnyLog to find and chop the nearest tree
const logResult = await helpers.collectAnyLog(5);
if (logResult && logResult.ok) {
  log(`Collected ${logResult.collected} logs.`);
  // Check for dropped items (apples/seeds) implicitly handled by collectAnyLog if it picks them up,
  // but let's explicitly check inventory for apples/seeds if we chopped leaves.
  // collectAnyLog usually handles picking up drops if they are within range.
  return { collected: 'wood_log', count: logResult.collected, tool: 'stone_axe' };
} else {
  log("Failed to collect logs.");
  return { error: 'Could not collect wood logs' };
}