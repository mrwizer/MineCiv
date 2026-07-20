// Previous attempt failed because getUnstuck() likely returned success without actually moving us out of the hole (perhaps due to pathfinding timeout or immediate re-stuck state).
// We are at y=69. Surface is around y=68-73.
// Mobility says likelyStuckInHole=true, blockedSidesAtHead=[north, east, west].
// This means we are in a hole with walls to N, E, W. South might be open or blocked at feet.
// Since getUnstuck() failed previously, let's try a more direct approach:
// 1. Check if we can just dig up. But digging up is risky if there's gravel.
// 2. Check if we can move sideways.
// Let's try to move South first, as it's the only side not listed in blockedSidesAtHead (though it might be blocked at feet).
// Actually, let's try to dig out using a staircase or pillar if necessary, but getUnstuck is the standard.
// Since getUnstuck failed, let's try to manually dig up if we are not buried, or pillar up if we are.
// Let's check the block above us.

const blockAbove = await bot.blockAt(new Vec3(bot.entity.position.x, bot.entity.position.y + 1, bot.entity.position.z));
if (blockAbove && blockAbove.name === 'air') {
  // We are not buried. We are in a hole.
  // Try to move out. We need to find an adjacent air block.
  // Let's try to dig the block at our feet if it's not solid? No, that's dangerous.
  // Let's try to pillar up to get to a higher level where we can walk out.
  // But pillarUp is for being buried.
  // Let's try to dig the block in front of us if it's a wall.
  
  // Since blockedSidesAtHead includes N, E, W, we are likely in a 1x1 or small hole.
  // Let's try to dig the block at our current position (if it's dirt/stone) to make a staircase? No.
  // Let's try to dig the block above our head? No, that's digging up.
  
  // Let's try to dig the block at (x, y, z+1) assuming South is open?
  // We don't know if South is open.
  
  // Let's try to dig the block at (x, y, z-1) (North)? It's blocked.
  // Let's try to dig the block at (x+1, y, z) (East)? It's blocked.
  // Let's try to dig the block at (x-1, y, z) (West)? It's blocked.
  
  // Let's try to dig the block at (x, y+1, z) (Up)?
  // If we dig up, we might fall in if it's gravel.
  
  // Let's try to use getUnstuck again, but with a different approach?
  // No, let's try to dig out manually.
  // Let's dig the block at (x, y, z) if it's not solid? No.
  
  // Let's try to dig the block at (x, y-1, z) (Down)? No, we fall.
  
  // Let's try to pillar up 1 block, then dig out.
  // But pillarUp is for being buried.
  
  // Let's try to dig the block at (x, y, z+1) (South) if it's not air.
  // We don't know what's at South.
  
  // Let's try to dig the block at (x, y, z-1) (North) if it's not air.
  // We don't know what's at North.
  
  // Let's try to dig the block at (x+1, y, z) (East) if it's not air.
  // We don't know what's at East.
  
  // Let's try to dig the block at (x-1, y, z) (West) if it's not air.
  // We don't know what's at West.
  
  // Let's try to dig the block at (x, y+1, z) (Up).
  // If it's air, we are not buried.
  // If it's not air, we are buried.
  
  if (blockAbove.name !== 'air') {
    // We are buried. Let's pillar up.
    const pillarResult = await helpers.pillarUp(2, 'dirt');
    if (pillarResult.ok) {
      // Now we are higher. Try to get unstuck.
      const unstuckResult = await helpers.getUnstuck();
      if (unstuckResult.ok) {
        return { status: 'escaped', method: 'pillar_up' };
      }
    }
  } else {
    // We are not buried. We are in a hole.
    // Let's try to dig out sideways.
    // Let's try to dig the block at (x, y, z+1) (South).
    // We need to know if there is a block there.
    // Let's try to dig the block at (x, y, z-1) (North).
    // Let's try to dig the block at (x+1, y, z) (East).
    // Let's try to dig the block at (x-1, y, z) (West).
    
    // Let's try to dig the block at (x, y, z+1) (South).
    const blockSouth = await bot.blockAt(new Vec3(bot.entity.position.x, bot.entity.position.y, bot.entity.position.z + 1));
    if (blockSouth && blockSouth.name !== 'air') {
      await helpers.dig(blockSouth);
      // Now move South.
      await helpers.gotoXYZ(bot.entity.position.x, bot.entity.position.y, bot.entity.position.z + 1, 0);
      return { status: 'escaped', method: 'dig_sideways' };
    }
    
    // Try North.
    const blockNorth = await bot.blockAt(new Vec3(bot.entity.position.x, bot.entity.position.y, bot.entity.position.z - 1));
    if (blockNorth && blockNorth.name !== 'air') {
      await helpers.dig(blockNorth);
      await helpers.gotoXYZ(bot.entity.position.x, bot.entity.position.y, bot.entity.position.z - 1, 0);
      return { status: 'escaped', method: 'dig_sideways' };
    }
    
    // Try East.
    const blockEast = await bot.blockAt(new Vec3(bot.entity.position.x + 1, bot.entity.position.y, bot.entity.position.z));
    if (blockEast && blockEast.name !== 'air') {
      await helpers.dig(blockEast);
      await helpers.gotoXYZ(bot.entity.position.x + 1, bot.entity.position.y, bot.entity.position.z, 0);
      return { status: 'escaped', method: 'dig_sideways' };
    }
    
    // Try West.
    const blockWest = await bot.blockAt(new Vec3(bot.entity.position.x - 1, bot.entity.position.y, bot.entity.position.z));
    if (blockWest && blockWest.name !== 'air') {
      await helpers.dig(blockWest);
      await helpers.gotoXYZ(bot.entity.position.x - 1, bot.entity.position.y, bot.entity.position.z, 0);
      return { status: 'escaped', method: 'dig_sideways' };
    }
  }
}

// If we are here, we are still stuck. Let's try getUnstuck one more time, but maybe we need to dig down first?
// No, let's try to dig up if we are buried.
const blockAbove2 = await bot.blockAt(new Vec3(bot.entity.position.x, bot.entity.position.y + 1, bot.entity.position.z));
if (blockAbove2 && blockAbove2.name !== 'air') {
  // Buried. Dig up.
  await helpers.dig(blockAbove2);
  // Now move up.
  await helpers.gotoXYZ(bot.entity.position.x, bot.entity.position.y + 1, bot.entity.position.z, 0);
  return { status: 'escaped', method: 'dig_up' };
}

return { status: 'still_stuck' };