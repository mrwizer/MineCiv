log("Equipping stone pickaxe and mining cobblestone.");
await helpers.equipItem('stone_pickaxe');
let collected = 0;
const needed = 20 - helpers.invCount('cobblestone');
if (needed <= 0) return { status: 'done', cobblestone: helpers.invCount('cobblestone') };

log(`Need ${needed} more cobblestone.`);
// Try to acquire from exposed stone first
const result = await helpers.acquireStone(needed);
if (result.ok && result.collected > 0) {
  collected += result.collected;
  log(`Acquired ${result.collected} from exposed stone.`);
} else {
  // If no exposed stone, dig down to find it
  log("No exposed stone found. Digging down to find stone layer.");
  const digResult = await helpers.digStaircaseDown(10);
  if (digResult.hitStone) {
    log("Hit stone layer. Mining cobblestone.");
    const mineResult = await helpers.collectBlock('stone', needed, 6);
    if (mineResult.ok && mineResult.collected > 0) {
      collected += mineResult.collected;
      log(`Mined ${mineResult.collected} cobblestone.`);
    }
  } else {
    log("Failed to find stone layer. Checking inventory.");
  }
}

const totalCobble = helpers.invCount('cobblestone');
log(`Total cobblestone: ${totalCobble}`);
return { status: totalCobble >= 20 ? 'success' : 'partial', cobblestone: totalCobble, collected: collected };