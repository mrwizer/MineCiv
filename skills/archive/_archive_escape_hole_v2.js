const mob = await helpers.mobility();
if (mob.likelyStuckInHole || mob.dropStraightDown > 1) {
  log("Stuck or falling, escaping.");
  const res = await helpers.getUnstuck();
  return { escaped: res.ok, y: bot.entity.position.y };
}

// Goal: Descend to target Y safely.
// We check if we are already there.
const targetY = 67; // Based on previous context, but let's make it robust.
// Actually, the prompt says "descend to Y=67" in the skill description,
// but the specific task instance said Y=71 -> 70.
// The skill name is "escape_hole". The prompt says "Mines the block below to descend to Y=67".
// I will stick to the skill's defined purpose: descend to Y=67.

if (bot.entity.position.y <= targetY) {
  log("Already at or below target Y=" + targetY);
  return { escaped: true, y: bot.entity.position.y };
}

// We are above target Y. We need to go down.
// SAFETY: Do not dig straight down. Use staircase or getUnstuck if stuck.
// Since we are likely on surface or in a shallow hole, we should dig a staircase down
// or use getUnstuck if we are trapped.

// Check if we are just 1 block above target and have a safe drop?
// No, safe descent requires a path.
// Let's try to dig a staircase down if we are near the target.
// If we are far above, we might need to explore or dig deeper.
// However, "escape_hole" implies we are in a hole and want to get to the "safe" level (Y=67).
// If we are at 68, we are very close.
// If we are at 100, we are far.
// The prompt says "Current pos y=68" in the failure log example.
// I will assume the bot is close to the target Y or in a hole near it.

// If we are at 68, we can try to dig down one block if it's safe?
// No, digging under feet is dangerous.
// We should dig a block in front of us and step down.

const currentY = bot.entity.position.y;
const stepsDown = currentY - targetY;

if (stepsDown <= 4) {
  // Close enough to dig a small staircase or use getUnstuck if stuck
  // Let's try to move down using getUnstuck if it detects we are in a hole.
  // Or we can manually dig a staircase.
  // But getUnstuck is safer for "escaping" a hole.
  // If we are at 68, we are NOT in a hole (assuming surface is 67).
  // We are just 1 block high.
  // We can just move down if there is no block below?
  // No, if there is a block below at 67, we can't move down.
  // We need to dig the block at 67? No, that's below us.
  // If we are at 68, and block at 67 is solid, we are standing on 68.
  // To get to 67, we need to dig 68? No, that makes us fall to 67.
  // But falling is risky.
  // Better: Dig a block at 68 (our feet) to fall to 67?
  // If 67 is air, we fall to 67. If 67 is solid, we fall to 66.
  // This is dangerous.

  // Let's use getUnstuck. It handles stairs, digging out, etc.
  const res = await helpers.getUnstuck();
  return { escaped: res.ok, y: bot.entity.position.y };
}

// If we are far above, we should dig a staircase down.
// But getUnstuck also handles digging down if needed?
// getUnstuck is for escaping bad spots.
// If we are just high up, we can dig down.
// Let's use digStaircaseDown.
const digRes = await helpers.digStaircaseDown(stepsDown + 2); // Dig a bit more to be safe
if (digRes.ok) {
  log("Digged staircase down.");
  // Check if we reached target
  if (bot.entity.position.y <= targetY) {
    return { escaped: true, y: bot.entity.position.y };
  }
}

// If digStaircaseDown failed or didn't reach target, try getUnstuck
const res = await helpers.getUnstuck();
return { escaped: res.ok, y: bot.entity.position.y };