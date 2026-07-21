if (helpers.mobility().surroundedAtFeet >= 3 || helpers.mobility().likelyStuckInHole) {
  await helpers.getUnstuck();
}

const needCobble = helpers.invCount('cobblestone') < 5;
const needCoal = helpers.invCount('coal') < 2;

if (!needCobble && !needCoal) {
  try {
    const res = await helpers.depositToChest([{ name: 'cobblestone' }, { name: 'coal' }]);
    if (res.ok) return { status: 'deposited', cobblestone: helpers.invCount('cobblestone'), coal: helpers.invCount('coal') };
  } catch (e) { log('Deposit error: ' + e.message); }
}

if (needCobble) {
  const stoneRes = await helpers.acquireStone(5);
  if (stoneRes.ok && stoneRes.status === 'got') {
    // Continue to deposit
  } else if (stoneRes.status === 'all_buried' || stoneRes.status === 'no_stone_here') {
    const digRes = await helpers.digStaircaseDown(8);
    if (digRes.ok && digRes.hitStone) {
      await helpers.collectBlock('stone', 5, 6);
    } else {
      log('Failed to find stone');
    }
  } else if (stoneRes.status === 'need_tool') {
    await helpers.craftItem('wooden_pickaxe');
    await helpers.acquireStone(5);
  } else {
    log('Stone acquisition failed');
  }
}

if (needCoal) {
  const coalRes = await helpers.collectBlock('coal', 2, 10);
  if (!coalRes.ok) {
    log('Coal not found, switching to logs');
  }
}

if (!needCobble && !needCoal) {
  try {
    const res = await helpers.depositToChest([{ name: 'cobblestone' }, { name: 'coal' }]);
    if (res.ok) return { status: 'deposited', cobblestone: helpers.invCount('cobblestone'), coal: helpers.invCount('coal') };
  } catch (e) { log('Final deposit error: ' + e.message); }
}

const gather = await helpers.collectAnyLog(5);
return { status: 'gathered_logs', count: gather.collected || 0 };