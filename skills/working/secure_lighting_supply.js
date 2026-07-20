const chestPos = new Vec3(-117, 66, -91);
await helpers.gotoXYZ(-117, 67, -91, 1);

// Check inventory first
if (helpers.invCount('torch') > 0) {
  return { status: 'success', torches: helpers.invCount('torch'), source: 'inventory' };
}

// Craft torches
const sticks = helpers.invCount('stick');
const charcoal = helpers.invCount('charcoal');
if (sticks >= 1 && charcoal >= 1) {
  const result = await helpers.craftItem('torch', 4);
  if (result.ok) {
    log(`Crafted ${result.count} torches.`);
    return { status: 'success', torches: result.count, source: 'crafted' };
  }
  log(`Crafting failed: ${result.reason}`);
  return { status: 'fail', reason: result.reason };
} else {
  log(`Missing materials: sticks=${sticks}, charcoal=${charcoal}`);
  return { status: 'fail', reason: 'missing materials' };
}