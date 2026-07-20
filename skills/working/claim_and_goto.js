// 1. Validate target coordinates
const tx = -117, ty = 68, tz = -91;
if (!bot.entity.position) return { error: "no position" };

// 2. Claim the slot (chat command is stateless/authoritative for the plan)
await bot.chat(`/claim slot @(${tx},${ty},${tz}) Stone Storage`);
log("Claimed Stone Storage slot.");

// 3. Move to location robustly
// Use gotoXYZ with a small tolerance (2 blocks) to handle minor pathfinding drift
const res = await helpers.gotoXYZ(tx, ty, tz, 2);
if (!res || !res.arrived) {
    log("Failed to move to Stone Storage location, attempting unstuck...");
    await helpers.getUnstuck();
    // Retry one last time with tighter tolerance if still stuck
    await helpers.gotoXYZ(tx, ty, tz, 1);
}

log("Moved to Stone Storage location.");

// 4. Verify final position to ensure we are actually there
const current = bot.entity.position;
if (Math.abs(current.x - tx) > 2 || Math.abs(current.y - ty) > 2 || Math.abs(current.z - tz) > 2) {
    return { error: "position mismatch after move", claimed: "Stone Storage", position: [-117, 68, -91] };
}

return { claimed: "Stone Storage", position: [-117, 68, -91] };