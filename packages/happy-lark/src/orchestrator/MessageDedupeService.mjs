import { UniqueConstraintError } from "sequelize";
import { MessageDedupeModel, ensureDatabaseReady } from "../db/sequelize.mjs";

export class MessageDedupeService {
  async tryInsert(messageId) {
    try {
      await ensureDatabaseReady();
      await MessageDedupeModel.create({ messageId });
      return true;
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        console.warn(`Duplicate messageId received: ${messageId}`);
        return false;
      }
      throw error;
    }
  }
}
