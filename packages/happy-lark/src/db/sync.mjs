import { ensureDatabaseReady, sequelize } from "./sequelize.mjs";

async function main() {
  await ensureDatabaseReady();
  console.log("Sequelize schema sync completed.");
}

main()
  .catch((error) => {
    console.error("Sequelize schema sync failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
