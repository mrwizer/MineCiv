if (helpers.mobility().likelyStuckInHole || helpers.mobility().surroundedAtFeet >= 3) {
  await helpers.getUnstuck();
}

const mobs = await helpers.nearbyEntities(16);
const passive = mobs.filter(m => ['chicken', 'cow', 'pig'].includes(m.kind) && m.pos);
if (passive.length === 0) {
  log('No passive mobs found. Exploring...');
  await helpers.exploreFor('passive_mob');
  return { status: 'exploring', message: 'No mobs found, explored area' };
}

const target = passive[0];
const meatType = target.kind === 'chicken' ? 'chicken' : target.kind === 'pig' ? 'porkchop' : 'beef';
const meatName = 'raw_' + meatType;

log(`Hunting ${target.kind}...`);
try {
  await helpers.gotoXYZ(target.pos.x, target.pos.y, target.pos.z, 2);
  await helpers.attack(target);
} catch (e) {
  log(`Attack failed: ${e.message}`);
  return { status: 'failed', reason: 'Attack interrupted' };
}

if (!helpers.hasItem(meatName)) {
  log(`Did not get ${meatName}. Checking inventory...`);
  // Sometimes drop is delayed or missed
  return { status: 'failed', reason: 'Meat not in inventory after attack' };
}

log(`Depositing ${meatName}...`);
const depResult = await helpers.depositToChest([{ name: meatName }]);
if (depResult.ok) {
  return { status: 'success', meat: meatName };
}
return { status: 'deposit_failed', reason: depResult.reason };