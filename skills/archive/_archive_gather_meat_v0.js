const mobs = await helpers.nearbyEntities(16);
const passive = mobs.filter(m => ['chicken', 'cow', 'pig'].includes(m.kind));

if (passive.length > 0) {
  const target = passive[0];
  await helpers.gotoXYZ(target.pos.x, target.pos.y, target.pos.z, 2);
  await helpers.attack(target);
  
  const meatType = target.kind === 'chicken' ? 'chicken' : target.kind === 'pig' ? 'porkchop' : 'beef';
  const meatName = 'raw_' + meatType;
  
  // Ensure we are near the target chest to deposit
  await helpers.gotoXYZ(-117, 66, -91, 3);
  
  // Deposit the meat. helpers.depositToChest handles finding the chest.
  // Since we are close to the specific chest, it should prioritize it or we can rely on nearest.
  const depResult = await helpers.depositToChest([{ name: meatName }]);
  
  if (depResult.ok) {
    return { status: 'success', meat: meatName };
  } else {
    // Fallback: try to manually place if deposit fails? No, just report.
    return { status: 'deposit_failed', reason: depResult.reason };
  }
} else {
  log('No passive mobs found nearby. Waiting 10s.');
  await new Promise(r => setTimeout(r, 10000));
  return { status: 'waiting', message: 'No mobs found, waited 10s' };
}