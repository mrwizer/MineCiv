log("Finding nearby tree...");
// collectAnyLog handles finding, pathing, and mining the nearest log
const result = await helpers.collectAnyLog(5);

if (result && result.ok && result.collected >= 5) {
  log("Successfully collected 5 logs.");
  return { collected: 'wood_log', count: 5 };
} else {
  // If collectAnyLog failed (e.g., no trees nearby), try exploring
  log("No logs nearby, exploring...");
  await helpers.exploreFor('_log');
  const result2 = await helpers.collectAnyLog(5);
  if (result2 && result2.ok && result2.collected >= 5) {
    return { collected: 'wood_log', count: 5 };
  }
  return { error: 'Could not find or collect 5 wood logs' };
}