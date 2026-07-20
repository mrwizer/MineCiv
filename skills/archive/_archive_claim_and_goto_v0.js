// 1. Claim the slot
await bot.chat("/claim slot @(-117, 68, -91) Stone Storage");
log("Claimed Stone Storage slot.");

// 2. Move to location
await helpers.gotoXYZ(-117, 68, -91, 2);
log("Moved to Stone Storage location.");

return { claimed: "Stone Storage", position: [-117, 68, -91] };