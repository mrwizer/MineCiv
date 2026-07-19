// I have oak logs. I need planks first to make a crafting table.
// Recipe: 4 planks -> 1 crafting table.
// I have 5 oak logs. 1 log = 4 planks. I have enough for 1 table (needs 4 planks, which is 1 log).

const logCount = helpers.invCount('oak_log');
if (logCount < 1) {
  return { error: 'no oak logs' };
}

// Craft planks from oak logs
const plankResult = await helpers.craftItem('oak_planks', 4);
if (!plankResult.ok) {
  return { error: 'failed to craft planks', reason: plankResult.reason };
}

// Craft crafting table from oak planks
const tableResult = await helpers.craftItem('crafting_table', 1);
if (!tableResult.ok) {
  return { error: 'failed to craft table', reason: tableResult.reason };
}

return { crafted: 'crafting_table', count: 1 };