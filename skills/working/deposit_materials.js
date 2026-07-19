// 1. Unstuck check
if (helpers.mobility().surroundedAtFeet >= 3 || helpers.mobility().likelyStuckInHole) {
  const unstuck = await helpers.getUnstuck();
  if (!unstuck.ok) return { error: 'Failed to unstuck' };
}

// 2. Navigate to workshop target
const workshopTarget = new Vec3(-80, 65, -82);
const travel = await helpers.gotoXYZ(workshopTarget.x, workshopTarget.y, workshopTarget.z, 2);
if (!travel.ok) return { error: 'Failed to travel to workshop' };

// 3. Deposit items
// The contract is to deposit specific items. If we don't have them, we can't deposit.
// We check inventory freshness before proceeding.
const toDeposit = [
  { name: 'coal', count: 4 },
  { name: 'cobblestone', count: 10 }
];

// Filter out items we don't have
const itemsToDeposit = toDeposit.filter(item => helpers.invCount(item.name) >= item.count);

if (itemsToDeposit.length === 0) {
  return { status: 'no_items_to_deposit', reason: 'Inventory missing required materials' };
}

const deposit = await helpers.depositToChest(itemsToDeposit);
if (!deposit.ok) {
  // If deposit fails, it might be because no chest exists and we don't have one.
  // However, the skill assumes a workshop with storage. We return the error.
  return { error: `Deposit failed: ${deposit.reason || 'Unknown'}` };
}

return { status: 'deposited', items: deposit.deposited, location: 'workshop' };