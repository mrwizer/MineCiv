await log("Swimming to shore...");
// Current position is underwater. Need to get to land.
// Target is (-117, 68, -91). Current is (-68, 62, -42).
// Direction is roughly West and South.
// Find nearest land block to swim to first.
const landBlocks = helpers.findBlocks('stone', 100, 20);
const dirtBlocks = helpers.findBlocks('dirt', 100, 20);
const grassBlocks = helpers.findBlocks('grass_block', 100, 20);
const sandBlocks = helpers.findBlocks('sand', 100, 20);

let nearestLand = null;
let minDist = Infinity;

const candidates = [...landBlocks, ...dirtBlocks, ...grassBlocks, ...sandBlocks];
for (const block of candidates) {
  const dist = block.distanceTo(bot.entity.position);
  if (dist < minDist) {
    minDist = dist;
    nearestLand = block;
  }
}

if (nearestLand) {
  await helpers.gotoXYZ(nearestLand.x, nearestLand.y, nearestLand.z, 2);
  await log("Reached land. Navigating to Stone Storage...");
} else {
  // If no land found nearby, just swim towards the target Y level and then X/Z
  await helpers.gotoXYZ(-117, 68, -91, 5);
}

await log("Navigating to Stone Storage at (-117, 68, -91)");
await helpers.gotoXYZ(-117, 68, -91, 2);

// Verify we are on land and have cobblestone
const hasCobble = helpers.invCount('cobblestone') > 0;
await log(`Arrived. Cobblestone count: ${helpers.invCount('cobblestone')}`);

return {
  status: 'completed',
  position: bot.entity.position,
  cobblestone: helpers.invCount('cobblestone'),
  hasCobble: hasCobble
};