const mobs = await helpers.nearbyEntities(16);
const passive = mobs.filter(m => ['chicken', 'cow', 'pig'].includes(m.kind));

if (passive.length === 0) {
  log('No passive mobs found. Exploring...');
  await helpers.exploreFor('passive_mob');
  return { status: 'exploring', message: 'No mobs found, explored area' };
}

const target = passive[0];
const meatType = target.kind === 'chicken' ? 'chicken' : target.kind === 'pig' ? 'porkchop' : 'beef';
const meatName = 'raw_' + meatType;

log(`Hunting ${target.kind}...`);
await helpers.gotoXYZ(target.pos.x, target.pos.y, target.pos.z, 2);
await helpers.attack(target);

if (!helpers.hasItem(meatName)) {
  return { status: 'failed', reason: 'Did not pick up meat' };
}

log(`Depositing ${meatName}...`);
const depResult = await helpers.depositToChest([{ name: meatName }]);

if (depResult.ok) {
  return { status: 'success', meat: meatName };
}
return { status: 'deposit_failed', reason: depResult.reason };