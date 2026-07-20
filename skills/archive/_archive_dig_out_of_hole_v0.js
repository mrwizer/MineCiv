// Previous attempts failed because getUnstuck() timed out or failed to pathfind.
// We are at y=67. Surface is at y=67.
// Mobility: likelyStuckInHole=true, blockedSidesAtHead=[N,E,W].
// This implies we are in a hole. The "hole" might be a 1-block deep pit or a tunnel.
// Since getUnstuck failed, we need to manually break out.
// We have dirt in inventory. We can pillar up or dig out.
// Let's try to dig the block above us if it's not air.
// Then pillar up if needed.
// But first, let's check the block above.
const blockAbove = await bot.blockAt(new Vec3(bot.entity.position.x, bot.entity.position.y + 1, bot.entity.position.z));
if (blockAbove && blockAbove.name !== 'air') {
  // Dig the block above
  await helpers.dig(blockAbove);
  // Now try to move up
  await helpers.gotoXYZ(bot.entity.position.x, bot.entity.position.y + 1, bot.entity.position.z, 0);
  // Check if we are still stuck
  if (helpers.mobility().likelyStuckInHole) {
    // Pillar up to get out
    await helpers.pillarUp(1, 'dirt');
  }
} else {
  // Block above is air. We are in a hole but not buried.
  // Try to move out. We need to find an adjacent air block.
  // Let's try to dig the block at our feet if it's not solid? No, that's dangerous.
  // Let's try to dig the block in front of us if it's a wall.
  // We know N, E, W are blocked at head. South might be open.
  // Let's try to dig the block at (x, y, z+1) (South).
  const blockSouth = await bot.blockAt(new Vec3(bot.entity.position.x, bot.entity.position.y, bot.entity.position.z + 1));
  if (blockSouth && blockSouth.name !== 'air') {
    await helpers.dig(blockSouth);
    await helpers.gotoXYZ(bot.entity.position.x, bot.entity.position.y, bot.entity.position.z + 1, 0);
  } else {
    // South is air. Try to move South.
    await helpers.gotoXYZ(bot.entity.position.x, bot.entity.position.y, bot.entity.position.z + 1, 0);
  }
}
// Verify we are out
if (!helpers.mobility().likelyStuckInHole) {
  return { status: 'escaped' };
}
// If still stuck, try getUnstuck again as a last resort
const unstuck = await helpers.getUnstuck();
if (unstuck.ok) {
  return { status: 'escaped', method: 'getUnstuck' };
}
return { status: 'still_stuck' };