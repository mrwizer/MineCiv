if (helpers.mobility().likelyStuckInHole || helpers.mobility().surroundedAtFeet >= 3) {
  await helpers.getUnstuck();
}

// 1. Eat if hungry to ensure attack speed/regen
await helpers.eat();

// 2. Find a target
const mobs = await helpers.nearbyEntities(16);
const passive = mobs.filter(m => ['chicken', 'cow', 'pig'].includes(m.kind) && m.pos);

if (passive.length === 0) {
  log('No passive mobs found. Exploring...');
  await helpers.exploreFor('passive_mob');
  return { status: 'exploring', message: 'No mobs found, explored area' };
}

// 3. Select target and determine meat type
const target = passive[0];
const meatType = target.kind === 'chicken' ? 'chicken' : target.kind === 'pig' ? 'porkchop' : 'beef';
const meatName = 'raw_' + meatType;

log(`Hunting ${target.kind}...`);

// 4. Path to target
try {
  await helpers.gotoXYZ(target.pos.x, target.pos.y, target.pos.z, 2);
} catch (e) {
  log(`Path failed: ${e.message}`);
  return { status: 'failed', reason: 'Path failed' };
}

// 5. Attack
try {
  await helpers.attack(target);
} catch (e) {
  log(`Attack failed: ${e.message}`);
  return { status: 'failed', reason: 'Attack interrupted' };
}

// 6. Verify and Deposit
if (!helpers.hasItem(meatName)) {
  log(`Attack succeeded but ${meatName} not found. Waiting for drop...`);
  // Small delay to allow drop entity to appear
  await new Promise(r => setTimeout(r, 1000));
  if (!helpers.hasItem(meatName)) {
     return { status: 'failed', reason: 'Meat not in inventory after attack' };
  }
}

log(`Depositing ${meatName}...`);
const depResult = await helpers.depositToChest([{ name: meatName }]);
if (depResult.ok) {
  return { status: 'success', meat: meatName };
}
return { status: 'deposit_failed', reason: depResult.reason };