// 1. Navigate to the water source area
await helpers.gotoXYZ(-84, 64, -80, 2);

// 2. Find water and tilled farmland blocks nearby
const waterBlocks = helpers.findBlocks('water', 10, 5);
const farmlandBlocks = helpers.findBlocks('farmland', 10, 5);

if (waterBlocks.length === 0) {
  return { error: 'Water source not found nearby' };
}

// 3. Identify farmland blocks adjacent to water
const adjacentFarmland = farmlandBlocks.filter(farm => {
  return waterBlocks.some(water => {
    const dx = Math.abs(farm.x - water.x);
    const dy = Math.abs(farm.y - water.y);
    const dz = Math.abs(farm.z - water.z);
    return dx <= 1 && dy <= 1 && dz <= 1 && (dx + dy + dz) > 0;
  });
});

if (adjacentFarmland.length === 0) {
  // If no farmland exists, we need to till it first.
  // Find dirt/grass adjacent to water
  const dirtBlocks = helpers.findBlocks('dirt', 10, 5);
  const grassBlocks = helpers.findBlocks('grass_block', 10, 5);
  const targets = [...dirtBlocks, ...grassBlocks];
  
  const adjacentDirt = targets.filter(block => {
    return waterBlocks.some(water => {
      const dx = Math.abs(block.x - water.x);
      const dy = Math.abs(block.y - water.y);
      const dz = Math.abs(block.z - water.z);
      return dx <= 1 && dy <= 1 && dz <= 1 && (dx + dy + dz) > 0;
    });
  });

  if (adjacentDirt.length === 0) {
    return { error: 'No suitable blocks found to till or plant on' };
  }

  // Equip hoe and till
  await helpers.equipItem('wooden_hoe');
  for (const target of adjacentDirt) {
    await helpers.till(target);
  }
}

// 4. Equip wheat seeds
await helpers.equipItem('wheat_seeds');

// 5. Plant seeds on the identified farmland
const plantTargets = adjacentFarmland.length > 0 ? adjacentFarmland : 
                     helpers.findBlocks('farmland', 10, 5).filter(f => {
                       return waterBlocks.some(w => {
                         const dx = Math.abs(f.x - w.x);
                         const dy = Math.abs(f.y - w.y);
                         const dz = Math.abs(f.z - w.z);
                         return dx <= 1 && dy <= 1 && dz <= 1 && (dx + dy + dz) > 0;
                       });
                     });

for (const pos of plantTargets) {
  await helpers.plant('wheat_seeds', pos);
}

return { status: 'planted', targets: plantTargets.length };