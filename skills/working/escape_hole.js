const mob = helpers.mobility();
if (mob.likelyStuckInHole || mob.dropStraightDown > 1) {
  log("Stuck or falling, escaping.");
  const res = await helpers.getUnstuck();
  return { escaped: res.ok, y: bot.entity.position.y };
}

const targetY = 67;
const currentY = bot.entity.position.y;

if (currentY <= targetY) {
  log("Already at or below target Y=" + targetY);
  return { escaped: true, y: currentY };
}

// Descend safely using staircase logic via getUnstuck/digStaircaseDown
// Since we are above target, we need to go down.
// getUnstuck is good for getting out of holes, but if we are just high up,
// we might need to dig down. However, digStaircaseDown is for finding stone.
// The safest generic way to descend to a specific Y without digging a shaft is
// to use getUnstuck if we are in a hole, or digStaircaseDown if we need to go down
// to reach a layer. But here we just want to reach Y=67.
// If we are at 68, we can just dig down if safe? No, digging under feet is bad.
// We should dig a block in front and step down.
// However, the most robust helper for "getting unstuck" or "moving when stuck" is getUnstuck.
// But if we are just standing on surface and want to go down to 67 (which is below surface),
// we need to dig down.
// Let's use digStaircaseDown to go down. It digs a staircase.
// But digStaircaseDown stops when it hits stone. If 67 is stone, it might stop there.
// If 67 is air, it will keep going.
// Let's try to dig down to targetY.
// We can use digStaircaseDown with a depth that ensures we reach targetY.
// CurrentY - targetY is the depth needed.
const depthNeeded = currentY - targetY;

// Dig a staircase down. Max depth should be at least depthNeeded.
// digStaircaseDown digs through dirt/grass. If it hits stone, it stops.
// If 67 is stone, it will stop at stone. If 67 is air, it will dig deeper.
// We want to reach Y=67. So we dig depthNeeded.
const digRes = await helpers.digStaircaseDown(depthNeeded + 2);
if (digRes.ok) {
  log("Dug staircase down.");
  // Check if we reached target
  if (bot.entity.position.y <= targetY) {
    return { escaped: true, y: bot.entity.position.y };
  }
}

// If digStaircaseDown failed or didn't reach target, try getUnstuck
// getUnstuck might help if we are stuck in a hole or need to navigate out.
const res = await helpers.getUnstuck();
return { escaped: res.ok, y: bot.entity.position.y };