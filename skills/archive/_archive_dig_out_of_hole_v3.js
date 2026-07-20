log('dig_out_of_hole: starting escape');
// 1. Primary escape: getUnstuck handles pits, caves, and general stuck states.
const u = await helpers.getUnstuck();
if (u.ok) {
  log('dig_out_of_hole: escaped via getUnstuck');
  return { status: 'escaped', method: 'getUnstuck' };
}

// 2. Secondary escape: escapeToSurface handles being buried underground (pillar/dig up).
// This is safer than manual digging for vertical shafts.
const s = await helpers.escapeToSurface();
if (s.ok) {
  log('dig_out_of_hole: escaped via escapeToSurface');
  return { status: 'escaped', method: 'escapeToSurface' };
}

// 3. Last resort: Manual dig if helpers fail (e.g., specific block obstruction).
// Only dig blocks directly above to avoid falling into a new hole.
const pos = bot.entity.position;
const blockAbove = await bot.blockAt(new Vec3(pos.x, pos.y + 1, pos.z));
if (blockAbove && blockAbove.name !== 'air' && blockAbove.name !== 'cave_air') {
  try {
    await helpers.equipBestToolFor(blockAbove);
    await helpers.dig(blockAbove);
    // Try to move up after digging
    await helpers.gotoXYZ(pos.x, pos.y + 1, pos.z, 0);
  } catch (e) {
    log(`dig_out_of_hole: manual dig failed: ${e.message}`);
  }
}

// 4. Final verification
if (!helpers.mobility().likelyStuckInHole) {
  return { status: 'escaped', method: 'manual' };
}

return { status: 'still_stuck', reason: 'all methods failed' };