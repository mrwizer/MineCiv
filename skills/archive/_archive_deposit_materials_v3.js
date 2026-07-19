// 1. Unstuck check
if (helpers.mobility().surroundedAtFeet >= 3 || helpers.mobility().likelyStuckInHole) {
  const unstuck = await helpers.getUnstuck();
  if (!unstuck.ok) return { error: 'Failed to unstuck' };
}

// 2. Navigate to workshop target
// Use the provided WORKSHOP object if available, otherwise fallback to hardcoded coords
const target = WORKSHOP || new Vec3(-80, 65, -82);
const travel = await helpers.gotoXYZ(target.x, target.y, target.z, 2);
if (!travel.ok) return { error: 'Failed to travel to workshop' };

// 3. Deposit items
// Check if we have items to deposit
const toDeposit = [
  { name: 'coal', count: 4 },
  { name: 'cobblestone', count: 10 }
];

const itemsToDeposit = toDeposit.filter(item => helpers.invCount(item.name) >= item.count);

if (itemsToDeposit.length === 0) {
  return { status: 'no_items_to_deposit', reason: 'Inventory missing required materials' };
}

// Deposit to chest at workshop
const deposit = await helpers.depositToChest(itemsToDeposit);
if (!deposit.ok) {
  // If no chest exists, we might need to place one, but depositToChest usually handles finding/placing.
  // If it fails, we return the error.
  return { error: `Deposit failed: ${deposit.reason || 'Unknown'}` };
}

return { status: 'deposited', items: deposit.deposited, location: 'workshop' };