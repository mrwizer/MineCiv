log("Checking inventory...");
const hasPickaxe = helpers.hasItem('wooden_pickaxe');
const hasSword = helpers.hasItem('wooden_sword');

if (hasPickaxe && hasSword) {
  return { success: true, items: ['wooden_pickaxe', 'wooden_sword'] };
}

log("Gathering wood...");
// We have 3 oak logs. A pickaxe needs 3 planks (1 log) and a sword needs 2 planks (1 log).
// Total 2 logs needed. We have 3. Should be enough.
// However, collectAnyLog is safer to ensure we have the specific type if we had none.
// But we have oak_log. Let's try to craft directly first.
// If craft fails due to missing planks/sticks, we gather.

// Check for sticks
const sticks = helpers.invCount('stick');
log(`Sticks: ${sticks}`);

// If we don't have sticks, we need to craft them from planks, or just rely on craftItem
// craftItem handles the sub-recipes (planks from log, sticks from planks) automatically if a crafting table is available.
// But wait, craftItem needs a crafting table. helpers.craftItem places one if needed.

const neededPickaxe = !hasPickaxe;
const neededSword = !hasSword;

if (neededPickaxe || neededSword) {
  log("Crafting items...");
  
  // Craft pickaxe if needed
  if (neededPickaxe) {
    const res1 = await helpers.craftItem('wooden_pickaxe', 1);
    if (!res1.ok) {
      log(`Pickaxe craft failed: ${res1.reason}`);
      // Try to gather more wood if it failed due to logs
      if (res1.reason.includes('oak_log') || res1.reason.includes('planks')) {
         log("Gathering more wood...");
         await helpers.collectAnyLog(5);
         // Retry
         const res1b = await helpers.craftItem('wooden_pickaxe', 1);
         if (!res1b.ok) log(`Pickaxe craft still failed: ${res1b.reason}`);
      }
    }
  }

  // Craft sword if needed
  if (neededSword) {
    const res2 = await helpers.craftItem('wooden_sword', 1);
    if (!res2.ok) {
      log(`Sword craft failed: ${res2.reason}`);
      if (res2.reason.includes('oak_log') || res2.reason.includes('planks')) {
         log("Gathering more wood...");
         await helpers.collectAnyLog(5);
         // Retry
         const res2b = await helpers.craftItem('wooden_sword', 1);
         if (!res2b.ok) log(`Sword craft still failed: ${res2b.reason}`);
      }
    }
  }
}

return {
  has_pickaxe: helpers.hasItem('wooden_pickaxe'),
  has_sword: helpers.hasItem('wooden_sword')
};