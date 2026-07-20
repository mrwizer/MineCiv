// 1. Safety & Prep
if (helpers.mobility().likelyStuckInHole || helpers.mobility().surroundedAtFeet >= 3) {
  await helpers.getUnstuck();
}
await helpers.eat();

// 2. Locate Passive Mob
const mobs = await helpers.nearbyEntities(16);
const passive = mobs.filter(m => ['chicken', 'cow', 'pig'].includes(m.kind) && m.pos);

if (passive.length === 0) {
  log('No passive mobs found. Exploring...');
  await helpers.exploreFor('passive_mob');
  return { status: 'exploring', message: 'No mobs found, explored area' };
}

// 3. Select Target & Verify
const target = passive[0];
const meatType = target.kind === 'chicken' ? 'chicken' : target.kind === 'pig' ? 'porkchop' : 'beef';
const meatName = 'raw_' + meatType;

// 4. Path & Attack
try {
  await helpers.gotoXYZ(target.pos.x, target.pos.y, target.pos.z, 2);
  await helpers.attack(target);
} catch (e) {
  log(`Attack failed: ${e.message}`);
  return { status: 'failed', reason: 'Attack interrupted' };
}

// 5. Verify Drop
if (!helpers.hasItem(meatName)) {
  log(`Waiting for drop...`);
  await new Promise(r => setTimeout(r, 1500));
  if (!helpers.hasItem(meatName)) {
    return { status: 'failed', reason: 'Meat not collected' };
  }
}

// 6. Deposit
log(`Depositing ${meatName}...`);
const depResult = await helpers.depositToChest([{ name: meatName }]);
if (depResult.ok) {
  return { status: 'success', meat: meatName };
}
return { status: 'deposit_failed', reason: depResult.reason };