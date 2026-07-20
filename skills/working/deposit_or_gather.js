// 1. Check inventory for deposit targets
const needCobble = helpers.invCount('cobblestone') < 5;
const needCoal = helpers.invCount('coal') < 2;

if (!needCobble && !needCoal) {
  // Already have enough to deposit. Just ensure we deposit everything.
  try {
    const res = await helpers.depositToChest([
      { name: 'cobblestone' },
      { name: 'coal' }
    ]);
    if (res.ok) return { status: 'deposited', cobblestone: helpers.invCount('cobblestone'), coal: helpers.invCount('coal') };
  } catch (e) { log('Deposit error: ' + e.message); }
  // If deposit fails, fallback to gathering logs as per original contract
}

// 2. Gather missing items or fallback to logs
if (needCobble) {
  const stoneRes = await helpers.acquireStone(5);
  if (stoneRes.ok && stoneRes.status === 'got') {
    // Continue to deposit
  } else if (stoneRes.status === 'all_buried' || stoneRes.status === 'no_stone_here') {
    // Dig down to find stone
    const digRes = await helpers.digStaircaseDown(8);
    if (digRes.ok && digRes.hitStone) {
      await helpers.collectBlock('stone', 5, 6);
    } else {
      log('Failed to find stone');
    }
  } else if (stoneRes.status === 'need_tool') {
    // Craft wooden pickaxe if needed
    await helpers.craftItem('wooden_pickaxe');
    await helpers.acquireStone(5);
  } else {
    log('Stone acquisition failed');
  }
}

if (needCoal) {
  // Coal is usually found with stone or mined directly. 
  // If we don't have coal, we might need to explore or mine coal ore.
  // For simplicity, if we can't get coal, we fallback to logs.
  const coalRes = await helpers.collectBlock('coal', 2, 10);
  if (!coalRes.ok) {
    log('Coal not found, switching to logs');
    needCobble = false; // Force fallback
  }
}

// 3. Deposit if we have items now
if (needCobble === false && needCoal === false) {
  try {
    const res = await helpers.depositToChest([
      { name: 'cobblestone' },
      { name: 'coal' }
    ]);
    if (res.ok) return { status: 'deposited', cobblestone: helpers.invCount('cobblestone'), coal: helpers.invCount('coal') };
  } catch (e) { log('Final deposit error: ' + e.message); }
}

// 4. Fallback: Gather logs
const gather = await helpers.collectAnyLog(5);
return { status: 'gathered_logs', count: gather.collected || 0 };