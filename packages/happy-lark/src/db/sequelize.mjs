import { DataTypes, Sequelize } from "sequelize";
import defineAuthCacheModel from "../modles/AuthCacheModel.mjs";
import defineMessageDedupeModel from "../modles/MessageDedupeModel.mjs";

const sequelize = new Sequelize(process.env.DATABASE_URL);

const AuthCacheModel = defineAuthCacheModel(sequelize, DataTypes);
const MessageDedupeModel = defineMessageDedupeModel(sequelize, DataTypes);

let initPromise = null;

export async function ensureDatabaseReady() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for Sequelize");
  }
  if (!initPromise) {
    initPromise = (async () => {
      await sequelize.authenticate();
      await sequelize.sync();
    })();
  }
  return initPromise;
}

export { sequelize, AuthCacheModel, MessageDedupeModel };
