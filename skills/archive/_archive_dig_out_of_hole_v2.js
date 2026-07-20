log('dig_out_of_hole: starting escape');
// 1. Immediate unstuck attempt
const u = await helpers.getUnstuck();
if (u.ok) {
  log('dig_out_of_hole: escaped via getUnstuck');
  return { status: 'escaped', method: 'getUnstuck' };
}

// 2. If getUnstuck failed, we are likely buried or in a tight 1x1 hole.
// Use the specialized escape-to-surface helper which handles pillar-up/dig-up loops safely.
const s = await helpers.escapeToSurface();
if (s.ok) {
  log('dig_out_of_hole: escaped via escapeToSurface');
  return { status: 'escaped', method: 'escapeToSurface' };
}

// 3. Last resort: manual dig if helpers fail (rare, but handles specific stuck states)
log('dig_out_of_hole: manual dig attempt');
const blockAbove = await bot.blockAt(new Vec3(bot.entity.position.x, bot.entity.position.y + 1, bot.entity.position.z));
if (blockAbove && blockAbove.name !== 'air' && blockAbove.name !== 'cave_air') {
  // Verify tool is appropriate
  await helpers.equipBestToolFor(blockAbove);
  await helpers.dig(blockAbove);
  // Try to move up
  await helpers.gotoXYZ(bot.entity.position.x, bot.entity.position.y + 1, bot.entity.position.z, 0);
}

// 4. Final check
if (!helpers.mobility().likelyStuckInHole) {
  return { status: 'escaped', method: 'manual' };
}

return { status: 'still_stuck', reason: 'helpers failed and manual dig insufficient' };