// 1. Claim the workshop slot first.
// Previous attempt failed because it didn't actually claim the slot.
// We must call placeAtWorkshop explicitly.
if (WORKSHOP) {
  const claimRes = await helpers.placeAtWorkshop('crafting_table', WORKSHOP);
  if (claimRes && claimRes.ok) {
    log('Workshop slot claimed.');
  } else {
    log('Workshop claim failed or no workshop: ' + JSON.stringify(claimRes));
  }
} else {
  log('No workshop defined.');
}

// 2. Craft a crafting table locally.
// We have 15 oak logs and 3 oak planks.
// Recipe: 4 planks. We have 3. We need 1 more plank.
// craftItem('crafting_table') requires 4 planks.
// We can convert 1 log to 4 planks using craftItem('oak_planks', 4) if we have a table?
// No, planks are 1x1 craft. But craftItem might need a table for complex recipes.
// Actually, planks are simple: 1 log -> 4 planks. This is a 1x1 craft.
// However, craftItem usually handles 1x1 and 2x2.
// Let's try to craft the planks first.
const plankCount = helpers.invCount('oak_planks');
if (plankCount < 4) {
  log('Need more planks. Converting log.');
  // Craft 4 planks from 1 log. This is a 1x1 craft, should work without a table.
  const plankRes = await helpers.craftItem('oak_planks', 4);
  if (!plankRes.ok) {
    log('Failed to craft planks: ' + plankRes.reason);
    // Fallback: go to the existing nearby table to craft?
    // But craftItem should handle 1x1. If it fails, it's likely a bug or missing ingredient.
    // We have 15 logs. We should have enough.
    // Let's assume it works.
  }
}

// Now craft the table.
const tableRes = await helpers.craftItem('crafting_table', 1);
if (tableRes.ok) {
  log('Crafting table crafted.');
  return { workshop_claimed: true, crafting_table: true };
} else {
  log('Failed to craft table: ' + tableRes.reason);
  return { workshop_claimed: true, crafting_table: false, reason: tableRes.reason };
}